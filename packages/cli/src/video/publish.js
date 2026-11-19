// V2.0.23 — publish pipeline: subtitles and chapters derived mechanically
// from artifacts that already exist (PRD M11 §挂载, the competitor P1 list).
//
//   lattice video subtitles --deck <id> [--out <dir>]
//     The whisper transcript (pack transcript.json cache, else a live ASR
//     run through the pack's whisper path) + the timeline → subtitles.srt:
//     frame-aligned cues cut at every segment boundary, CJK-safe short lines
//     (clause/space splits, ≤2 lines × 42 chars), and the audience loop's
//     residual pacing findings as header comment notes (advisory split-point
//     candidates; v1 does not force any coupling). A deck without narration
//     is a silent no-op (exit 0, nothing written).
//
//   lattice video chapters --deck <id> [--out <dir>]
//     Segment starts + slide titles → chapters.txt ("00:00 标题" lines,
//     YouTube/Bilibili paste-ready). Requires a lattice.timeline.v1 (the
//     chapter boundaries ARE the segment boundaries).
//
// Everything here is deterministic: same deck inputs + same transcript →
// byte-identical outputs.

import fsSync from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { collapseAsrLoops } from "../audience/pack.js";
import { loadConfig } from "../config/index.js";
import { deckDirPath, readManifest, requireV2Manifest } from "../edit/deck-view.js";
import { sha256Hex } from "../edit/provenance.js";
import { resolveTimeline } from "@55aaseclab/lattice-runtime/timeline";
import { validateStopRevealAnimation } from "@55aaseclab/lattice-runtime/themes/simple-light/presets";
import { decodeWavPcm16, resampleLinear } from "../audience/whisper.js";
import { latestSessionPath, readSession, residualFindings } from "../audience/session.js";
import { packDirPath } from "../audience/pack.js";

export const SUBTITLES_SCHEMA = "lattice.video-subtitles.v1";
export const CHAPTERS_SCHEMA = "lattice.video-chapters.v1";
export const TRANSCRIPT_SCHEMA = "lattice.audience-transcript.v1";
export const PUBLISH_DIR_SEGMENTS = [".lattice", "generated", "publish"];

export const SUBTITLE_MAX_CHARS_PER_LINE = 42;
export const SUBTITLE_MAX_LINES = 2;

export class PublishError extends Error {
  constructor(payload, exitCode = 1) {
    super(payload.error?.message ?? "publish failed");
    this.payload = payload;
    this.exitCode = exitCode;
  }
}

function fail(payload, exitCode = 1) {
  throw new PublishError(payload, exitCode);
}

/**
 * Shared deck context for the publish commands: manifest, routed segments
 * (with cumulative start frames), slide definitions, fps. Requires a
 * lattice.timeline.v1 — the segment boundaries ARE the chapter/cue anchors.
 */
export async function loadPublishContext({ cwd, deckId }) {
  if (typeof deckId !== "string" || deckId === "") {
    fail({ error: { code: "missing-argument", message: "--deck <id> is required" } }, 2);
  }
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
        message: `deck "${deckId}" does not declare a lattice.timeline.v1; the publish pipeline derives subtitles/chapters from the timeline's segment boundaries (M7 contract)`,
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
  try {
    const module = await loader.load(path.resolve(deckDir, entrySlides));
    slideDefinitions = module?.slideDefinitions;
    if (!Array.isArray(slideDefinitions) || slideDefinitions.length === 0) {
      fail({ error: { code: "invalid-manifest", message: `deck "${deckId}": ${entrySlides} must export a non-empty slideDefinitions array` } }, 1);
    }
  } catch (error) {
    if (error instanceof PublishError) throw error;
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
  let cursor = 0;
  for (const segment of segments) {
    segment.startFrame = cursor;
    cursor += segment.durationFrames;
  }
  const slidesById = new Map(slideDefinitions.map((slide) => [slide.id, slide]));
  const fps = manifest.fps ?? 30;
  return {
    config,
    cwd,
    deckDir,
    manifest,
    segments,
    slidesById,
    fps,
    totalFrames: cursor,
    narrationPath: path.join(deckDir, "assets", "audio", "narration.wav"),
  };
}

/** Default publish output directory for one deck (server-enforced tree). */
export function publishDir(cwd, deckId) {
  return path.resolve(cwd, ...PUBLISH_DIR_SEGMENTS, deckId);
}

// ---- slide titles ------------------------------------------------------------

function htmlText(markup) {
  return String(markup ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z]+;|&#\d+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The slide's human title, deterministically: the first heading inside the
 * theme's `ph title` container, else the first <h1>, else the slide id.
 */
export function slideTitle(slide) {
  if (!slide) return "";
  const html = typeof slide.html === "function" ? slide.html() : slide.html;
  if (typeof html !== "string" || html === "") return slide.id ?? "";
  const titleContainer = html.match(/class="[^"]*\bph\b[^"]*\btitle\b[^"]*"[^>]*>\s*<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/i)
    ?? html.match(/class="[^"]*\btitle\b[^"]*"[^>]*>\s*<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/i);
  if (titleContainer) {
    const text = htmlText(titleContainer[2]);
    if (text !== "") return text;
  }
  // Fallback: the first heading on the slide (h1, then h2, then h3).
  for (const tag of ["h1", "h2", "h3"]) {
    const heading = html.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i"));
    if (heading) {
      const text = htmlText(heading[1]);
      if (text !== "") return text;
    }
  }
  return slide.id ?? "";
}

// ---- chapters ----------------------------------------------------------------

/** mm:ss below one hour, h:mm:ss at or above it (YouTube/Bilibili style). */
export function formatChapterTimestamp(seconds) {
  const total = Math.max(0, Math.floor(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${h > 0 ? `${h}:` : ""}${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** One chapter per segment: segment start + slide title, in route order. */
export function buildChapters({ segments, slidesById, fps }) {
  return segments.map((segment) => {
    const seconds = (segment.startFrame ?? 0) / fps;
    return {
      slideId: segment.slideId,
      startFrame: segment.startFrame ?? 0,
      seconds: Math.round(seconds * 1000) / 1000,
      timecode: formatChapterTimestamp(seconds),
      title: slideTitle(slidesById.get(segment.slideId)) || segment.slideId,
    };
  });
}

export function renderChaptersText(chapters) {
  return `${chapters.map((chapter) => `${chapter.timecode} ${chapter.title}`).join("\n")}\n`;
}

// ---- subtitles ---------------------------------------------------------------

/** HH:MM:SS,mmm SRT timestamp. */
export function formatSrtTimestamp(seconds) {
  const clamped = Math.max(0, seconds);
  const totalMs = Math.round(clamped * 1000);
  const h = Math.floor(totalMs / 3600000);
  const m = Math.floor((totalMs % 3600000) / 60000);
  const s = Math.floor((totalMs % 60000) / 1000);
  const ms = totalMs % 1000;
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

const CLAUSE_BOUNDARY = /(?<=[。！？!?；;])/;
const SOFT_BOUNDARY = /(?<=[，,、—–])/;
const WHITESPACE_BOUNDARY = /\s+/;

/**
 * Split one long text into cue-sized parts (≤ maxChars per part) at clause
 * punctuation, then soft punctuation, then whitespace, then hard. Used for
 * CJK-safe short lines: no cue line ever exceeds the cap.
 */
export function splitCueText(text, maxChars = SUBTITLE_MAX_CHARS_PER_LINE * SUBTITLE_MAX_LINES) {
  const raw = String(text ?? "").trim();
  if (raw === "") return [];
  if (raw.length <= maxChars) return [raw];
  const clauses = raw.split(CLAUSE_BOUNDARY).map((part) => part.trim()).filter(Boolean);
  const pieces = [];
  for (const clause of clauses) {
    if (clause.length <= maxChars) {
      pieces.push(clause);
      continue;
    }
    let rest = clause;
    while (rest.length > maxChars) {
      const window = rest.slice(0, maxChars + 1);
      const softMatches = [...window.matchAll(new RegExp(SOFT_BOUNDARY, "g"))];
      let cut = -1;
      for (const match of softMatches) {
        if (match.index > 0 && match.index <= maxChars) cut = match.index;
      }
      if (cut === -1) {
        const lastSpace = window.search(/\s+\S*$/);
        if (lastSpace > 0) cut = lastSpace;
      }
      if (cut === -1) cut = maxChars;
      pieces.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest !== "") pieces.push(rest);
  }
  // Greedy merge of tiny trailing pieces stays deterministic (no piece is
  // dropped; merging only joins adjacent pieces while under the cap).
  const merged = [];
  for (const piece of pieces) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && (previous + piece).length <= maxChars && (previous.endsWith("。") === false && previous.endsWith("!") === false)) {
      merged[merged.length - 1] = `${previous} ${piece}`;
    } else {
      merged.push(piece);
    }
  }
  return merged;
}

function cutCueAt(cue, atSeconds) {
  // Character cut lands at the break (clause → soft → whitespace) chosen so
  // no side of the cut becomes a sub-second word fragment: nearest break to
  // the proportional point, then nudged to absorb a word when one side would
  // otherwise be left with < 0.35 s of text. 0-length halves are dropped.
  const totalChars = cue.text.length;
  const span = cue.to - cue.from;
  if (atSeconds <= cue.from + 1e-9 || atSeconds >= cue.to - 1e-9 || span < 0.002 || totalChars === 0) return null;
  const fraction = (atSeconds - cue.from) / span;
  const proportional = Math.round(totalChars * fraction);
  let candidates = [];
  for (const pattern of [CLAUSE_BOUNDARY, SOFT_BOUNDARY, WHITESPACE_BOUNDARY]) {
    candidates = [...cue.text.matchAll(new RegExp(pattern.source, "g"))]
      .map((match) => match.index)
      .filter((index) => index > 0 && index < totalChars);
    if (candidates.length > 0) break;
  }
  let cut = proportional;
  if (candidates.length > 0) {
    cut = candidates.reduce((best, index) => (Math.abs(index - proportional) < Math.abs(best - proportional) ? index : best), candidates[0]);
    // Fragment absorption: a left fragment under 0.35 s takes its next word
    // (first break beyond the proportional point); a right fragment under
    // 0.35 s absorbs its previous word (last break before it).
    if (atSeconds - cue.from < 0.35) {
      const forward = candidates.filter((index) => index > proportional);
      if (forward.length > 0) cut = forward[0];
    } else if (cue.to - atSeconds < 0.35) {
      const backward = candidates.filter((index) => index < proportional);
      if (backward.length > 0) cut = backward[backward.length - 1];
    }
  }
  cut = Math.max(1, Math.min(totalChars - 1, cut));
  return [
    { from: cue.from, to: atSeconds, text: cue.text.slice(0, cut).trim() },
    { from: atSeconds, to: cue.to, text: cue.text.slice(cut).trim() },
  ].filter((part) => part.text !== "");
}

/**
 * Wrap one cue text into display lines of at most `maxChars` characters
 * (greedy word wrap at whitespace; CJK runs without spaces hard-split at the
 * cap). Never drops or truncates text.
 */
export function wrapCueLines(text, maxChars = SUBTITLE_MAX_CHARS_PER_LINE) {
  const raw = String(text ?? "").trim();
  if (raw === "") return [];
  const lines = [];
  for (const word of raw.split(/\s+/).filter(Boolean)) {
    let remainder = word;
    // A token longer than the cap (CJK run, long identifier) hard-splits.
    while (remainder.length > maxChars) {
      lines.push(remainder.slice(0, maxChars));
      remainder = remainder.slice(maxChars);
    }
    if (remainder === "") continue;
    const last = lines[lines.length - 1];
    if (last === undefined) lines.push(remainder);
    else if (last.length + 1 + remainder.length <= maxChars) lines[lines.length - 1] = `${last} ${remainder}`;
    else lines.push(remainder);
  }
  return lines;
}

/**
 * Build subtitle cues from whisper chunks + the timeline: cues are cut at
 * every segment boundary (frame-aligned) and at the length cap (time
 * distributed by character weight); over-cap wraps split into additional
 * cues so no cue ever renders more than two short lines. Pure, deterministic.
 *
 * @param {object} options
 * @param {Array<{ timestamp: [number|null, number|null], text: string }>} options.chunks
 * @param {Array<{ slideId: string, startFrame: number, durationFrames: number }>} options.segments
 * @param {number} options.fps
 * @param {number} options.totalFrames
 */
export function buildSubtitleCues({ chunks, segments, fps, totalFrames, maxChars = SUBTITLE_MAX_CHARS_PER_LINE * SUBTITLE_MAX_LINES }) {
  const totalSeconds = totalFrames / fps;
  const boundaries = segments.slice(1).map((segment) => (segment.startFrame ?? 0) / fps);
  let working = [];
  for (const chunk of chunks ?? []) {
    const [from, to] = chunk.timestamp ?? [null, null];
    if (typeof from !== "number" || from < 0) continue;
    const text = collapseAsrLoops(String(chunk.text ?? "")).trim();
    if (text === "") continue;
    const start = Math.min(from, totalSeconds);
    const end = Math.min(typeof to === "number" && to > from ? to : from + 2, totalSeconds);
    working.push({ from: start, to: end, text });
  }
  // Cut at every segment boundary (repeat passes until no cue straddles).
  for (const boundary of boundaries) {
    const next = [];
    for (const cue of working) {
      const parts = cutCueAt(cue, boundary);
      if (parts) next.push(...parts);
      else next.push(cue);
    }
    working = next;
  }
  // Split over-long texts; wrap each part into ≤2 short lines; parts whose
  // wrap exceeds two lines split again at the line level (time follows the
  // character weight at every split).
  const timed = [];
  const schedule = (from, to, text) => {
    const lines = wrapCueLines(text, SUBTITLE_MAX_CHARS_PER_LINE);
    if (lines.length <= SUBTITLE_MAX_LINES) {
      if (text.trim() !== "") timed.push({ from, to, lines });
      return;
    }
    const parts = splitCueText(text, maxChars);
    if (parts.length <= 1) {
      // Splitting cannot help (one unbreakable token): render the first two
      // lines and continue the rest as a follow-up cue at the same weight.
      const total = lines.length;
      const span = to - from;
      for (let index = 0; index < total; index += SUBTITLE_MAX_LINES) {
        const group = lines.slice(index, index + SUBTITLE_MAX_LINES);
        const start = from + (span * index) / total;
        const end = from + (span * (index + group.length)) / total;
        timed.push({ from: start, to: end, lines: group });
      }
      return;
    }
    const totalChars = parts.reduce((sum, part) => sum + part.length, 0);
    const span = to - from;
    let cursor = from;
    for (let index = 0; index < parts.length; index += 1) {
      const to2 = index === parts.length - 1 ? to : Math.min(to, cursor + (span * parts[index].length) / totalChars);
      schedule(cursor, to2, parts[index]);
      cursor = to2;
    }
  };
  for (const cue of working) schedule(cue.from, cue.to, cue.text);
  timed.sort((a, b) => a.from - b.from || a.to - b.to);
  // Display-time polish: whisper chunk edges rarely respect the segment grid,
  // so tiny cues (< 0.7 s) first merge into a flush neighbor (predecessor,
  // else successor) when the merge point is not a segment boundary and the
  // combined text still wraps into two short lines; any survivor stretches
  // its DISPLAY time (never its text) inside its own segment up to 1.2 s /
  // the next cue / the boundary.
  const boundariesAt = new Set(boundaries.map((boundary) => Math.round(boundary * 1000) / 1000));
  const segmentEndOf = (from) => {
    const owner = [...segments].reverse().find((segment) => from >= (segment.startFrame ?? 0) / fps - 1e-9);
    return owner ? ((owner.startFrame ?? 0) + owner.durationFrames) / fps : totalSeconds;
  };
  const rewrap = (cue) => wrapCueLines(cue.lines.join(" "), SUBTITLE_MAX_CHARS_PER_LINE);
  const merged = [];
  for (const cue of timed) {
    merged.push({ from: cue.from, to: cue.to, lines: cue.lines });
  }
  const isBoundaryPoint = (time) => boundariesAt.has(Math.round(time * 1000) / 1000);
  for (let index = merged.length - 1; index >= 0; index -= 1) {
    const cue = merged[index];
    if (cue.to - cue.from >= 0.7) continue;
    const previous = merged[index - 1];
    const next = merged[index + 1];
    if (previous && Math.abs(previous.to - cue.from) < 1e-6 && !isBoundaryPoint(cue.from)) {
      const candidate = [...previous.lines, ...cue.lines].join(" ").trim();
      const lines = wrapCueLines(candidate, SUBTITLE_MAX_CHARS_PER_LINE);
      if (lines.length <= SUBTITLE_MAX_LINES) {
        merged.splice(index - 1, 2, { from: previous.from, to: cue.to, lines });
        continue;
      }
    }
    if (next && Math.abs(cue.to - next.from) < 1e-6 && !isBoundaryPoint(cue.to)) {
      const candidate = [...cue.lines, ...next.lines].join(" ").trim();
      const lines = wrapCueLines(candidate, SUBTITLE_MAX_CHARS_PER_LINE);
      if (lines.length <= SUBTITLE_MAX_LINES) {
        merged.splice(index, 2, { from: cue.from, to: next.to, lines });
      }
    }
  }
  for (let index = 0; index < merged.length; index += 1) {
    const cue = merged[index];
    if (cue.to - cue.from >= 0.7) continue;
    const next = merged[index + 1];
    const ceiling = Math.min(
      next ? next.from : Number.POSITIVE_INFINITY,
      segmentEndOf(cue.from),
      cue.from + 1.2,
    );
    if (ceiling > cue.to + 1e-9) cue.to = Math.round(Math.min(ceiling, cue.from + 1.2) * 1000) / 1000;
  }
  return merged.map((cue, index) => ({
    index: index + 1,
    from: Math.round(cue.from * 1000) / 1000,
    to: Math.round(cue.to * 1000) / 1000,
    lines: cue.lines,
  }));
}

/**
 * Residual audience findings of the latest session with dimension "pacing" —
 * the review loop's "该停顿/切分" notes become advisory subtitle split-point
 * candidates in the srt header (v1: comments only, no forced coupling).
 */
export function loadPacingNotes(cwd, deckId) {
  const sessionPath = latestSessionPath(cwd, deckId);
  if (!sessionPath) return { session: null, notes: [] };
  try {
    const session = readSession(sessionPath);
    const notes = residualFindings(session.rounds)
      .filter((finding) => finding.dimension === "pacing")
      .map((finding) => ({
        id: finding.id,
        round: finding.round,
        frameAddress: finding.frameAddress,
        severity: finding.severity,
        comment: finding.comment,
      }));
    return { session: path.relative(cwd, sessionPath).split(path.sep).join("/"), notes };
  } catch {
    return { session: null, notes: [] };
  }
}

/**
 * The transcript cache: the deck pack's transcript.json when present AND
 * recorded against the CURRENT narration.wav bytes (sha match). Returns
 * null when absent/stale — the caller then runs a live ASR pass.
 */
export function loadPackTranscript(cwd, deckId, narrationSha) {
  const file = path.join(packDirPath(cwd, deckId), "transcript.json");
  if (!fsSync.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fsSync.readFileSync(file, "utf8"));
    if (parsed?.schema !== TRANSCRIPT_SCHEMA) return null;
    if (narrationSha !== null && parsed?.narrationWav !== narrationSha) return null;
    if (!Array.isArray(parsed?.chunks)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Live ASR pass over narration.wav (the pack's whisper path). */
export async function transcribeNarration(narrationPath) {
  const { createTranscriptionEngine } = await import("../audience/whisper.js");
  const engine = await createTranscriptionEngine();
  const { samples, sampleRate } = decodeWavPcm16(fsSync.readFileSync(narrationPath));
  const audio = resampleLinear(samples, sampleRate, 16000);
  const result = await engine.transcribe({ samples: audio, sampleRate: 16000 });
  return {
    engine: { engine: engine.engine, version: engine.engineVersion, model: engine.model, dtype: engine.dtype ?? "n/a", language: engine.language ?? "n/a" },
    chunks: result.chunks ?? [],
  };
}

/**
 * Render the SRT document: header comments (identity + the audience loop's
 * pacing notes as advisory split-point candidates) then numbered cue blocks.
 */
export function renderSrt({ deckId, cues, source, narration, fps, totalFrames, pacing }) {
  const lines = [
    `; ${SUBTITLES_SCHEMA} — subtitles for deck "${deckId}"`,
    `; source: ${source}`,
    `; narration.wav sha256 ${narration.sha256} · ${totalFrames} frames @ ${fps} fps`,
  ];
  if (pacing?.notes?.length > 0) {
    lines.push(
      "; pacing notes from the audience session (residual findings, dimension=pacing) —",
      "; advisory subtitle split-point candidates (v1: comments only):",
    );
    for (const note of pacing.notes) {
      const address = note.frameAddress ? `${note.frameAddress.slideId}@${note.frameAddress.localFrame}` : "no-address";
      lines.push(`; - R${note.round} ${note.id} ${address} [${note.severity}]: ${note.comment}`);
    }
  }
  lines.push("");
  cues.forEach((cue) => {
    lines.push(
      String(cue.index),
      `${formatSrtTimestamp(cue.from)} --> ${formatSrtTimestamp(cue.to)}`,
      ...cue.lines,
      "",
    );
  });
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n")}${cues.length > 0 ? "" : "\n"}`;
}
