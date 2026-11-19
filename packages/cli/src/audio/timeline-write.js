// M10 auditable timeline write-back for the audio creation commands.
//
// `lattice edit --timeline` refuses paths that do not exist yet (the minimal
// span locator fails fast on missing properties), and the audio creation
// commands must be able to *declare* timeline keys that a deck has never
// carried (`timeline.audio`, or `timeline.audioTracks` on a timeline deck
// without any). This module performs those declaration writes through the
// same auditable machinery as the edit loop — minimal exact-span patches,
// Content Lock gate (locked decks are always rejected with re-freeze
// guidance, matching the approved M10 flow: hand-edit + re-freeze once, then
// the commands run in idempotent asset-only mode), fresh manifest re-parse +
// timeline validation, `lattice validate` verification, rollback on any
// failure, and one provenance record per applied batch.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config/index.js";
import { deckDirPath, readLockRecord, readManifest, requireV2Manifest } from "../edit/deck-view.js";
import { buildProvenanceRecord, sha256Hex, writeProvenanceRecord } from "../edit/provenance.js";
import {
  buildPatch,
  containerAt,
  locateFieldPath,
  lineIndentation,
  lineOfOffset,
  scanSource,
  serializeJsValue,
} from "../edit/source-map.js";

const UNIT_INDENT = "  ";

// Contract refusals THROW a structured error (the audio command rolls any
// just-written asset back, then fails with the same envelope). Only
// catastrophic infrastructure failures (rollback mismatch, provenance write
// failure) exit directly from this module.
function timelineWriteFailure(payload, exitCode = 1) {
  throw Object.assign(new Error(payload.error?.message ?? "timeline audio write refused"), {
    audioPayload: payload,
    audioExitCode: exitCode,
  });
}

function findRootObjectRecord(records) {
  const objects = records.filter((record) => record.kind === "object");
  if (objects.length === 0) {
    throw Object.assign(new Error("manifest.json contains no object literal to locate fields in"), { code: "field-location-failed" });
  }
  return objects.reduce((best, record) => (record.start < best.start ? record : best));
}

/**
 * Plan the minimal insertion of one missing key into an object literal.
 * JSON manifests are 2-space formatted, so the key indent derives from the
 * container's closing brace; the patch inserts right after the last content
 * byte before the closing brace (or replaces the whole empty `{}` span).
 */
export function planObjectKeyInsert(source, containerRecord, key, value, { keyIndent } = {}) {
  const closingBrace = containerRecord.end - 1;
  if (source[closingBrace] !== "}") {
    throw Object.assign(new Error("object record does not end with a closing brace"), { code: "unbalanced-source" });
  }
  const closeLineStart = lineIndentation(source, closingBrace);
  const resolvedKeyIndent = keyIndent ?? `${closeLineStart}${UNIT_INDENT}`;
  const serialized = serializeJsValue(value, resolvedKeyIndent);
  if (containerRecord.properties.length === 0) {
    // Empty object literal: replace the whole `{...}` span with a single-key object.
    let innerEnd = closingBrace;
    while (innerEnd > containerRecord.start + 1 && /\s/.test(source[innerEnd - 1])) innerEnd -= 1;
    const openBrace = containerRecord.start;
    if (source[openBrace] !== "{") {
      throw Object.assign(new Error("object record does not start with an opening brace"), { code: "unbalanced-source" });
    }
    const replacement = `{\n${resolvedKeyIndent}"${key}": ${serialized}\n${closeLineStart}}`;
    return buildPatch(source, { valueStart: openBrace, valueEnd: containerRecord.end }, replacement);
  }
  let insertAt = closingBrace;
  while (insertAt > containerRecord.start + 1 && /[\s]/.test(source[insertAt - 1])) insertAt -= 1;
  const insertion = `,\n${resolvedKeyIndent}"${key}": ${serialized}`;
  const patched = source.slice(0, insertAt) + insertion + source.slice(insertAt);
  return {
    patched,
    replaced: "",
    span: {
      charRange: { start: insertAt, end: insertAt },
      byteRange: {
        start: Buffer.byteLength(source.slice(0, insertAt), "utf8"),
        end: Buffer.byteLength(source.slice(0, insertAt), "utf8"),
      },
      line: lineOfOffset(source, insertAt),
      column: insertAt - (source.lastIndexOf("\n", insertAt - 1) + 1) + 1,
    },
    replacedBytes: 0,
    insertedBytes: Buffer.byteLength(insertion, "utf8"),
  };
}

/**
 * Apply one auditable batch of timeline declaration writes.
 *
 * @param {object} options
 * @param {Array<{ path: string, value: unknown }>} options.edits
 *   Timeline paths (relative to `timeline.`, e.g. "audio.narration") and the
 *   exact values to write. Every edit must either land on an existing path
 *   (span replacement) or on a missing FIRST-LEVEL timeline key (minimal
 *   insertion). Values are compared structurally first: a batch where every
 *   edit is already satisfied writes nothing and returns changed: false.
 * @returns {{ changed: boolean, applied?: Array, provenance?: object }}
 */
export async function applyTimelineAudioEdits({ cwd, deckId, edits, actor, when, reason, command }) {
  if (!Array.isArray(edits) || edits.length === 0) {
    return { changed: false, applied: [] };
  }
  const config = await loadConfig(cwd);
  const deckDir = deckDirPath(cwd, config, deckId);
  if (!fs.existsSync(deckDir)) {
    timelineWriteFailure({ error: { code: "deck-not-found", message: `deck directory not found: ${deckDir}` } }, 1);
  }
  let manifest;
  try {
    manifest = requireV2Manifest(readManifest(deckDir), deckId);
  } catch (error) {
    timelineWriteFailure({ error: { code: error.code ?? "invalid-manifest", message: error.message } }, 1);
  }
  if (manifest.timeline === undefined) {
    timelineWriteFailure({
      error: {
        code: "timeline-not-declared",
        message: `deck "${deckId}" does not declare a lattice.timeline.v1; narration and bgm declarations can only be written once the deck declares one`,
      },
    }, 1);
  }
  const manifestFile = path.join(deckDir, "manifest.json");
  const relativeManifestFile = path.relative(cwd, manifestFile).split(path.sep).join("/");
  const sourceBefore = fs.readFileSync(manifestFile, "utf8");
  const sha256Before = sha256Hex(Buffer.from(sourceBefore, "utf8"));

  // Content Lock gate — before any planning or write. Locked decks take the
  // explicit owner path (hand-edit + re-freeze) exactly like the edit loop.
  const locksDir = path.resolve(cwd, ".lattice", "content-locks");
  const lockRecord = readLockRecord(locksDir, deckId);
  if (lockRecord && lockRecord.fingerprint) {
    timelineWriteFailure({
      error: {
        code: "content-lock-gate-rejected",
        message: `deck "${deckId}" is content-locked; writing the timeline audio declaration would change the frozen fingerprint ` +
          `(declare it by hand and re-freeze with "lattice lock update --deck ${deckId}", then re-run this command — the already-declared values make it idempotent)`,
      },
      gate: { contentLock: { mode: "enforced", decision: "reject", lockPath: lockRecord.lockPath } },
      zeroWrites: true,
    }, 1);
  }

  // Sequential exact-span patches over the manifest text.
  let current = sourceBefore;
  const applied = [];
  for (const edit of edits) {
    const fieldPath = `timeline.${edit.path}`;
    const records = scanSource(current);
    let target;
    try {
      target = locateFieldPath(current, records, findRootObjectRecord(records), fieldPath);
    } catch (error) {
      if (error.code !== "field-not-found") {
        timelineWriteFailure({ error: { code: error.code ?? "field-location-failed", message: error.message, file: relativeManifestFile, field: fieldPath } }, 1);
      }
      target = null;
    }
    if (target) {
      const targetText = current.slice(target.valueStart, target.valueEnd);
      let currentValue;
      try {
        currentValue = JSON.parse(targetText);
      } catch {
        currentValue = undefined;
      }
      if (jsonValuesEqual(currentValue, edit.value)) {
        applied.push({ path: edit.path, operation: "none" });
        continue;
      }
      const replacement = serializeJsValue(edit.value, lineIndentation(current, target.keyStart));
      const patch = buildPatch(current, target, replacement);
      applied.push({ path: edit.path, operation: "replace", patch, fieldPath });
      current = patch.patched;
      continue;
    }
    // Missing path: walk down to the deepest existing object container and
    // insert the missing key chain there (e.g. `audio.narration` when
    // `timeline.audio` does not exist yet inserts the whole nested value
    // into the timeline object; when `timeline.audio` exists without a
    // narration key, only the narration key is inserted into it).
    const segments = String(edit.path).split(".").map((segment) => segment.trim()).filter(Boolean);
    let container = null;
    let missingFrom = segments.length - 1;
    for (let depth = 1; depth < segments.length; depth += 1) {
      const prefix = `timeline.${segments.slice(0, depth).join(".")}`;
      let prefixTarget;
      const prefixRecords = scanSource(current);
      try {
        prefixTarget = locateFieldPath(current, prefixRecords, findRootObjectRecord(prefixRecords), prefix);
      } catch {
        missingFrom = depth - 1;
        break;
      }
      const prefixContainer = containerAt(prefixRecords, prefixTarget.valueStart, prefixTarget.valueEnd);
      if (!prefixContainer || prefixContainer.kind !== "object") {
        timelineWriteFailure({
          error: {
            code: "timeline-container-not-object",
            message: `"${prefix}" is not an object literal; cannot create "timeline.${edit.path}" inside it`,
            file: relativeManifestFile,
            field: fieldPath,
          },
        }, 1);
      }
      container = prefixContainer.record;
    }
    if (!container) {
      // No deeper prefix existed: the key is inserted straight into the
      // timeline object (guarded earlier: the deck declares one).
      const timelineRecords = scanSource(current);
      const timelineTarget = locateFieldPath(current, timelineRecords, findRootObjectRecord(timelineRecords), "timeline");
      const timelineContainer = containerAt(timelineRecords, timelineTarget.valueStart, timelineTarget.valueEnd);
      if (!timelineContainer || timelineContainer.kind !== "object") {
        timelineWriteFailure({
          error: { code: "timeline-not-an-object", message: `deck "timeline" declaration is not an object literal; cannot insert "${edit.path}"`, file: relativeManifestFile },
        }, 1);
      }
      container = timelineContainer.record;
    }
    const insertKey = segments[missingFrom];
    let insertValue = edit.value;
    for (let depth = segments.length - 1; depth > missingFrom; depth -= 1) {
      insertValue = { [segments[depth]]: insertValue };
    }
    const patch = planObjectKeyInsert(current, container, insertKey, insertValue, {
      keyIndent: container.properties.length > 0
        ? lineIndentation(current, container.properties[0].keyStart)
        : undefined,
    });
    applied.push({ path: edit.path, operation: "insert", patch, fieldPath });
    current = patch.patched;
  }

  if (applied.every((entry) => entry.operation === "none")) {
    return { changed: false, applied };
  }

  let mutatedManifest;
  try {
    mutatedManifest = JSON.parse(current);
  } catch (error) {
    timelineWriteFailure({ error: { code: "patched-manifest-invalid", message: `patched manifest.json is not valid JSON: ${error.message}` } }, 1);
  }

  // Same pre-write value validation the edit loop applies (declaration
  // contract, preset catalog, voice catalog, full timeline cross-check).
  const { validateTimelineValue } = await import("../commands/edit.js");
  const valueValidation = await validateTimelineValue({ cwd, config, deckId, mutatedManifest });
  if (!valueValidation.ok) {
    timelineWriteFailure({
      error: {
        code: "invalid-timeline-value",
        message: "timeline audio declaration rejected before write (timeline contract / voice catalog)",
        details: { errors: valueValidation.errors },
        file: relativeManifestFile,
      },
    }, 1);
  }

  const sha256After = sha256Hex(Buffer.from(current, "utf8"));
  fs.writeFileSync(manifestFile, current, "utf8");
  const written = fs.readFileSync(manifestFile, "utf8");
  if (sha256Hex(Buffer.from(written, "utf8")) !== sha256After) {
    rollback(manifestFile, sourceBefore, sha256Before);
    timelineWriteFailure({ error: { code: "write-mismatch", message: "post-write verification of manifest.json bytes failed" } }, 1);
  }

  // Verification loop; any failure rolls the manifest back byte-exact.
  const validate = runValidateSubprocess(cwd, deckId);
  if (validate.exitCode !== 0) {
    rollback(manifestFile, sourceBefore, sha256Before);
    timelineWriteFailure({
      error: { code: "validate-failed", message: `lattice validate --deck ${deckId} exited ${validate.exitCode}`, details: { stdout: validate.stdout.slice(-4000), stderr: validate.stderr.slice(-4000) } },
      rolledBack: true,
      inputs: { file: relativeManifestFile, sha256: sha256Before },
    }, 1);
  }

  const sourceMap = {
    file: relativeManifestFile,
    slideObject: null,
    target: {
      kind: "timeline-audio-declaration",
      fieldPath: applied.map((entry) => entry.fieldPath ?? `timeline.${entry.path}`).join(", "),
      ...(applied.length === 1 && applied[0].patch ? {
        charRange: applied[0].patch.span.charRange,
        byteRange: applied[0].patch.span.byteRange,
        line: applied[0].patch.span.line,
        column: applied[0].patch.span.column,
      } : {}),
    },
    replacedBytes: applied.reduce((sum, entry) => sum + (entry.patch?.replacedBytes ?? 0), 0),
    insertedBytes: applied.reduce((sum, entry) => sum + (entry.patch?.insertedBytes ?? 0), 0),
    files: applied.filter((entry) => entry.patch).map((entry) => ({
      file: relativeManifestFile,
      operation: entry.operation,
      fieldPath: entry.fieldPath,
      charRange: entry.patch.span.charRange,
      byteRange: entry.patch.span.byteRange,
      line: entry.patch.span.line,
      column: entry.patch.span.column,
      replacedBytes: entry.patch.replacedBytes,
      insertedBytes: entry.patch.insertedBytes,
      sha256Before,
      sha256After,
    })),
  };

  const provenanceRecord = buildProvenanceRecord({
    command,
    actor,
    when,
    deck: deckId,
    slide: null,
    field: applied.map((entry) => entry.fieldPath ?? `timeline.${entry.path}`).join(", "),
    reason,
    value: Object.fromEntries(edits.map((edit) => [edit.path, edit.value])),
    sourceMap,
    inputs: { file: relativeManifestFile, sha256: sha256Before },
    outputs: { file: relativeManifestFile, sha256: sha256After },
    gate: {
      contentLock: { mode: "absent", decision: "allow", note: "no stored content lock for this deck" },
      validate: { exitCode: 0, pass: true },
    },
  });
  let provenancePath;
  try {
    provenancePath = writeProvenanceRecord(cwd, provenanceRecord);
  } catch (error) {
    timelineWriteFailure({ error: { code: "provenance-write-failed", message: error.message } }, 2);
  }

  return {
    changed: true,
    applied,
    manifest: mutatedManifest,
    provenance: { path: path.relative(cwd, provenancePath).split(path.sep).join("/") },
    inputs: { file: relativeManifestFile, sha256: sha256Before },
    outputs: { file: relativeManifestFile, sha256: sha256After },
  };
}

function rollback(manifestFile, sourceBefore, sha256Before) {
  fs.writeFileSync(manifestFile, sourceBefore, "utf8");
  const restored = sha256Hex(fs.readFileSync(manifestFile));
  if (restored !== sha256Before) {
    process.stderr.write(`${JSON.stringify({ ok: false, command: "audio", error: { code: "rollback-mismatch", message: "rollback did not restore the original manifest bytes" } })}\n`);
    process.exit(2);
  }
}

function runValidateSubprocess(cwd, deckId) {
  const cliEntry = fileURLToPath(new URL("../index.js", import.meta.url));
  const result = spawnSync(process.execPath, [cliEntry, "validate", "--deck", deckId], {
    cwd,
    encoding: "utf8",
    timeout: 300000,
  });
  return { exitCode: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

// JSON-semantics equality (key order ignored) — the same rule the edit loop
// applies for no-op detection.
function jsonValuesEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => jsonValuesEqual(item, b[index]));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return keysA.length === keysB.length && keysA.every((key) => jsonValuesEqual(a[key], b[key]));
  }
  return false;
}
