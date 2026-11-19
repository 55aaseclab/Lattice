// AI audience (v1.1) — the experience pack builder (design §5, §7).
//
// The pack is the deterministic input contract of an audience review round:
// what the audience PERCEIVES (stills of every stop + mid-animation frames,
// a whisper transcript of the narration) plus the deterministic measurements
// (lint, WPM, dwell variance, ducking, density) and the structural map
// (timeline, routes, stops, notes register check). pack.hash covers ALL pack
// inputs (timeline, notes, slide html, narration/bgm bytes, ASR identity) so
// an unchanged deck skips the whole rebuild — the cache semantics the
// incremental review loop relies on.
//
// Model calls (whisper ASR) are injectable: the command wires the real
// @huggingface/transformers engine, tests wire a stub. Still rendering
// reuses the video still pipeline (compileDeckVideoPlan + backend
// renderStill) behind the same injectable seam.

import fsSync from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import { loadConfig } from "../config/index.js";
import { deckDirPath, readManifest, requireV2Manifest } from "../edit/deck-view.js";
import { sha256Hex } from "../edit/provenance.js";
import { resolveTimeline } from "@55aaseclab/lattice-runtime/timeline";
import { validateStopRevealAnimation } from "@55aaseclab/lattice-runtime/themes/simple-light/presets";
import { RUNTIME_VERSION } from "@55aaseclab/lattice-runtime/deck";
import { ASR_MODEL_ID, ASR_LANGUAGE, decodeWavPcm16, rmsDb } from "./whisper.js";
import { VL_CRITIQUE_DIMENSIONS, VL_PROMPT, VL_PROMPT_CONTRACT, createVisionEngine } from "./vision.js";

export const PACK_SCHEMA = "lattice.audience-pack.v1";
export const PACK_BUILDER_VERSION = 5;
export const VISION_SCHEMA = "lattice.audience-vision.v1";

// The notes register contract (V2.0.19): notes are spoken first-person prose,
// never presenter stage directions. Same word set the R1 re-delivery grep
// used (DELIVERY.md "Instruction-wording residue").
const REGISTER_PATTERNS = [
  "Set the stage",
  "Emphasize",
  "Read the code aloud",
  "Read aloud",
  "Stress",
  "Connect",
  "Close on",
].map((pattern) => ({ pattern, regex: new RegExp(pattern, "g") }));

const WPM_BAND = Object.freeze({ min: 130, max: 170 });
// V2.0.25: Chinese narration measures characters per minute (each CJK char
// is one token). Natural zh presentation speech runs ~3.5-6 chars/s; the
// measured piper zh_CN-huayan-medium rate on this deck is ~5.2-5.7.
const WPM_BAND_ZH = Object.freeze({ min: 210, max: 360 });

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? "null" : stableStringify(item))).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function canonicalJson(value) {
  return stableStringify(value);
}

export function sha256OfValue(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function fail(payload, exitCode = 1) {
  process.stderr.write(`${JSON.stringify({ ok: false, command: "audience", ...payload }, null, 2)}\n`);
  process.exit(exitCode);
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify({ ok: true, command: "audience", ...payload }, null, 2)}\n`);
}

/**
 * Shared deck context for audience workflows: manifest, routed slide
 * definitions, notes, and the resolved timeline (mirrors the audio command's
 * loader so every consumer reads the same resolution rules).
 */
export async function loadAudienceDeckContext({ cwd, deckId }) {
  const config = await loadConfig(cwd);
  const deckDir = deckDirPath(cwd, config, deckId);
  if (!fsSync.existsSync(deckDir)) {
    fail({ error: { code: "deck-not-found", message: `deck directory not found: ${deckDir}` } }, 1);
  }
  let manifest;
  try {
    manifest = requireV2Manifest(readManifest(deckDir), deckId);
  } catch (error) {
    fail({ error: { code: error.code ?? "invalid-manifest", message: error.message } }, 1);
  }
  if (manifest.timeline === undefined) {
    fail({
      error: {
        code: "timeline-not-declared",
        message: `deck "${deckId}" does not declare a lattice.timeline.v1 in manifest.json; audience workflows require one (M7 timeline contract)`,
      },
    }, 1);
  }
  const entrySlides = manifest.entry?.slides;
  if (typeof entrySlides !== "string" || entrySlides === "") {
    fail({ error: { code: "invalid-manifest", message: `deck "${deckId}" must declare manifest.entry.slides` } }, 1);
  }
  const { createProjectModuleLoader } = await import("../deck-v2/project-module-loader.js");
  const loader = await createProjectModuleLoader(cwd);
  let slideDefinitions;
  let notes;
  try {
    const module = await loader.load(path.resolve(deckDir, entrySlides));
    slideDefinitions = module?.slideDefinitions;
    if (!Array.isArray(slideDefinitions) || slideDefinitions.length === 0) {
      fail({ error: { code: "invalid-manifest", message: `deck "${deckId}": ${entrySlides} must export a non-empty slideDefinitions array` } }, 1);
    }
    const notesPath = manifest.entry?.notes ? path.resolve(deckDir, manifest.entry.notes) : path.join(deckDir, "notes.js");
    notes = fsSync.existsSync(notesPath) ? JSON.parse(JSON.stringify((await loader.load(notesPath)).default ?? {})) : {};
  } catch (error) {
    fail({ error: { code: "deck-build-error", message: error.message } }, 1);
  } finally {
    await loader.close();
  }
  const resolution = resolveTimeline({
    manifest,
    slides: slideDefinitions,
    validateAnimation: (animation, options) => validateStopRevealAnimation(animation, options),
  });
  if (!resolution.ok) {
    fail({
      error: {
        code: "invalid-timeline",
        message: `deck "${deckId}" declares an invalid lattice.timeline.v1: ${resolution.errors.map((error) => error.message).join("; ")}`,
      },
    }, 1);
  }
  const route = manifest.routes?.main ?? manifest.routes?.[Object.keys(manifest.routes ?? {})[0]];
  if (!Array.isArray(route) || route.length === 0) {
    fail({ error: { code: "invalid-manifest", message: `deck "${deckId}" must declare a non-empty main route` } }, 1);
  }
  const segments = resolution.timeline.slides
    .filter((entry) => route.includes(entry.slideId))
    .sort((a, b) => route.indexOf(a.slideId) - route.indexOf(b.slideId));
  // The resolved timeline carries per-slide timing only; the audience pack
  // thinks in global frames, so bake the cumulative segment start frame.
  let cursor = 0;
  for (const segment of segments) {
    segment.startFrame = cursor;
    cursor += segment.durationFrames;
  }
  const slidesById = new Map(slideDefinitions.map((slide) => [slide.id, slide]));
  return { config, cwd, manifest, deckDir, timeline: resolution.timeline, segments, slidesById, notes, fps: manifest.fps ?? 30 };
}

/** Resolved slide html (string), or null when the slide has no html. */
export function slideHtml(slide) {
  if (!slide) return null;
  const html = typeof slide.html === "function" ? slide.html() : slide.html;
  return typeof html === "string" ? html : null;
}

// V2.0.25 zh support: CJK text has no whitespace — every CJK character is
// one token (the Chinese words-per-minute convention), while latin runs stay
// whole words. Used for the notes<->heard diff, WPM, and density alike.
const WORD_TOKEN_RE = /[a-z0-9_']+|[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g;

export function tokenizeWords(text) {
  const matches = String(text ?? "").toLowerCase().match(WORD_TOKEN_RE);
  return matches ?? [];
}

/** Per-slide visible word/token count: markup stripped, CJK-aware. */
export function visibleWords(html) {
  if (typeof html !== "string") return 0;
  const text = html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;|&#\d+;/gi, " ");
  return tokenizeWords(text).length;
}

function wordCount(text) {
  return tokenizeWords(text).length;
}

// ---- pack input identity -------------------------------------------------------

export function packInputs({ deckId, manifest, segments, slidesById, notes, narrationSha, bgmSha, asrIdentity, vlIdentity, fps, stillsMode }) {
  const slideHtmlById = {};
  for (const segment of segments) {
    slideHtmlById[segment.slideId] = slideHtml(slidesById.get(segment.slideId)) ?? "";
  }
  return {
    builder: PACK_BUILDER_VERSION,
    deck: deckId,
    fps,
    stills: stillsMode,
    timeline: manifest.timeline,
    routes: manifest.routes ?? {},
    notes: Object.fromEntries(segments.map((segment) => [segment.slideId, notes[segment.slideId] ?? ""])),
    slides: slideHtmlById,
    narrationWav: narrationSha,
    bgmWav: bgmSha,
    asr: asrIdentity,
    // v1.2: the vision engine identity is a pack input — a different VL
    // (or stub/off) produces different still descriptions, so the cache key
    // must move with it.
    vl: vlIdentity,
  };
}

export function computePackHash(inputs) {
  return sha256OfValue(inputs);
}

// ---- deterministic still frame plan --------------------------------------------

/**
 * Which frames the audience perceives: one still per stop (its fully
 * revealed state) plus up to two mid-animation frames per segment and one
 * dwell frame for static segments. Pure and deterministic.
 */
export function planStills(segments) {
  const frames = [];
  for (const segment of segments) {
    const stops = segment.stops;
    for (const stop of stops) {
      frames.push({ kind: "stop", slide: segment.slideId, stop: stop.id, frame: stop.frame });
    }
    const animationDuration = segment.animation?.durationFrames ?? 12;
    let mids = 0;
    for (let index = 1; index < stops.length && mids < 2; index += 1) {
      const previous = stops[index - 1].frame;
      const current = stops[index].frame;
      let mid = current - Math.max(1, Math.floor(animationDuration / 2));
      if (mid <= previous) mid = Math.floor((previous + current) / 2);
      if (mid > previous && mid < current) {
        mids += 1;
        frames.push({ kind: "mid", slide: segment.slideId, between: [stops[index - 1].id, stops[index].id], frame: mid });
      }
    }
    if (mids === 0 && stops.length === 1) {
      frames.push({ kind: "dwell", slide: segment.slideId, stop: stops[0].id, frame: Math.floor((stops[0].frame + segment.durationFrames) / 2) });
    }
  }
  return frames;
}

export function stillFileName(entry) {
  const frame = String(entry.frame).padStart(5, "0");
  if (entry.kind === "stop") return `stop-${entry.slide}-${entry.stop}-${frame}.png`;
  if (entry.kind === "mid") return `mid-${entry.slide}-${entry.between[0]}-${entry.between[1]}-${frame}.png`;
  return `dwell-${entry.slide}-${frame}.png`;
}



// ---- ASR loop collapse (V2.0.25) ----------------------------------------------

/**
 * Collapse whisper repetition-loop artifacts deterministically: a maximal run
 * of the same 1-6 character unit repeated >= 3 times collapses to one unit
 * ("计计计计计计…" -> "计", "规矩A规矩A规矩A" -> "规矩A"). Legitimate zh
 * narration repetition of a >= 3x identical short run is vanishingly rare,
 * while q8-quantized turbo loops are common on sentence pauses. Applied at
 * the publish boundary (subtitles) and to future transcript rendering; the
 * stored transcript.md keeps raw ASR output for adjudication.
 */
export function collapseAsrLoops(text) {
  let current = String(text ?? "");
  let previous;
  do {
    previous = current;
    current = current.replace(/(.{1,16})\1{2,}/gu, "$1");
  } while (current !== previous);
  return current;
}

// ---- speech-piece segmentation (V2.0.25) -------------------------------------

const PIECE_WINDOW_SECONDS = 0.1;
const PIECE_SILENCE_MIN_SECONDS = 0.35;
const PIECE_MAX_SECONDS = 6.5;
const PIECE_MIN_ENERGY = 0.004;

/**
 * Deterministic energy-VAD: windowed RMS over the slice, silences of
 * >= 0.35s split pieces, pieces longer than ~6.5s are split at the
 * quietest internal window (whisper loops/truncates on longer runs).
 * Returns [{ samples, fromSeconds, toSeconds }] with slice-local times.
 */
export function splitSpeechPieces(samples, sampleRate) {
  const window = Math.max(1, Math.round(PIECE_WINDOW_SECONDS * sampleRate));
  if (samples.length < window) {
    return samples.length > 0 ? [{ samples, fromSeconds: 0, toSeconds: samples.length / sampleRate }] : [];
  }
  const windows = Math.floor(samples.length / window);
  const energies = new Float32Array(windows);
  for (let index = 0; index < windows; index += 1) {
    let sum = 0;
    const base = index * window;
    for (let offset = 0; offset < window; offset += 1) {
      const value = samples[base + offset];
      sum += value * value;
    }
    energies[index] = Math.sqrt(sum / window);
  }
  let peak = 0;
  for (const energy of energies) peak = Math.max(peak, energy);
  const threshold = Math.max(peak * 0.06, PIECE_MIN_ENERGY);
  const isSilence = (index) => energies[index] < threshold;

  // Split at silence runs >= PIECE_SILENCE_MIN_SECONDS (cut at run middle).
  const silenceRun = Math.max(1, Math.round(PIECE_SILENCE_MIN_SECONDS / PIECE_WINDOW_SECONDS));
  const boundaries = [0];
  let run = 0;
  for (let index = 0; index < windows; index += 1) {
    if (isSilence(index)) {
      run += 1;
    } else {
      if (run >= silenceRun) boundaries.push(Math.round((index - run / 2)) * window);
      run = 0;
    }
  }
  boundaries.push(samples.length);

  // Enforce the max piece length: split at the quietest internal window.
  const maxWindows = Math.max(1, Math.round(PIECE_MAX_SECONDS / PIECE_WINDOW_SECONDS));
  const pieces = [];
  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    let from = boundaries[index];
    const end = boundaries[index + 1];
    while (end - from > maxWindows * window) {
      const spanWindows = Math.floor((end - from) / window);
      let quietest = from / window + Math.floor(spanWindows / 2);
      for (let probe = Math.floor(spanWindows / 4); probe < Math.floor((spanWindows * 3) / 4); probe += 1) {
        if (energies[from / window + probe] < energies[quietest]) quietest = from / window + probe;
      }
      const cut = quietest * window;
      pieces.push({ samples: samples.slice(from, cut), fromSeconds: from / sampleRate, toSeconds: cut / sampleRate });
      from = cut;
    }
    if (end - from > 0) pieces.push({ samples: samples.slice(from, end), fromSeconds: from / sampleRate, toSeconds: end / sampleRate });
  }
  return pieces.filter((piece) => piece.samples.length > 0);
}

// ---- transcript ----------------------------------------------------------------

/** Greedy LCS word diff between the notes source and the heard transcript. */
export function diffWords(source, heard) {
  const a = tokenizeWords(source);
  const b = tokenizeWords(heard);
  const rows = a.length;
  const cols = b.length;
  const lcs = Array.from({ length: rows + 1 }, () => new Uint32Array(cols + 1));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (a[i] === b[j]) {
      ops.push({ op: "same", source: a[i], heard: b[j] });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ op: "missing", source: a[i] });
      i += 1;
    } else {
      ops.push({ op: "extra", heard: b[j] });
      j += 1;
    }
  }
  while (i < rows) {
    ops.push({ op: "missing", source: a[i] });
    i += 1;
  }
  while (j < cols) {
    ops.push({ op: "extra", heard: b[j] });
    j += 1;
  }
  return ops;
}

/** Collapse a raw word diff into contiguous change regions. */
export function diffRegions(ops) {
  const regions = [];
  let current = null;
  for (const entry of ops) {
    if (entry.op === "same") {
      current = null;
      continue;
    }
    if (!current || current.op !== entry.op) {
      current = { op: entry.op, words: [] };
      regions.push(current);
    }
    current.words.push(entry.op === "missing" ? entry.source : entry.heard);
  }
  return regions.map((region) => ({ op: region.op, words: region.words.join(" ") }));
}

function renderTranscript({ deckId, packHash, engine, segments, notes, fps, transcriptBySlide, allChunks }) {
  const lines = [
    `# Audience pack transcript — ${deckId}`,
    "",
    `- packHash: ${packHash}`,
    `- asr: ${engine.engine} ${engine.engineVersion} (${engine.model}, dtype ${engine.dtype ?? "n/a"}, language ${engine.language ?? "n/a"})`,
    `- narration words are the spoken source (notes.js); "heard" is what whisper recovered from narration.wav`,
    `- ASR recovery is noisy (esp. zh, q8 quantized turbo): homophones, dropouts and occasional character loops can be ASR artifacts rather than TTS defects - adjudicate against the notes source and the PCM audio before blaming the narration`,
    "",
    "## Heard (full narration, in audio order)",
    "",
  ];
  for (const chunk of allChunks) {
    const [from, to] = chunk.timestamp ?? [null, null];
    lines.push(`- [${from ?? "?"}–${to ?? "?"}s]${from === null ? "" : ` frames ${Math.round(from * fps)}–${to === null ? "?" : Math.round(to * fps)}`} ${chunk.text.trim()}`);
  }
  if (allChunks.length === 0) lines.push("(no audio)");
  lines.push("", "## Per segment (notes vs heard)", "");
  for (const segment of segments) {
    const heard = transcriptBySlide.get(segment.slideId);
    const source = notes[segment.slideId] ?? "";
    const regions = diffRegions(diffWords(source, heard?.text ?? ""));
    const segmentEndSecond = ((segment.startFrame ?? 0) + segment.durationFrames) / fps;
    const straddles = (heard?.chunks ?? []).some((chunk) => {
      const to = chunk.timestamp?.[1];
      return typeof to === "number" && to > segmentEndSecond + 0.05;
    });
    lines.push(`### ${segment.slideId}`, "");
    const start = segment.startFrame ?? 0;
    lines.push(`- frames ${start}–${start + segment.durationFrames - 1} (seconds ${(start / fps).toFixed(2)}–${segmentEndSecond.toFixed(2)})`);
    lines.push(`- notes (source): ${source}`);
    lines.push(`- heard (assigned chunks): ${heard?.text || "(none assigned)"}`);
    if (heard?.chunks?.length) {
      for (const chunk of heard.chunks) {
        const [from, to] = chunk.timestamp ?? [null, null];
        lines.push(`  - [${from ?? "?"}–${to ?? "?"}s → frames ${from === null ? "?" : Math.round(from * fps)}–${to === null ? "?" : Math.round(to * fps)}] ${chunk.text.trim()}`);
      }
    }
    if (straddles) {
      lines.push(`  - note: a whisper chunk straddles this segment's end boundary — chunks are longer than one narration segment here, so the assigned text may contain the next segment's opening words. The full audio order above is the ground truth.`);
    }
    lines.push(`- diff (normalized word level, heuristic): ${regions.length === 0 ? "no differences" : JSON.stringify(regions)}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

// ---- metrics --------------------------------------------------------------------

function analyzeNarrationWav({ narrationPath, segments, fps }) {
  if (!narrationPath || !fsSync.existsSync(narrationPath)) return null;
  const buffer = fsSync.readFileSync(narrationPath);
  const { sampleRate, samples } = decodeWavPcm16(buffer);
  const segmentMetrics = [];
  for (const segment of segments) {
    const startSample = Math.round(((segment.startFrame ?? 0) / fps) * sampleRate);
    const endSample = Math.min(samples.length, Math.round(((segment.startFrame ?? 0) + segment.durationFrames) / fps * sampleRate));
    let lastAudible = startSample - 1;
    const threshold = 40 / 32768;
    for (let index = startSample; index < endSample; index += 1) {
      if (Math.abs(samples[index]) >= threshold) lastAudible = index;
    }
    const speechSeconds = lastAudible >= startSample ? (lastAudible + 1 - startSample) / sampleRate : 0;
    const segmentSeconds = segment.durationFrames / fps;
    segmentMetrics.push({
      slideId: segment.slideId,
      startFrame: segment.startFrame ?? 0,
      durationFrames: segment.durationFrames,
      speechSeconds: Math.round(speechSeconds * 1000) / 1000,
      tailSeconds: Math.round((segmentSeconds - speechSeconds) * 1000) / 1000,
      speechRmsDb: Number.isFinite(rmsDb(samples, startSample, endSample)) ? Math.round(rmsDb(samples, startSample, endSample) * 10) / 10 : null,
    });
  }
  const globalDb = rmsDb(samples);
  let peak = 0;
  for (const sample of samples) {
    const magnitude = Math.abs(sample);
    if (magnitude > peak) peak = magnitude;
  }
  return {
    sampleRate,
    segments: segmentMetrics,
    globalMeanDb: Number.isFinite(globalDb) ? Math.round(globalDb * 10) / 10 : null,
    globalPeakDb: peak > 0 ? Math.round(20 * Math.log10(peak) * 10) / 10 : null,
  };
}

/**
 * Ducking estimate from the mixer's declared side-chain (threshold 0.03,
 * ratio 20 — see src/video/audio-mix.js): while narration sits above the
 * threshold the bed is pulled down by (level - threshold) * (1 - 1/ratio).
 * Attack/release transients are not modeled; reported as an estimate.
 */
function estimateDucking(narrationAnalysis) {
  const thresholdDb = 20 * Math.log10(0.03);
  const ratio = 20;
  const speechSegments = (narrationAnalysis?.segments ?? []).filter((segment) => segment.speechRmsDb !== null);
  if (speechSegments.length === 0) return null;
  const depths = speechSegments.map((segment) => Math.max(0, (segment.speechRmsDb - thresholdDb) * (1 - 1 / ratio)));
  const meanDepth = depths.reduce((sum, value) => sum + value, 0) / depths.length;
  return {
    declared: { threshold: 0.03, thresholdDb: Math.round(thresholdDb * 10) / 10, ratio, attackMs: 20, releaseMs: 420 },
    estimatedDepthDb: Math.round(meanDepth * 10) / 10,
    method: "per-segment narration RMS above side-chain threshold × (1 - 1/ratio); transients not modeled",
  };
}

function analyzeDwell(segments) {
  return segments.map((segment) => {
    const frames = segment.stops.map((stop) => stop.frame);
    const gaps = [];
    for (let index = 1; index < frames.length; index += 1) gaps.push(frames[index] - frames[index - 1]);
    const mean = gaps.length ? gaps.reduce((sum, value) => sum + value, 0) / gaps.length : null;
    const spread = gaps.length ? Math.max(...gaps) - Math.min(...gaps) : 0;
    return { slideId: segment.slideId, stopCount: frames.length, stopFrames: frames, gaps, meanGapFrames: mean === null ? null : Math.round(mean * 10) / 10, spreadFrames: spread };
  });
}

function analyzeDensity(slidesById, segments, notes) {
  return segments.map((segment) => {
    const html = slideHtml(slidesById.get(segment.slideId)) ?? "";
    return {
      slideId: segment.slideId,
      visibleWords: visibleWords(html),
      notesWords: wordCount(notes[segment.slideId]),
      revealMarkers: (html.match(/data-lattice-reveal=/g) ?? []).length,
      tables: (html.match(/<table\b/g) ?? []).length,
      codeBlocks: (html.match(/sl-tech-code\b/g) ?? []).length + (html.match(/sl-tech-terminal\b/g) ?? []).length,
      figures: (html.match(/<figure\b/g) ?? []).length,
    };
  });
}

// ---- lint -------------------------------------------------------------------------

async function runRenderedLint({ cwd, deckId, skipLint }) {
  if (skipLint) return { skipped: true, reason: "--skip-lint" };
  const { runInspection } = await import("../commands/inspect.js");
  const { report, exitCode } = await runInspection({ cwd, args: { rendered: true, deck: deckId, lint: true, timeout: 30000 } });
  const deck = report.decks?.[0];
  return {
    ok: exitCode === 0,
    findings: deck?.lint?.findings ?? [],
    counts: deck?.lint?.counts ?? null,
    schema: "lattice.lint.v1",
  };
}

// ---- stills -----------------------------------------------------------------------

async function renderStillFiles({ cwd, deckId, packDir, bundleDir, stillPlan, fps }) {
  const { compileDeckVideoPlan } = await import("../commands/video.js");
  const { ensureBackendsInitialized, getBackend } = await import("../video/registry.js");
  const { exportCommand } = await import("../commands/export.js");
  const config = await loadConfig(cwd);
  const defaultBundle = path.resolve(cwd, config.outDir, "static-decks", deckId);
  if (!bundleDir) {
    // Stills must depict the CURRENT deck: a stale static export renders the
    // wrong slide markup against the plan's clip schedule. The export is
    // idempotent and reads the frozen sources; the pack cache skips it on
    // unchanged decks anyway.
    await exportCommand({ args: { deck: deckId }, cwd });
  }
  const args = { deck: deckId, route: "main" };
  if (bundleDir) args["bundle-dir"] = bundleDir;
  const { completePlan, planHash } = await compileDeckVideoPlan({ args, config, projectRoot: cwd });
  ensureBackendsInitialized();
  const backend = getBackend("remotion");
  const workDir = path.resolve(cwd, ".lattice", "generated", "remotion");
  const clipsBySlide = new Map(completePlan.clips.map((clip) => [clip.slideId, clip]));
  const stillsDir = path.join(packDir, "stills");
  await fsp.mkdir(stillsDir, { recursive: true });
  const prepared = await backend.prepare({ plan: completePlan, bundleDir: bundleDir ?? defaultBundle, workDir, projectRoot: cwd });
  const files = [];
  try {
    // Issue 011: the whole still plan renders through ONE warm browser
    // session (backend.renderStills) instead of one browser boot per still.
    const requests = [];
    for (const entry of stillPlan) {
      const clip = clipsBySlide.get(entry.slide);
      // The still plan carries per-segment local frames; the backend renders
      // global composition frames.
      const globalFrame = (clip?.startFrame ?? 0) + entry.frame;
      requests.push({ frame: globalFrame, output: path.join(stillsDir, stillFileName(entry)) });
    }
    const artifacts = await backend.renderStills({ prepared, requests });
    for (let index = 0; index < stillPlan.length; index += 1) {
      const entry = stillPlan[index];
      const artifact = artifacts[index];
      files.push({ file: path.relative(packDir, artifact.path).split(path.sep).join("/"), frame: artifact.frame, kind: entry.kind, slide: entry.slide, stop: entry.stop ?? null, bytes: fsSync.statSync(artifact.path).size });
    }
  } finally {
    await backend.cleanup?.(prepared)?.catch?.(() => {});
  }
  return { files, planHash };
}

// ---- pack command -----------------------------------------------------------------

export function packDirPath(cwd, deckId) {
  return path.resolve(cwd, ".lattice", "audience-packs", deckId);
}

/**
 * Build (or cache-hit) the experience pack for one deck. Library entry used
 * by the `audience pack` command AND by `audience review` (which must not
 * emit a second JSON object on the command's stdout); deterministic outputs,
 * no timestamps.
 */
export async function buildAudiencePack({ cwd = process.cwd(), deckId, packDir: packDirOverride = null, skipLint = false, stillsMode: stillsModeOverride = null, stillsRenderer = null }) {
  if (typeof deckId !== "string" || deckId === "") {
    fail({ error: { code: "missing-argument", message: "--deck <id> is required" } }, 2);
  }
  const packDir = packDirOverride ? path.resolve(cwd, packDirOverride) : packDirPath(cwd, deckId);
  const skipLintEffective = skipLint;
  const stillsMode = stillsModeOverride === "none" ? "none" : "full";

  const context = await loadAudienceDeckContext({ cwd, deckId });
  const { manifest, deckDir, segments, slidesById, notes, fps } = context;

  const narrationPath = path.join(deckDir, "assets", "audio", "narration.wav");
  const bgmPath = path.join(deckDir, "assets", "audio", "bgm.wav");
  const narrationSha = fsSync.existsSync(narrationPath) ? sha256Hex(fsSync.readFileSync(narrationPath)) : null;
  const bgmSha = fsSync.existsSync(bgmPath) ? sha256Hex(fsSync.readFileSync(bgmPath)) : null;

  // V2.0.25: the ASR language follows the narration declaration
  // (timeline.audio.narration.language, default "en") so zh narration is
  // transcribed as zh instead of force-translated.
  const narrationLanguage = manifest.timeline?.audio?.narration?.language ?? ASR_LANGUAGE;
  const asrIdentity = process.env.LATTICE_ASR_ENGINE === "stub"
    ? { engine: "stub", language: narrationLanguage }
    : { engine: "transformers.js", model: ASR_MODEL_ID, language: narrationLanguage };
  // v1.2: the vision engine is created up front (cheap — the real engine
  // spawns opencode per still) so its pinned identity is part of pack.hash.
  const visionEngine = await createVisionEngine();
  const inputs = packInputs({ deckId, manifest, segments, slidesById, notes, narrationSha, bgmSha, asrIdentity, vlIdentity: visionEngine.identity, fps, stillsMode });
  const packHash = computePackHash(inputs);

  const hashPath = path.join(packDir, "pack.hash");
  if (fsSync.existsSync(hashPath)) {
    try {
      const existing = JSON.parse(fsSync.readFileSync(hashPath, "utf8"));
      if (existing.packHash === packHash) {
        return {
          action: "pack",
          deck: deckId,
          packHash,
          out: path.relative(cwd, packDir).split(path.sep).join("/"),
          cached: true,
          inputs,
          packDir,
        };
      }
    } catch {
      // Corrupt pack.hash → full rebuild below.
    }
  }

  await fsp.mkdir(packDir, { recursive: true });
  const stillsDir = path.join(packDir, "stills");
  await fsp.rm(stillsDir, { recursive: true, force: true });
  await fsp.mkdir(stillsDir, { recursive: true });

  // 1. stills (video still pipeline; `stillsRenderer` is the library-level
  //    injectable test seam — the command passes the real renderer)
  const stillPlan = planStills(segments);
  let stills = { mode: stillsMode, files: [] };
  let stillPlanHash = null;
  if (stillsMode === "full") {
    const rendered = stillsRenderer
      ? await stillsRenderer({ packDir, stillPlan, fps })
      : await renderStillFiles({ cwd, deckId, packDir, bundleDir: null, stillPlan, fps });
    stills = { mode: "full", files: rendered.files };
    stillPlanHash = rendered.planHash;
  } else {
    stills = { mode: "none", files: [] };
  }

  // 1b. vision (v1.2, V2.0.31 critique increment): one VL pass per STOP
  //     still — what a viewer SEES plus the design critique (canvas-design
  //     dimensions) for the persona prompts. Failure degradation is
  //     contractual: a VL outage never blocks the pack; the failure is
  //     recorded in vision.md/vision.json and the review prompt falls back
  //     to the no-vision wording. A model answer without a critique
  //     degrades to description-only (critique omitted), never a failure.
  const stopStills = stills.files.filter((still) => still.kind === "stop" && still.stop);
  const visionEntries = [];
  const visionFailures = [];
  if (visionEngine.mode !== "off") {
    for (const still of stopStills) {
      try {
        const { description, critique } = await visionEngine.describe({
          image: path.join(packDir, still.file),
          slideId: still.slide,
          stopId: still.stop,
          frame: still.frame,
        });
        visionEntries.push({
          slideId: still.slide,
          stopId: still.stop,
          frame: still.frame,
          file: still.file,
          description,
          ...(critique ? { critique } : {}),
        });
      } catch (error) {
        visionFailures.push({ file: still.file, slideId: still.slide, stopId: still.stop, error: String(error?.message ?? error).slice(0, 500) });
      }
    }
  }
  const visionMode = visionEngine.mode === "opencode" && visionEntries.length === 0 && visionFailures.length > 0
    ? "failed"
    : stopStills.length === 0 && stills.mode === "full"
      ? "no-stop-stills"
      : stills.mode === "none"
        ? "no-stills"
        : visionEngine.mode;
  const vision = {
    schema: VISION_SCHEMA,
    deck: deckId,
    mode: visionMode,
    vl: visionEngine.identity,
    prompt: VL_PROMPT,
    contract: VL_PROMPT_CONTRACT,
    critiqueDimensions: VL_CRITIQUE_DIMENSIONS,
    stills: visionEntries,
    failures: visionFailures,
  };

  // 2. whisper transcript (notes vs heard diff evidence)
  const { createTranscriptionEngine, resampleLinear } = await import("./whisper.js");
  const transcriptEngine = await createTranscriptionEngine({ language: narrationLanguage });
  const transcriptBySlide = new Map(segments.map((segment) => [segment.slideId, { text: "", chunks: [] }]));
  let resultChunks = [];
  if (narrationSha && fsSync.existsSync(narrationPath)) {
    const { samples, sampleRate } = decodeWavPcm16(fsSync.readFileSync(narrationPath));
    let audio = samples;
    let rate = sampleRate;
    if (sampleRate !== 16000) {
      // Deterministic linear resample to the ASR model's native rate.
      rate = 16000;
      audio = resampleLinear(samples, sampleRate, rate);
    }
    // V2.0.25: transcribe PER SPEECH PIECE. Two whisper-turbo long-form
    // failure modes were observed on the first zh deck: timestamp tokens
    // collapse on multi-minute input (one 198-second chunk), and short
    // sentence pauses (piper's 0.2s inter-sentence silence) trigger
    // repetition loops, while long pieces get truncated mid-sentence.
    // Deterministic fix: energy-VAD each timeline segment into speech
    // pieces (split at silences >= 0.35s, cap pieces at ~6.5s by splitting
    // at the quietest internal window), transcribe each piece separately,
    // and stamp each piece with its global time range. Segment assignment
    // is exact by construction (pieces never leave their segment); chunk
    // timestamps are the piece bounds, which the subtitles pipeline cuts
    // into finer cues for free.
    for (const segment of segments) {
      const startSample = Math.round(((segment.startFrame ?? 0) / fps) * rate);
      const endSample = Math.min(audio.length, Math.round((((segment.startFrame ?? 0) + segment.durationFrames) / fps) * rate));
      const slice = audio.slice(startSample, endSample);
      if (slice.length === 0) continue;
      const offsetSeconds = (segment.startFrame ?? 0) / fps;
      for (const piece of splitSpeechPieces(slice, rate)) {
        const result = await transcriptEngine.transcribe({ samples: piece.samples, sampleRate: rate });
        const text = String(result.text ?? "").trim();
        if (text === "") continue;
        const globalChunk = {
          timestamp: [offsetSeconds + piece.fromSeconds, offsetSeconds + piece.toSeconds],
          text: ` ${text}`,
        };
        resultChunks.push(globalChunk);
        const entry = transcriptBySlide.get(segment.slideId);
        entry.text = `${entry.text} ${text}`.trim();
        entry.chunks.push(globalChunk);
      }
    }
  } else {
    for (const segment of segments) transcriptBySlide.set(segment.slideId, { text: "(no narration.wav in the deck)", chunks: [] });
  }

  // 3. transcript.md (notes vs heard diff)
  const transcriptMd = renderTranscript({
    deckId,
    packHash,
    engine: transcriptEngine,
    segments,
    notes,
    fps,
    transcriptBySlide,
    allChunks: narrationSha && fsSync.existsSync(narrationPath) ? resultChunks : [],
  });
  await fsp.writeFile(path.join(packDir, "transcript.md"), transcriptMd, "utf8");

  // 3a. transcript.json — the machine-readable transcript (whisper chunks
  //     with timestamps + the per-segment assignment), the deterministic
  //     cache the subtitles pipeline consumes (V2.0.23). Same inputs as
  //     transcript.md; no timestamps, pure artifact of this build.
  const transcriptJson = {
    schema: "lattice.audience-transcript.v1",
    deck: deckId,
    packHash,
    narrationWav: narrationSha,
    asr: {
      engine: transcriptEngine.engine,
      version: transcriptEngine.engineVersion,
      model: transcriptEngine.model,
      dtype: transcriptEngine.dtype ?? "n/a",
      language: transcriptEngine.language ?? "n/a",
    },
    chunks: resultChunks,
    segments: segments.map((segment) => {
      const heard = transcriptBySlide.get(segment.slideId);
      return {
        slideId: segment.slideId,
        startFrame: segment.startFrame ?? 0,
        durationFrames: segment.durationFrames,
        text: heard?.text ?? "",
        chunks: heard?.chunks ?? [],
      };
    }),
  };
  await fsp.writeFile(path.join(packDir, "transcript.json"), `${JSON.stringify(transcriptJson, null, 2)}\n`, "utf8");

  // 3b. vision.md + vision.json (what the VL says a viewer sees at each
  //     stop, and what is visually wrong in it)
  const visionMdLines = [
    `# Audience pack vision — ${deckId}`,
    "",
    `- vl: ${visionEngine.identity.engine}${visionEngine.identity.engineVersion ? ` ${visionEngine.identity.engineVersion}` : ""}${visionEngine.identity.model ? ` (${visionEngine.identity.model})` : ""}`,
    `- mode: ${visionMode}`,
    `- prompt contract: ${VL_PROMPT_CONTRACT}`,
    `- descriptions are what the VL model says a viewer SEES at each stop still, each with a design critique against: ${VL_CRITIQUE_DIMENSIONS.join("; ")}`,
    `- anchor visual findings with frameAddress (structure.json frames)`,
    "",
  ];
  if (visionEntries.length > 0) {
    for (const entry of visionEntries) {
      visionMdLines.push(`## ${entry.slideId}/${entry.stopId} — frame ${entry.frame} (\`${entry.file}\`)`, "", entry.description, "");
      if (entry.critique) {
        visionMdLines.push(`Critique: ${entry.critique}`, "");
      }
    }
  } else if (visionMode === "no-stills") {
    visionMdLines.push("(no stills in this pack — vision descriptions unavailable)", "");
  } else if (visionMode === "no-stop-stills") {
    visionMdLines.push("(the still plan carries no stop stills — vision descriptions unavailable)", "");
  } else if (visionMode === "off") {
    visionMdLines.push("(vision engine off via LATTICE_VL_ENGINE=off — descriptions unavailable; stills and metrics unaffected)", "");
  } else {
    visionMdLines.push("(the vision engine produced no descriptions — the pack continues without vision)", "");
  }
  if (visionFailures.length > 0) {
    visionMdLines.push("## Failures (degraded, non-blocking)", "");
    for (const failure of visionFailures) {
      visionMdLines.push(`- \`${failure.file}\` (${failure.slideId}/${failure.stopId}): ${failure.error}`);
    }
    visionMdLines.push("");
  }
  const visionMd = `${visionMdLines.join("\n")}`;
  await fsp.writeFile(path.join(packDir, "vision.md"), visionMd, "utf8");
  await fsp.writeFile(path.join(packDir, "vision.json"), `${JSON.stringify(vision, null, 2)}\n`, "utf8");

  // 4. metrics.json (lint + narration/WPM + dwell + ducking + density)
  const narrationAnalysis = analyzeNarrationWav({ narrationPath: narrationSha ? narrationPath : null, segments, fps });
  const lint = await runRenderedLint({ cwd, deckId, skipLint: skipLintEffective });
  const metrics = {
    schema: "lattice.audience-metrics.v1",
    deck: deckId,
    fps,
    totalFrames: segments.reduce((sum, segment) => sum + segment.durationFrames, 0),
    lint,
    wpmBand: narrationLanguage === "zh" ? WPM_BAND_ZH : WPM_BAND,
    narration: narrationAnalysis
      ? {
          segments: narrationAnalysis.segments.map((segment) => {
            const words = wordCount(notes[segment.slideId]);
            return {
              ...segment,
              words,
              wpm: segment.speechSeconds > 0 ? Math.round((words / segment.speechSeconds) * 60) : null,
            };
          }),
          globalMeanDb: narrationAnalysis.globalMeanDb,
          globalPeakDb: narrationAnalysis.globalPeakDb,
          sampleRate: narrationAnalysis.sampleRate,
        }
      : null,
    ducking: estimateDucking(narrationAnalysis),
    dwell: analyzeDwell(segments),
    density: analyzeDensity(slidesById, segments, notes),
  };
  await fsp.writeFile(path.join(packDir, "metrics.json"), `${JSON.stringify(metrics, null, 2)}\n`, "utf8");

  // 5. structure.json (timeline/routes/stops + notes register check)
  const structure = {
    schema: "lattice.audience-structure.v1",
    deck: deckId,
    route: segments.map((segment) => segment.slideId),
    slides: segments.map((segment) => {
      const noteText = notes[segment.slideId] ?? "";
      const flags = [];
      for (const { pattern, regex } of REGISTER_PATTERNS) {
        regex.lastIndex = 0;
        const match = regex.exec(noteText);
        if (match) flags.push({ pattern, match: match[0] });
      }
      return {
        slideId: segment.slideId,
        durationFrames: segment.durationFrames,
        animation: segment.animation ?? null,
        stops: segment.stops.map((stop) => ({ id: stop.id, frame: stop.frame })),
        notesWords: wordCount(noteText),
        notesText: noteText,
        notesRegister: { flagged: flags, contract: "V2.0.19 notes are spoken first-person prose; the patterns above are presenter stage directions that TTS reads aloud" },
      };
    }),
  };
  await fsp.writeFile(path.join(packDir, "structure.json"), `${JSON.stringify(structure, null, 2)}\n`, "utf8");

  // 6. pack.json + pack.hash (deterministic identity, no timestamps)
  const toolchain = {
    node: process.version,
    "lattice-runtime": RUNTIME_VERSION,
    "pack-builder": PACK_BUILDER_VERSION,
    asr: {
      engine: transcriptEngine.engine,
      version: transcriptEngine.engineVersion,
      model: transcriptEngine.model,
      dtype: transcriptEngine.dtype ?? "n/a",
      language: transcriptEngine.language ?? "n/a",
    },
    vl: { mode: visionMode, ...visionEngine.identity },
    stills: { mode: stillsMode, backend: stillsMode === "full" ? "remotion" : "none", ...(stillPlanHash ? { planHash: stillPlanHash } : {}) },
  };
  const packJson = {
    schema: PACK_SCHEMA,
    deck: deckId,
    packHash,
    inputs,
    toolchain,
    files: {
      transcript: { file: "transcript.md", sha256: sha256Hex(Buffer.from(transcriptMd, "utf8")) },
      transcriptJson: { file: "transcript.json", sha256: sha256Hex(Buffer.from(`${JSON.stringify(transcriptJson, null, 2)}\n`, "utf8")) },
      vision: { file: "vision.md", sha256: sha256Hex(Buffer.from(visionMd, "utf8")) },
      metrics: { file: "metrics.json", sha256: sha256Hex(Buffer.from(`${JSON.stringify(metrics, null, 2)}\n`, "utf8")) },
      structure: { file: "structure.json", sha256: sha256Hex(Buffer.from(`${JSON.stringify(structure, null, 2)}\n`, "utf8")) },
      stills: stills.files,
    },
  };
  await fsp.writeFile(path.join(packDir, "pack.json"), `${JSON.stringify(packJson, null, 2)}\n`, "utf8");
  await fsp.writeFile(hashPath, `${JSON.stringify({ schema: PACK_SCHEMA, packHash, inputs }, null, 2)}\n`, "utf8");

  return {
    action: "pack",
    deck: deckId,
    packHash,
    out: path.relative(cwd, packDir).split(path.sep).join("/"),
    cached: false,
    stills: { mode: stillsMode, count: stills.files.length },
    vision: { mode: visionMode, described: visionEntries.length, failures: visionFailures.length },
    lint: { ok: lint.ok ?? true, skipped: Boolean(lint.skipped), findings: (lint.findings ?? []).length },
    transcript: { engine: transcriptEngine.engine, model: transcriptEngine.model },
    toolchain,
    packDir,
  };
}

export async function audiencePackCommand({ args }) {
  const payload = await buildAudiencePack({
    deckId: args.deck,
    packDirOverride: args.out ? path.resolve(process.cwd(), args.out) : null,
    skipLint: args["skip-lint"] === true,
    stillsMode: args.stills === "none" ? "none" : "full",
  });
  const { packDir: _packDir, ...emitPayload } = payload;
  emit(emitPayload);
}
