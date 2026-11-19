// `lattice audience review` — persona review orchestration in the engine
// (design §7, evolved by the v1.1 wrap-up): the deterministic surfaces stay
// in the engine (prompt assembly from the versioned persona catalog + the
// pack, the strict schema gate with malformed retries ≤ 2, session
// bookkeeping); the MODEL CALL shells out to `opencode run` (free supply,
// same path the first rehearsal proved), with the model id recorded in the
// session artifact. Improvement EXECUTION is deliberately NOT a CLI command
// (`audience run` does not exist): acting on findings is agent work through
// the existing edit loop — the improver's machine-readable input contract is
// the action-items artifact `audience session check` emits.

import fsSync from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { getPersona } from "./personas.js";
import { validateAudienceReview } from "./review-schema.js";
import { computePackHash, packDirPath } from "./pack.js";
import { latestSessionPath, readSession } from "./session.js";

export const DEFAULT_REVIEW_MODEL = process.env.LATTICE_REVIEW_MODEL;
export const MAX_REVIEW_RETRIES = 2;

const OUTPUT_CONTRACT = `OUTPUT CONTRACT — answer with ONE JSON object and nothing else (no prose, no code fences):
{
  "schema": "lattice.audience-review.v1",
  "persona": "<your persona id>",
  "packHash": "<the packHash given below>",
  "model": "<the model id given below>",
  "findings": [
    {
      "id": "F<n>",
      "frameAddress": { "slideId": "<slide id>", "localFrame": <integer frame >= 0> },
      "dimension": "pacing|clarity|accuracy|structure|audio|visual",
      "severity": "high|medium|low",
      "evidence": "<quote the concrete signal: transcript line, metric number, structure count>",
      "comment": "<what is wrong and why the audience notices>",
      "operation": "content-edit|timeline-edit|structure-edit|PRD-draft"
    }
  ],
  "verdicts": [ { "findingId": "<previous finding id>", "resolved": true|false } ],
  "scores": { "accuracy": <0-5>, "clarity": <0-5>, "pacing": <0-5>, "structure": <0-5>, "audio": <0-5> }
}
Rules: findings require real evidence from the pack — never invent signals.
frameAddress is optional but strongly preferred (use structure.json frames).
verdicts: only when re-reviewing previous findings (one vote each).
scores: all five dimensions, advisory 1-5.`;

/**
 * Assemble one persona's review prompt. Pure: the same persona + pack files
 * + previous findings + model always yield the same prompt bytes (the
 * determinism the review-loop tests pin).
 */
export function assembleReviewPrompt({ persona, pack, round, previousFindings = [], model }) {
  const parts = [
    persona.promptAnchor,
    "",
    `Scoring rubric: ${JSON.stringify(persona.scoringRubric)}`,
    `Lens: ${persona.lens.join("; ")}`,
    "",
    round === 1
      ? "This is ROUND 1 (first review): honor the adversarial anchor above (at least 3 findings across at least 2 dimensions)."
      : `This is ROUND ${round} (re-review): FIRST vote every previous finding below (resolved = the fresh evidence shows it fixed; persists = otherwise), THEN report only genuinely new findings with evidence.`,
  ];
  if (previousFindings.length > 0) {
    parts.push("", "PREVIOUS FINDINGS (vote each in verdicts):", JSON.stringify(previousFindings, null, 2));
  }
  parts.push(
    "",
    `packHash: ${pack.packHash}`,
    `model: ${model}`,
    "",
    "== experience pack: structure.json (timeline, stops, notes register) ==",
    pack.structure,
    "",
    "== experience pack: metrics.json (lint, WPM, dwell, ducking, density) ==",
    pack.metrics,
    "",
    "== experience pack: transcript.md (whisper heard vs notes source, word diff) ==",
    pack.transcript,
    "",
  );
  if (pack.vision) {
    // v1.2 VL layer, V2.0.31 critique increment: what you SEE at each stop
    // still (pinned nemotron VL descriptions) AND what is visually wrong in
    // it (the canvas-design-dimension critique). frameAddress anchoring is
    // unchanged — visual findings still address structure.json frames.
    parts.push(
      "== experience pack: vision.md — WHAT YOU SEE AND WHAT'S VISUALLY WRONG at each stop still (pinned VL model descriptions + design critique) ==",
      pack.vision,
      "",
      "Pixels are not attached to this prompt: the VL descriptions and design critiques above are your eyes. Judge both what they show and what is visually wrong in it (visual hierarchy, contrast, emphasis placement, balance, whitespace, alignment), quote them as evidence, file such findings with dimension \"visual\", and anchor them with frameAddress (structure.json frames).",
      "",
    );
  } else {
    parts.push(
      "Still images are NOT part of this round (VL layer unavailable); judge only the signals above and say so if you cannot verify something visual.",
      "",
    );
  }
  parts.push(OUTPUT_CONTRACT);
  return parts.join("\n");
}

/** Read the pack files the prompt consumes (transcript, metrics, structure, vision). */
export function readPackForReview({ cwd, deckId, packDir = null }) {
  const dir = packDir ? path.resolve(cwd, packDir) : packDirPath(cwd, deckId);
  const read = (name) => {
    const file = path.join(dir, name);
    if (!fsSync.existsSync(file)) {
      throw Object.assign(new Error(`pack file missing: ${file} — run "lattice audience pack --deck ${deckId}" first`), { code: "pack-missing" });
    }
    return fsSync.readFileSync(file, "utf8");
  };
  const packHash = JSON.parse(read("pack.hash")).packHash;
  // v1.2: vision.md is OPTIONAL (degradation is contractual — packs built
  // before the VL layer, or with the engine off/failed, review without it).
  const visionFile = path.join(dir, "vision.md");
  const vision = fsSync.existsSync(visionFile) ? fsSync.readFileSync(visionFile, "utf8") : null;
  return { packDir: dir, packHash, transcript: read("transcript.md"), metrics: read("metrics.json"), structure: read("structure.json"), vision };
}

/** Previous round's findings this persona votes on (its own review position). */
export function previousFindingsForPersona({ cwd, deckId, personaId, round }) {
  if (round <= 1) return [];
  const sessionPath = latestSessionPath(cwd, deckId);
  if (!sessionPath) return [];
  const session = readSession(sessionPath);
  const rounds = session.rounds ?? [];
  const last = rounds[rounds.length - 1];
  if (!last || last.n !== round - 1) return [];
  // The persona votes on the same position it reviewed last round, matched
  // by the recorded personas order (review command rounds carry it); a CLI
  // `session append` round without the order falls back to matching the
  // review's self-reported persona id.
  let index = (last.personas ?? []).indexOf(personaId);
  if (index === -1) {
    index = (last.reviews ?? []).findIndex((review) => review.persona === personaId);
  }
  if (index === -1) return [];
  return (last.reviews ?? [])[index]?.findings ?? [];
}

/** Extract the outermost JSON object from a model answer (fences tolerated). */
export function extractJsonAnswer(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new Error("no JSON object found in the model answer");
  return JSON.parse(text.slice(start, end + 1));
}

/**
 * Default model runner: `opencode run -m <model> <prompt>` (the free supply
 * the first rehearsal proved). Injectable for tests.
 */
export function defaultModelRunner({ model, prompt, cwd }) {
  const result = spawnSync("opencode", ["run", "-m", model, prompt], {
    cwd,
    encoding: "utf8",
    timeout: 900000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error) throw Object.assign(new Error(`opencode run failed to start: ${result.error.message}`), { code: "model-runner-failed" });
  if (result.status !== 0 && !result.stdout?.trim()) {
    throw Object.assign(new Error(`opencode run exited ${result.status}: ${(result.stderr ?? "").slice(0, 2000)}`), { code: "model-runner-failed" });
  }
  return result.stdout ?? "";
}

function stubModelRunner({ prompt }) {
  // Deterministic test double: echoes a schema-valid review derived from the
  // prompt itself (proves assembly + the gate). LATTICE_AUDIENCE_STUB_MALFORMED
  // = "1" fails the FIRST attempt (retry path); "always" fails every attempt
  // (retry exhaustion path).
  const packHashMatch = prompt.match(/packHash: ([0-9a-f]{64})/);
  const personaId = prompt.includes("curious newcomer") ? "novice" : "expert";
  const malformedMode = process.env.LATTICE_AUDIENCE_STUB_MALFORMED;
  if (malformedMode === "always") return "not json at all";
  if (malformedMode === "1" && !prompt.includes("RETRY-NOTE")) {
    return "not json at all";
  }
  return JSON.stringify({
    schema: "lattice.audience-review.v1",
    persona: personaId,
    packHash: packHashMatch?.[1] ?? "0".repeat(64),
    model: "stub",
    findings: [
      {
        id: "F1",
        frameAddress: { slideId: "intro", localFrame: 0 },
        dimension: "clarity",
        severity: "low",
        evidence: "stub evidence from the assembled prompt",
        comment: "stub finding from the deterministic model double",
        operation: "content-edit",
      },
    ],
    verdicts: [],
    scores: { accuracy: 4, clarity: 4, pacing: 4, structure: 4, audio: 4 },
  });
}

export function resolveModelRunner() {
  if (process.env.LATTICE_AUDIENCE_MODEL_ENGINE === "stub") return stubModelRunner;
  return defaultModelRunner;
}

/**
 * Run one persona review: assemble → model → schema gate (malformed retries
 * ≤ 2) → review file. Returns { review, attempts, path }.
 */
export async function runPersonaReview({ cwd, deckId, personaId, round, pack, model, modelRunner = resolveModelRunner(), outPath }) {
  const persona = getPersona(personaId);
  if (!persona) {
    throw Object.assign(new Error(`unknown persona "${personaId}" (built-in: novice, expert)`), { code: "unknown-persona" });
  }
  const previousFindings = previousFindingsForPersona({ cwd, deckId, personaId, round });
  const prompt = assembleReviewPrompt({ persona, pack, round, previousFindings, model });
  await fsp.mkdir(path.dirname(outPath), { recursive: true });

  let lastError = null;
  for (let attempt = 0; attempt <= MAX_REVIEW_RETRIES; attempt += 1) {
    const effectivePrompt = attempt === 0
      ? prompt
      : `${prompt}\n\nRETRY-NOTE: your previous answer was rejected (${lastError?.message ?? "malformed"}). Re-read the OUTPUT CONTRACT and answer with the exact JSON object only.`;
    let review;
    try {
      const answer = await modelRunner({ model, prompt: effectivePrompt, cwd, attempt });
      review = extractJsonAnswer(answer);
      review.model = model;
      review.packHash = review.packHash ?? pack.packHash;
    } catch (error) {
      lastError = error;
      continue;
    }
    const validation = validateAudienceReview(review);
    if (!validation.ok) {
      lastError = new Error(`schema validation failed: ${validation.errors.map((error) => `${error.path}: ${error.message}`).join("; ")}`);
      continue;
    }
    await fsp.writeFile(outPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
    return { review, attempts: attempt + 1, path: outPath };
  }
  throw Object.assign(
    new Error(`persona "${personaId}" did not produce a schema-valid review after ${MAX_REVIEW_RETRIES + 1} attempts: ${lastError?.message ?? "unknown error"}`),
    { code: "review-invalid" },
  );
}

/** Reviews directory: .lattice/audience-reviews/<deck>/. */
export function reviewsDirPath(cwd, deckId) {
  return path.resolve(cwd, ".lattice", "audience-reviews", deckId);
}

/** Recompute/build the pack (cache hit skips the rebuild); returns its identity. */
export async function ensureFreshPack({ cwd, deckId, skipLint = false, stillsMode = "full" }) {
  const { buildAudiencePack } = await import("./pack.js");
  const payload = await buildAudiencePack({ cwd, deckId, skipLint, stillsMode });
  return { payload, packDir: payload.packDir, packHash: payload.packHash };
}

/**
 * Orchestrate one review round for the requested personas: pack (cache hit
 * skips) → per-persona model review → schema gate → session append. Returns
 * the machine-readable payload; the command wrapper emits it.
 */
export async function runAudienceReview({ cwd, deckId, personas = ["novice", "expert"], round = null, packDir = null, model = DEFAULT_REVIEW_MODEL, modelRunner = resolveModelRunner(), skipLint = false, stillsMode = "full" }) {
  const unknown = personas.filter((id) => !getPersona(id));
  if (unknown.length > 0) {
    throw Object.assign(new Error(`unknown persona(s): ${unknown.join(", ")} (built-in: novice, expert)`), { code: "unknown-persona" });
  }
  // 1. pack: an explicit --pack-dir is consumed as-is; otherwise the pack
  //    step runs with its cache semantics (unchanged deck → skip rebuild).
  let pack;
  let packWasCached = null;
  if (packDir) {
    pack = readPackForReview({ cwd, deckId, packDir });
  } else {
    const fresh = await ensureFreshPack({ cwd, deckId, skipLint, stillsMode });
    pack = readPackForReview({ cwd, deckId, packDir: fresh.packDir });
    packWasCached = fresh.payload.cached;
  }

  // 2. round number: explicit or the session's next.
  const { nextRoundNumber, sessionPath, session } = await resolveReviewRound({ cwd, deckId, requested: round });

  // 3. per-persona reviews with the schema gate.
  const reviews = [];
  for (const personaId of personas) {
    const outPath = path.join(reviewsDirPath(cwd, deckId), `round-${String(nextRoundNumber).padStart(3, "0")}-${personaId}.json`);
    const result = await runPersonaReview({ cwd, deckId, personaId, round: nextRoundNumber, pack, model, modelRunner, outPath });
    reviews.push({ personaId, ...result });
  }

  // 4. session append (library level — the command never shells to itself).
  const roundEntry = {
    n: nextRoundNumber,
    personas,
    packHash: pack.packHash,
    reviews: reviews.map((entry) => entry.review),
    improvements: [],
    verdicts: reviews.flatMap((entry) => entry.review.verdicts ?? []),
  };
  session.rounds.push(roundEntry);
  if (!session.packHashes.includes(pack.packHash)) session.packHashes.push(pack.packHash);
  await fsp.writeFile(sessionPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");

  return {
    action: "review",
    deck: deckId,
    round: nextRoundNumber,
    model,
    packHash: pack.packHash,
    packCached: packWasCached,
    session: path.relative(cwd, sessionPath).split(path.sep).join("/"),
    reviews: reviews.map((entry) => ({
      persona: entry.personaId,
      path: path.relative(cwd, entry.path).split(path.sep).join("/"),
      attempts: entry.attempts,
      findings: (entry.review.findings ?? []).length,
      verdicts: (entry.review.verdicts ?? []).length,
      scores: entry.review.scores ?? null,
    })),
  };
}

async function resolveReviewRound({ cwd, deckId, requested }) {
  const sessionPath = latestSessionPath(cwd, deckId);
  if (!sessionPath) {
    // Auto-init the first session for this deck.
    const { writeSession } = await import("./session.js");
    const created = writeSession(cwd, deckId, {
      schema: "lattice.audience-session.v1",
      deck: deckId,
      packHashes: [],
      rounds: [],
      conclusion: null,
    });
    return { nextRoundNumber: 1, sessionPath: created, session: readSession(created) };
  }
  const session = readSession(sessionPath);
  const nextRoundNumber = requested ?? (session.rounds.length + 1);
  if (session.rounds.some((round) => round.n === nextRoundNumber)) {
    throw Object.assign(new Error(`round ${nextRoundNumber} is already recorded in ${sessionPath}; pass --round <n> for the next round`), { code: "round-exists" });
  }
  return { nextRoundNumber, sessionPath, session };
}
