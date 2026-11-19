// lattice audience — AI audience v1.1 engine primitives (design §7).
//
// Small, deterministic, JSON-out:
//   pack     — build the experience pack (stills + whisper transcript +
//              metrics + structure) with pack.hash cache semantics
//   session  — lattice.audience-session.v1 artifact init/append/check with
//              the pure convergence state machine
//   personas — the versioned built-in persona catalog
//   verify   — strict lattice.audience-review.v1 validation of one persona
//              review JSON (the gate the agent-layer review runner retries
//              against, malformed retries ≤ 2)
//
// Persona model calls are NOT in the engine (design §7): they happen at the
// agent layer via `opencode run`; the engine only validates and aggregates.

import fsSync from "node:fs";
import path from "node:path";
import { audiencePackCommand, packDirPath } from "../audience/pack.js";
import { personaCatalog, isKnownPersona } from "../audience/personas.js";
import { REVIEW_SCHEMA, validateAudienceReview } from "../audience/review-schema.js";
import { DEFAULT_REVIEW_MODEL, runAudienceReview } from "../audience/review.js";
import {
  SESSION_SCHEMA,
  evaluateConvergence,
  findingsOfRound,
  latestSessionPath,
  nextSessionPath,
  readSession,
  residualFindings,
  roundImprovement,
  verdictsOfRound,
  writeSession,
} from "../audience/session.js";
import { sha256Hex } from "../edit/provenance.js";

function fail(payload, exitCode = 1) {
  process.stderr.write(`${JSON.stringify({ ok: false, command: "audience", ...payload }, null, 2)}\n`);
  process.exit(exitCode);
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify({ ok: true, command: "audience", ...payload }, null, 2)}\n`);
}

const AUDIENCE_USAGE = `Usage:
  lattice audience pack --deck <id> [--out <dir>] [--bundle-dir <dir>] [--skip-lint] [--stills none|full]
  lattice audience review --deck <id> [--personas novice,expert] [--model <m>] [--round <n>]
                          [--pack-dir <dir>] [--skip-lint] [--stills none|full]
  lattice audience session --deck <id> init [--pack-hash <hex>]
  lattice audience session --deck <id> append --round <n> --review <file> [--review <file>...]
                            [--improvements <json-file>] [--conclusion <json-file>] [--pack-hash <hex>]
  lattice audience session --deck <id> check [--session <file>]
  lattice audience personas
  lattice audience verify --review <file>

AI audience v1.1 (docs/ai-audience-design.md). Deterministic, JSON-out:
failures go to stderr as one JSON object, exit codes 0 ok / 1 refused or
not-converged / 2 infrastructure.

"lattice audience pack" builds the experience pack an audience persona
consumes: stills (video still pipeline), a whisper transcript of
narration.wav diffed against the notes source, one VL description per stop
still (v1.2 — what a viewer SEES, pinned nemotron VL; a VL outage degrades:
the pack records it in vision.md and never blocks), deterministic metrics
(lint, WPM, dwell variance, ducking, density), the structural map, and
pack.hash — the hash of ALL pack inputs; an unchanged deck skips the rebuild.

"lattice audience review" productizes one review round: pack (cache hit
skips) → per-persona prompt from the versioned catalog + the pack files →
model call (default "opencode run -m ${DEFAULT_REVIEW_MODEL}", --model
overrides; the model id is recorded in the session artifact) → strict
schema gate with malformed retries ≤ 2 → session append. Acting on the
findings is deliberately NOT a CLI command (no "audience run"): improvement
execution is agent work through the edit loop, driven by the action-items
artifact that "session check" emits.

"lattice audience session" manages .lattice/audience-sessions/<deck>/:
init opens a session, append records one round (persona reviews validated
against ${REVIEW_SCHEMA}, improvement refs, verdicts), check runs the pure
convergence state machine (converged | plateau | escalated | ongoing →
exit 0 when the loop may exit, 1 while it must continue) and emits the
action-items artifact (lattice.audience-action-items.v1: every unresolved
finding as { findingId, operation, target, evidence, status: "open" }).

"lattice audience personas" prints the built-in persona catalog
(lattice.audience-personas.v1): novice + expert, each with adversarial
anchors and the scoring rubric. "lattice audience verify" validates one
persona review JSON against the strict schema (exit 0/1).

Environment: LATTICE_ASR_CACHE (default ~/.cache/lattice/whisper),
LATTICE_ASR_ALLOW_DOWNLOAD=1 (one-time whisper provisioning),
LATTICE_ASR_ENGINE=stub (deterministic test engine only),
LATTICE_VL_ENGINE=stub|off (stub vision for tests / off disables the VL
layer with an explicit degradation note in vision.md).`;

function readJsonFile(filePath, label) {
  const resolved = path.resolve(filePath);
  if (!fsSync.existsSync(resolved)) {
    fail({ error: { code: "file-not-found", message: `${label} not found: ${resolved}` } }, 1);
  }
  try {
    return JSON.parse(fsSync.readFileSync(resolved, "utf8"));
  } catch (error) {
    fail({ error: { code: "invalid-json", message: `${label} is not valid JSON (${resolved}): ${error.message}` } }, 1);
  }
}

function currentPackHash(cwd, deckId, override) {
  if (override !== undefined) {
    if (typeof override !== "string" || override.trim() === "") {
      fail({ error: { code: "invalid-pack-hash", message: `--pack-hash must be a non-empty hex string, got ${JSON.stringify(override)}` } }, 1);
    }
    return override.trim();
  }
  const hashPath = path.join(packDirPath(cwd, deckId), "pack.hash");
  if (!fsSync.existsSync(hashPath)) return null;
  try {
    const parsed = JSON.parse(fsSync.readFileSync(hashPath, "utf8"));
    return typeof parsed.packHash === "string" ? parsed.packHash : null;
  } catch {
    return null;
  }
}

export async function audienceCommand({ args, rest }) {
  const cwd = process.cwd();
  const [subcommand] = rest;
  if (!subcommand || subcommand === "--help" || subcommand === "help") {
    console.log(AUDIENCE_USAGE);
    return;
  }
  if (subcommand === "pack") {
    await audiencePackCommand({ args });
    return;
  }
  if (subcommand === "personas") {
    process.stdout.write(`${JSON.stringify(personaCatalog(), null, 2)}\n`);
    return;
  }
  if (subcommand === "verify") {
    if (typeof args.review !== "string") {
      fail({ error: { code: "missing-argument", message: "verify requires --review <file>" } }, 2);
    }
    const review = readJsonFile(args.review, "review");
    const result = validateAudienceReview(review);
    emit({
      action: "verify",
      review: path.resolve(args.review).split(path.sep).join("/"),
      schema: REVIEW_SCHEMA,
      personaKnown: isKnownPersona(review?.persona),
      ...result,
    });
    if (!result.ok) process.exit(1);
    return;
  }
  if (subcommand === "review") {
    if (typeof args.deck !== "string" || args.deck === "") {
      fail({ error: { code: "missing-argument", message: "--deck <id> is required" } }, 2);
    }
    const personas = typeof args.personas === "string" && args.personas.trim() !== ""
      ? args.personas.split(",").map((id) => id.trim()).filter(Boolean)
      : ["novice", "expert"];
    try {
      const payload = await runAudienceReview({
        cwd,
        deckId: args.deck,
        personas,
        round: args.round !== undefined ? Number(args.round) : null,
        packDir: typeof args["pack-dir"] === "string" ? args["pack-dir"] : null,
        model: typeof args.model === "string" && args.model !== "" ? args.model : DEFAULT_REVIEW_MODEL,
        skipLint: args["skip-lint"] === true,
        stillsMode: args.stills === "none" ? "none" : "full",
      });
      emit(payload);
    } catch (error) {
      const code = ["unknown-persona", "round-exists", "pack-missing", "review-invalid"].includes(error?.code) ? 1 : 2;
      fail({ error: { code: error?.code ?? "review-failed", message: error.message } }, code);
    }
    return;
  }
  if (subcommand === "session") {
    await audienceSessionCommand({ args, rest: rest.slice(1) });
    return;
  }
  console.error(`[lattice] unknown audience subcommand: ${subcommand}`);
  process.exit(1);
}

async function audienceSessionCommand({ args, rest }) {
  const cwd = process.cwd();
  const deckId = args.deck;
  if (typeof deckId !== "string" || deckId === "") {
    fail({ error: { code: "missing-argument", message: "--deck <id> is required" } }, 2);
  }
  const [action] = rest;

  if (action === "init") {
    const sessionPath = nextSessionPath(cwd, deckId);
    const session = {
      schema: SESSION_SCHEMA,
      deck: deckId,
      packHashes: [currentPackHash(cwd, deckId, args["pack-hash"])].filter((value) => value !== null),
      rounds: [],
      conclusion: null,
    };
    fsSync.mkdirSync(path.dirname(sessionPath), { recursive: true });
    fsSync.writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
    emit({
      action: "session-init",
      deck: deckId,
      session: path.relative(cwd, sessionPath).split(path.sep).join("/"),
      packHashes: session.packHashes,
    });
    return;
  }

  if (action === "append") {
    const sessionPath = latestSessionPath(cwd, deckId) ?? (args.session ? path.resolve(cwd, args.session) : null);
    if (!sessionPath || !fsSync.existsSync(sessionPath)) {
      fail({ error: { code: "session-not-found", message: `no audience session found for deck "${deckId}"; run "lattice audience session --deck ${deckId} init" first` } }, 1);
    }
    const session = readSession(sessionPath);
    const roundNumber = Number(args.round);
    if (!Number.isInteger(roundNumber) || roundNumber < 1) {
      fail({ error: { code: "invalid-round", message: `append requires --round <positive integer>, got ${JSON.stringify(args.round ?? null)}` } }, 1);
    }
    const existingRound = session.rounds.find((round) => round.n === roundNumber);
    if (existingRound && args.conclusion !== undefined && args.review === undefined) {
      // Conclusion-only append on an already-recorded round: the conclusion is
      // a session-level field the master agent writes once the loop closes.
      const conclusion = readJsonFile(args.conclusion, "conclusion");
      if (!conclusion || typeof conclusion !== "object" || Array.isArray(conclusion)) {
        fail({ error: { code: "invalid-conclusion", message: "--conclusion must point to a JSON object { outcome, residual, actionItems, ... }" } }, 1);
      }
      session.conclusion = conclusion;
      fsSync.writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
      emit({
        action: "session-conclude",
        deck: deckId,
        session: path.relative(cwd, sessionPath).split(path.sep).join("/"),
        conclusion: conclusion.outcome ?? null,
      });
      return;
    }
    if (existingRound) {
      fail({ error: { code: "round-exists", message: `round ${roundNumber} is already recorded in ${sessionPath}` } }, 1);
    }
    const reviewFiles = [].concat(args.review ?? []);
    if (reviewFiles.length === 0) {
      fail({ error: { code: "missing-argument", message: "append requires at least one --review <file>" } }, 2);
    }
    const reviews = [];
    for (const reviewFile of reviewFiles) {
      const review = readJsonFile(reviewFile, "review");
      const validation = validateAudienceReview(review);
      if (!validation.ok) {
        fail({
          error: {
            code: "invalid-review",
            message: `review ${reviewFile} failed ${REVIEW_SCHEMA} validation: ${validation.errors.map((error) => `${error.path}: ${error.message}`).join("; ")}`,
            errors: validation.errors,
          },
        }, 1);
      }
      if (review.packHash !== currentPackHash(cwd, deckId, args["pack-hash"]) && currentPackHash(cwd, deckId, args["pack-hash"]) !== null) {
        fail({
          error: {
            code: "pack-hash-mismatch",
            message: `review ${reviewFile} was produced against packHash ${review.packHash} but the current pack is ${currentPackHash(cwd, deckId, args["pack-hash"])}; rebuild the pack or record the round against the matching session`,
          },
        }, 1);
      }
      reviews.push(review);
    }
    const improvements = args.improvements !== undefined ? readJsonFile(args.improvements, "improvements") : [];
    if (!Array.isArray(improvements)) {
      fail({ error: { code: "invalid-improvements", message: "--improvements must point to a JSON array of { ref, note } entries" } }, 1);
    }
    let conclusion;
    if (args.conclusion !== undefined) {
      conclusion = readJsonFile(args.conclusion, "conclusion");
      if (!conclusion || typeof conclusion !== "object" || Array.isArray(conclusion)) {
        fail({ error: { code: "invalid-conclusion", message: "--conclusion must point to a JSON object { outcome, residual, actionItems, ... }" } }, 1);
      }
    }
    const packHash = currentPackHash(cwd, deckId, args["pack-hash"]);
    const round = {
      n: roundNumber,
      ...(packHash ? { packHash } : {}),
      reviews,
      improvements,
      verdicts: reviews.flatMap((review) => review.verdicts ?? []),
    };
    session.rounds.push(round);
    if (packHash && !session.packHashes.includes(packHash)) session.packHashes.push(packHash);
    if (conclusion) session.conclusion = conclusion;
    fsSync.writeFileSync(sessionPath, `${JSON.stringify(session, null, 2)}\n`, "utf8");
    emit({
      action: "session-append",
      deck: deckId,
      session: path.relative(cwd, sessionPath).split(path.sep).join("/"),
      round: roundNumber,
      reviews: reviews.length,
      findings: findingsOfRound(round).length,
      verdicts: verdictsOfRound(round).length,
      ...(conclusion ? { conclusionRecorded: true } : {}),
    });
    return;
  }

  if (action === "check") {
    const sessionPath = args.session ? path.resolve(cwd, args.session) : latestSessionPath(cwd, deckId);
    if (!sessionPath || !fsSync.existsSync(sessionPath)) {
      fail({ error: { code: "session-not-found", message: `no audience session found for deck "${deckId}"; run "lattice audience session --deck ${deckId} init" first` } }, 1);
    }
    const session = readSession(sessionPath);
    const determination = evaluateConvergence(session.rounds);
    const lastRound = session.rounds[session.rounds.length - 1] ?? null;
    // The improver's machine-readable input contract: every unresolved
    // finding becomes an open action item — no transcript archaeology.
    const actionItems = residualFindings(session.rounds).map((entry) => ({
      findingId: entry.id,
      operation: entry.operation,
      target: entry.frameAddress ?? null,
      evidence: entry.evidence,
      severity: entry.severity,
      dimension: entry.dimension,
      round: entry.round,
      status: "open",
    }));
    let actionItemsPath = null;
    if (actionItems.length > 0) {
      actionItemsPath = path.join(path.dirname(sessionPath), `${path.basename(sessionPath, ".json")}.action-items.json`);
      fsSync.writeFileSync(actionItemsPath, `${JSON.stringify({ schema: "lattice.audience-action-items.v1", deck: deckId, session: path.basename(sessionPath), outcome: determination.outcome, items: actionItems }, null, 2)}\n`, "utf8");
    }
    emit({
      action: "session-check",
      deck: deckId,
      session: path.relative(cwd, sessionPath).split(path.sep).join("/"),
      rounds: session.rounds.map((round) => ({
        n: round.n,
        findings: findingsOfRound(round).length,
        verdicts: verdictsOfRound(round).length,
        improvements: (round.improvements ?? []).length,
        improvement: roundImprovement(session.rounds, session.rounds.indexOf(round)),
        scores: round.reviews.map((review) => review.scores ?? null),
      })),
      residual: residualFindings(session.rounds),
      actionItems,
      ...(actionItemsPath ? { actionItemsPath: path.relative(cwd, actionItemsPath).split(path.sep).join("/") } : {}),
      conclusion: session.conclusion ?? null,
      ...determination,
    });
    if (!determination.canExit) process.exit(1);
    return;
  }

  console.error(`[lattice] unknown audience session action: ${action} (init|append|check)`);
  process.exit(1);
}
