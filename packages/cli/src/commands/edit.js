// lattice edit — agent-facing targeted edit of canonical deck source.
//
// Contract (M6, prompt-driven authoring):
//   - Locate content by stable slide id + field path, never by line number.
//   - Apply the minimal possible source change (one value span replacement).
//   - Refuse anything that is not exactly locatable (fail-fast, zero writes).
//   - Enforce the Content Lock gate: on any deck with a stored content lock,
//     an edit whose semantic fingerprint would change is rejected before a
//     single byte is written.
//   - After an applied edit, automatically run the verification loop:
//     re-import the deck (fresh module pipeline), recompute the fingerprint,
//     then `lattice validate`; any failure rolls the file back byte-exact.
//   - Write a provenance record for every applied edit (who/when/input hash/
//     output hash/byte-range source map).
//
// All output is JSON: success/dry-run reports on stdout, failures as a JSON
// error object on stderr. Exit codes: 0 applied or dry-run-allowed, 1 the
// edit was refused (gate, no-op, not locatable, validation failure), 2
// configuration/infrastructure failure.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../config/index.js";
import {
  DEFAULT_MIGRATION_DIR,
  deckDirPath,
  deckFingerprint,
  readLockRecord,
  readManifest,
  requireV2Manifest,
  resolveIdentityManifest,
  resolveLocksDir,
  withDeckView,
} from "../edit/deck-view.js";
import { buildProvenanceRecord, sha256Hex, writeProvenanceRecord } from "../edit/provenance.js";
import {
  buildPatch,
  findSlideObject,
  jsonValuesEqual,
  lineIndentation,
  lineOfOffset,
  locateFieldPath,
  scanSource,
  serializeJsValue,
} from "../edit/source-map.js";
import {
  assertDerivedStructureShape,
  crossCheckSlidesSource,
  planNotesInsert,
  planNotesRemove,
  planRouteInsert,
  planRouteRemove,
  planRouteReorder,
  planSlideInsert,
  planSlideRemove,
  planSlideReorder,
} from "../edit/structure.js";
import { validateDeckManifestV2, verifyContentLock } from "@55aaseclab/lattice-runtime";

const EDIT_USAGE = `Usage: lattice edit --deck <id> --slide <slideId> --field <path> --value <json>
                      [--dry-run] [--reason <text>] [--actor <id>] [--timestamp <iso>]
                      [--locks-dir <dir>] [--migration-dir <dir>] [--provenance-dir <dir>] [--help]

       lattice edit --deck <id> --structure add --slide <newSlideId>
                      [--after <slideId>] [--value <json>] [--notes <text>] [shared options]
       lattice edit --deck <id> --structure remove --slide <slideId> [shared options]
       lattice edit --deck <id> --structure reorder --value <json-id-array> [shared options]

Perform one minimal, auditable edit to a deck's canonical content source
(decks/<id>/content.js): the object literal carrying the stable slide id is
located, the dot-separated field path is resolved inside it, and exactly the
target value span is replaced. Numeric path segments address array elements
(e.g. timeline.challenges.0.challenge).

The value must be a single JSON value (strings need quotes: --value '"New"').

Gate: decks with a stored Content Lock reject any edit that would change
their semantic fingerprint (zero writes). To evolve locked content
deliberately, edit the source by hand and re-freeze with
"lattice lock update --deck <id>".

After an applied edit the verification loop runs automatically: fresh deck
re-import, fingerprint recomputation, and "lattice validate --deck <id>".
Any verification failure rolls the source file back byte-exact.

--dry-run resolves and gates the edit without writing anything: exit 0 when
the edit would apply, exit 1 when it would be refused.

M7 timeline mode: "lattice edit --deck <id> --timeline <path> --value <json>"
runs the same minimal, auditable loop against the deck-level timeline
declaration in the deck's manifest.json (lattice.timeline.v1): animation
presets and parameters, stop frames, rhythm, audio tracks — same gate,
provenance, source map, and validate loop as content edits, with value
validation against the theme preset catalog before anything is written.
--timeline and --slide/--field are mutually exclusive.

M9 structure mode: "lattice edit --deck <id> --structure add|remove|reorder"
performs slide-level structural edits on decks in the derived shape (slide
order, ids, layouts, and stop ids owned by the content.js slides array).
"add" inserts a new slide (--slide <newId>, optional --after <slideId>, the
content fields as --value JSON, optional --notes text); "remove" deletes a
slide and its note; "reorder" applies the full id order from --value. Every
touched file (content.js, manifest.json routes.main, notes.js) is patched as
one exact span, the multi-file source map lands in provenance, and the same
gate/validate loop applies: decks with a stored Content Lock reject every
structural edit with zero writes.

Output: one JSON object (stdout on success, stderr on refusal). Exit codes:
0 applied / dry-run allowed; 1 refused (gate, no-op, not locatable,
validation failure); 2 configuration or infrastructure failure.

Provenance: every applied edit writes .lattice/provenance/<record>.json with
actor, instant, input/output hashes, and the edit→file→byte-range source map.`;

function fail(payload, exitCode = 1) {
  process.stderr.write(`${JSON.stringify({ ok: false, command: "edit", ...payload }, null, 2)}\n`);
  process.exit(exitCode);
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify({ ok: true, command: "edit", ...payload }, null, 2)}\n`);
}

function exitCodeForErrorCode(code) {
  if (["config-not-found", "template-not-found", "unbalanced-source"].includes(code)) return 2;
  return 1;
}

export async function editCommand({ args, cwd = process.cwd() }) {
  if (args.help) {
    console.log(EDIT_USAGE);
    return;
  }

  // M9: --structure performs slide-level structural edits (add/remove/reorder)
  // through the same auditable loop. Mutually exclusive with the timeline and
  // content-edit modes; every existing content-edit behavior is untouched.
  if (args.structure !== undefined) {
    if (args.timeline !== undefined) {
      fail({
        error: {
          code: "mutually-exclusive-arguments",
          message: "--structure and --timeline target different deck surfaces; use one mode, not both.",
        },
      }, 1);
    }
    await structureEditCommand({ args, cwd });
    return;
  }

  // M7: --timeline performs the same auditable loop against the deck-level
  // lattice.timeline.v1 declaration in manifest.json (animation presets,
  // stop frames, rhythm, audio tracks). Mutually exclusive with the content
  // edit mode; every existing content-edit behavior is untouched.
  if (args.timeline !== undefined) {
    await timelineEditCommand({ args, cwd });
    return;
  }

  for (const required of ["deck", "slide", "field", "value"]) {
    if (!args[required] || typeof args[required] !== "string") {
      fail({ error: { code: "missing-argument", message: `--${required} is required` } }, 2);
    }
  }

  let config;
  try {
    config = await loadConfig(cwd);
  } catch (error) {
    fail({ error: { code: "config-not-found", message: error.message } }, 2);
  }

  const deckId = args.deck;
  const slideId = args.slide;
  const fieldPath = args.field;
  const dryRun = Boolean(args["dry-run"]);
  const reason = typeof args.reason === "string" ? args.reason : null;
  const actor = typeof args.actor === "string" && args.actor.trim() !== "" ? args.actor.trim() : "unknown";
  const when = resolveTimestamp(args.timestamp);
  const locksDir = resolveLocksDir(cwd, { locksDir: args["locks-dir"] });
  const migrationDir = path.resolve(cwd, args["migration-dir"] ?? DEFAULT_MIGRATION_DIR);

  let value;
  try {
    value = JSON.parse(args.value);
  } catch (error) {
    fail({
      error: {
        code: "invalid-value",
        message: `--value must be a single JSON value: ${error.message}`,
        hint: 'strings need quotes, e.g. --value \'"New title"\'',
      },
    }, 1);
  }

  const deckDir = deckDirPath(cwd, config, deckId);
  if (!fs.existsSync(deckDir)) {
    fail({ error: { code: "deck-not-found", message: `deck directory not found: ${deckDir}` } }, 1);
  }
  let manifest;
  try {
    manifest = requireV2Manifest(readManifest(deckDir), deckId);
  } catch (error) {
    fail({ error: { code: error.code ?? "invalid-manifest", message: error.message } }, exitCodeForErrorCode(error.code));
  }
  const contentFile = path.resolve(deckDir, manifest.entry?.content ?? "./content.js");
  if (!fs.existsSync(contentFile)) {
    fail({ error: { code: "content-not-found", message: `deck content source not found: ${contentFile}` } }, 2);
  }
  const relativeContentFile = path.relative(cwd, contentFile).split(path.sep).join("/");

  const sourceBefore = fs.readFileSync(contentFile, "utf8");
  const sha256Before = sha256Hex(Buffer.from(sourceBefore, "utf8"));

  // 1. Locate the slide object and the field span in the canonical source.
  let slideMatch;
  try {
    slideMatch = findSlideObject(sourceBefore, scanSource(sourceBefore), slideId);
  } catch (error) {
    fail({ error: { code: error.code ?? "slide-location-failed", message: error.message, file: relativeContentFile } }, exitCodeForErrorCode(error.code));
  }
  let target;
  try {
    target = locateFieldPath(sourceBefore, scanSource(sourceBefore), slideMatch.record, fieldPath);
  } catch (error) {
    fail({
      error: {
        code: error.code ?? "field-location-failed",
        message: error.message,
        file: relativeContentFile,
        slide: slideId,
        field: fieldPath,
      },
    }, exitCodeForErrorCode(error.code));
  }
  const targetText = sourceBefore.slice(target.valueStart, target.valueEnd);

  // 2. Compare with the current value (JSON semantics, key order ignored).
  let currentValue;
  try {
    currentValue = JSON.parse(targetText);
  } catch {
    currentValue = undefined;
  }
  if (currentValue !== undefined && jsonValuesEqual(currentValue, value)) {
    fail({
      error: {
        code: "no-op-edit",
        message: `field "${fieldPath}" already carries this value; refusing a no-op edit`,
        file: relativeContentFile,
        slide: slideId,
        field: fieldPath,
      },
    }, 1);
  }

  // 3. Build the patch and the mutated in-memory content.
  const replacement = serializeJsValue(value, lineIndentation(sourceBefore, target.keyStart));
  const patch = buildPatch(sourceBefore, target, replacement);
  const sha256After = sha256Hex(Buffer.from(patch.patched, "utf8"));

  const identityManifest = resolveIdentityManifest({ cwd, deckId, liveManifest: manifest, migrationDir });
  const lockRecord = readLockRecord(locksDir, deckId);

  // 4. Content Lock gate — computed BEFORE any write.
  const gate = await runGate({ cwd, config, deckId, slideId, fieldPath, identityManifest, lockRecord, value, dryRun });

  const sourceMap = {
    file: relativeContentFile,
    slideObject: {
      charRange: { start: slideMatch.record.start, end: slideMatch.record.end },
      line: lineOfOffset(sourceBefore, slideMatch.record.start),
    },
    target: {
      kind: "property-value",
      fieldPath,
      charRange: patch.span.charRange,
      byteRange: patch.span.byteRange,
      line: patch.span.line,
      column: patch.span.column,
    },
    replacedBytes: patch.replacedBytes,
    insertedBytes: patch.insertedBytes,
  };

  if (dryRun) {
    emit({
      dryRun: true,
      deck: deckId,
      slide: slideId,
      field: fieldPath,
      reason,
      actor,
      when,
      sourceMap,
      inputs: { file: relativeContentFile, sha256: sha256Before },
      outputs: { file: relativeContentFile, sha256: sha256After },
      gate,
      wouldWrite: [relativeContentFile],
    });
    return;
  }

  // 5. Apply the single-span replacement.
  fs.writeFileSync(contentFile, patch.patched, "utf8");
  const written = fs.readFileSync(contentFile, "utf8");
  if (sha256Hex(Buffer.from(written, "utf8")) !== sha256After) {
    fail({ error: { code: "write-mismatch", message: "post-write verification of file bytes failed" } }, 1);
  }

  // 6. Verification loop; any failure rolls the edit back byte-exact.
  let postVerify;
  try {
    postVerify = await runPostWriteVerification({ cwd, config, deckId, slideId, fieldPath, value, identityManifest, lockRecord });
  } catch (error) {
    rollback(contentFile, sourceBefore, sha256Before);
    fail({
      error: { code: "post-verify-failed", message: error.message },
      rolledBack: true,
      inputs: { file: relativeContentFile, sha256: sha256Before },
    }, 1);
  }
  if (!postVerify.ok) {
    rollback(contentFile, sourceBefore, sha256Before);
    fail({
      error: { code: postVerify.code, message: postVerify.message },
      rolledBack: true,
      details: postVerify.details ?? null,
      inputs: { file: relativeContentFile, sha256: sha256Before },
    }, 1);
  }

  // 7. Provenance record.
  const provenanceRecord = buildProvenanceRecord({
    command: "edit",
    actor,
    when,
    deck: deckId,
    slide: slideId,
    field: fieldPath,
    reason,
    value,
    sourceMap,
    inputs: {
      file: relativeContentFile,
      sha256: sha256Before,
      compositeHash: gate.fingerprintBefore?.compositeHash ?? null,
    },
    outputs: {
      file: relativeContentFile,
      sha256: sha256After,
      compositeHash: postVerify.fingerprint?.compositeHash ?? null,
    },
    gate: {
      contentLock: gate.summary,
      validate: postVerify.validate,
      fingerprintAfter: postVerify.fingerprint,
    },
  });
  let provenancePath;
  try {
    provenancePath = writeProvenanceRecord(cwd, provenanceRecord);
  } catch (error) {
    fail({ error: { code: "provenance-write-failed", message: error.message } }, 2);
  }

  emit({
    dryRun: false,
    deck: deckId,
    slide: slideId,
    field: fieldPath,
    reason,
    actor,
    when,
    sourceMap,
    inputs: { file: relativeContentFile, sha256: sha256Before },
    outputs: { file: relativeContentFile, sha256: sha256After },
    gate: { contentLock: gate.summary, validate: postVerify.validate },
    fingerprint: postVerify.fingerprint,
    provenance: { schema: provenanceRecord.schema, path: path.relative(cwd, provenancePath).split(path.sep).join("/") },
  });
}

function resolveTimestamp(input) {
  const candidate = typeof input === "string" && input.trim() !== "" ? input.trim() : new Date().toISOString();
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) {
    fail({ error: { code: "invalid-timestamp", message: `--timestamp must be an ISO instant, got ${JSON.stringify(input)}` } }, 2);
  }
  return parsed.toISOString();
}

function rollback(contentFile, sourceBefore, sha256Before) {
  fs.writeFileSync(contentFile, sourceBefore, "utf8");
  const restored = sha256Hex(fs.readFileSync(contentFile));
  if (restored !== sha256Before) {
    process.stderr.write(`${JSON.stringify({ ok: false, command: "edit", error: { code: "rollback-mismatch", message: "rollback did not restore the original bytes" } })}\n`);
    process.exit(2);
  }
}

async function runGate({ cwd, config, deckId, slideId, fieldPath, identityManifest, lockRecord, value, dryRun }) {
  if (!lockRecord || !lockRecord.fingerprint) {
    return {
      summary: { mode: "absent", decision: "allow", note: "no stored content lock for this deck" },
      fingerprintBefore: null,
    };
  }

  const reject = (code, message, extra = {}) => {
    fail({
      error: { code, message, deck: deckId, slide: slideId, field: fieldPath, ...extra },
      gate: { contentLock: { mode: "enforced", decision: "reject", lockPath: lockRecord.lockPath } },
      dryRun,
      zeroWrites: true,
    }, 1);
  };

  const { view } = await withDeckView(cwd, config, deckId, () => {});
  const fingerprintBefore = deckFingerprint(view, identityManifest);
  const beforeVerify = verifyContentLock(fingerprintBefore, lockRecord.fingerprint);
  if (!beforeVerify.ok) {
    reject("deck-drifted-from-lock", `deck "${deckId}" no longer verifies against its stored content lock (${beforeVerify.reason}); refusing to edit on top of drift`, {
      diffs: beforeVerify.diffs ?? null,
    });
  }

  const slide = resolveSlideValue(view.content, slideId);
  const mutated = structuredClone(slide.value);
  if (!applyValueAtPath(mutated, fieldPath, value)) {
    reject("field-not-found-in-content", `field path "${fieldPath}" could not be resolved inside the in-memory content of slide "${slideId}"`);
  }
  slide.writeBack(mutated);
  const fingerprintAfter = deckFingerprint({ ...view }, identityManifest);
  const afterVerify = verifyContentLock(fingerprintAfter, lockRecord.fingerprint);
  if (afterVerify.ok) {
    // Fail closed: a stored lock whose fingerprint survives a real value
    // change must never let an edit through.
    reject("gate-inconclusive", "content lock verification did not detect the value change; refusing to proceed", {});
  }
  reject("content-lock-gate-rejected", `deck "${deckId}" is content-locked; this edit would change the frozen fingerprint`, {
    diffs: afterVerify.diffs ?? null,
    lockPath: lockRecord.lockPath,
  });
}

// Locate the in-memory object carrying the stable slide id — the same rule
// the source locator applies to the file: canonical shape is an object with a
// direct `id` property; keyed shape (slide id as a key of the root content
// object) is the conservative fallback. Returns { value, writeBack } so the
// mutated slide can be planted back into the exact container it came from.
function resolveSlideValue(content, slideId) {
  const failSlide = (code, message) => fail({
    error: { code, message, slide: slideId },
  }, 1);

  let idMatch = null;
  let idMatchCount = 0;
  const visit = (node, parent, key) => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, node, index));
      return;
    }
    if (Object.prototype.hasOwnProperty.call(node, "id") && node.id === slideId) {
      idMatchCount += 1;
      if (!idMatch) idMatch = { value: node, parent, key };
    }
    for (const [childKey, childValue] of Object.entries(node)) {
      visit(childValue, node, childKey);
    }
  };
  visit(content, null, null);
  if (idMatchCount > 1) {
    failSlide("slide-ambiguous-in-content", `id "${slideId}" matches ${idMatchCount} objects in the deck content; a targeted edit requires a unique slide id`);
  }
  if (idMatch) {
    return {
      value: idMatch.value,
      writeBack: (nextValue) => {
        idMatch.parent[idMatch.key] = nextValue;
      },
    };
  }
  if (
    content !== null && typeof content === "object" && !Array.isArray(content) &&
    Object.prototype.hasOwnProperty.call(content, slideId) &&
    content[slideId] !== null && typeof content[slideId] === "object" && !Array.isArray(content[slideId])
  ) {
    return {
      value: content[slideId],
      writeBack: (nextValue) => {
        content[slideId] = nextValue;
      },
    };
  }
  failSlide("slide-not-found-in-content", `no object with id "${slideId}" exists in the deck content`);
}

// Apply a dot path to a plain object; numeric segments address array indices.
function applyValueAtPath(root, fieldPath, value) {
  const segments = String(fieldPath).split(".").map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) return false;
  let cursor = root;
  for (let depth = 0; depth < segments.length - 1; depth += 1) {
    const segment = segments[depth];
    cursor = descend(cursor, segment);
    if (cursor === undefined) return false;
  }
  const last = segments[segments.length - 1];
  if (Array.isArray(cursor)) {
    const index = Number(last);
    if (!Number.isInteger(index) || index < 0 || index >= cursor.length) return false;
    cursor[index] = value;
    return true;
  }
  if (cursor !== null && typeof cursor === "object" && Object.prototype.hasOwnProperty.call(cursor, last)) {
    cursor[last] = value;
    return true;
  }
  return false;
}

function descend(cursor, segment) {
  if (Array.isArray(cursor)) {
    const index = Number(segment);
    if (!Number.isInteger(index) || index < 0 || index >= cursor.length) return undefined;
    return cursor[index];
  }
  if (cursor !== null && typeof cursor === "object" && Object.prototype.hasOwnProperty.call(cursor, segment)) {
    return cursor[segment];
  }
  return undefined;
}

async function runPostWriteVerification({ cwd, config, deckId, slideId, fieldPath, value, identityManifest, lockRecord }) {
  // Fresh deck view from the files just written (new module pipeline, no
  // stale module cache).
  const { view } = await withDeckView(cwd, config, deckId, () => {});
  const slide = resolveSlideValue(view.content, slideId);
  if (!applyValueAtPathCheck(slide.value, fieldPath, value)) {
    return { ok: false, code: "post-write-content-mismatch", message: `re-imported content does not carry the edited value at "${fieldPath}"` };
  }

  const fingerprint = deckFingerprint(view, identityManifest);
  if (lockRecord?.fingerprint) {
    const verify = verifyContentLock(fingerprint, lockRecord.fingerprint);
    if (!verify.ok) {
      return { ok: false, code: "content-lock-verify-failed", message: "content lock verification failed after write", details: verify };
    }
  }

  const validate = await runValidateSubprocess(cwd, deckId);
  if (validate.exitCode !== 0) {
    return {
      ok: false,
      code: "validate-failed",
      message: `lattice validate --deck ${deckId} exited ${validate.exitCode}`,
      details: { stdout: validate.stdout.slice(-4000), stderr: validate.stderr.slice(-4000) },
    };
  }
  return { ok: true, fingerprint, validate: { exitCode: 0, pass: true } };
}

function applyValueAtPathCheck(content, fieldPath, value) {
  const segments = String(fieldPath).split(".").map((segment) => segment.trim()).filter(Boolean);
  let cursor = content;
  let parent = null;
  let last = null;
  for (const segment of segments) {
    parent = cursor;
    last = segment;
    cursor = descend(cursor, segment);
    if (cursor === undefined) return false;
  }
  if (parent === null) return false;
  if (Array.isArray(parent)) {
    const index = Number(last);
    return jsonValuesEqual(parent[index], value);
  }
  return jsonValuesEqual(parent[last], value);
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

// ---- M7 timeline mode -------------------------------------------------------
//
// The same auditable edit loop as content edits, applied to the deck-level
// lattice.timeline.v1 declaration in manifest.json. Existing content-edit
// behavior is untouched.

function findRootObjectRecord(records) {
  const objects = records.filter((record) => record.kind === "object");
  if (objects.length === 0) {
    throw Object.assign(new Error("manifest.json contains no object literal to locate fields in"), { code: "field-location-failed" });
  }
  return objects.reduce((best, record) => (record.start < best.start ? record : best));
}

/**
 * Validate every animation declaration inside a mutated timeline against the
 * theme preset catalog (M7 1b: illegal presets/parameters are refused before
 * any write), then re-validate the whole deck timeline against its slides.
 * M10: narration declarations are additionally checked against the pinned
 * kokoro voice catalog (`lattice audio voices`), so an illegal voice is
 * rejected before anything is written. Exported for the audio creation
 * commands, which write timeline declarations through the same validation.
 */
export async function validateTimelineValue({ cwd, config, deckId, mutatedManifest }) {
  const errors = [];
  const { validateTimelineDeclaration } = await import("@55aaseclab/lattice-runtime/timeline");
  const { validateStopRevealAnimation } = await import("@55aaseclab/lattice-runtime/themes/simple-light/presets");
  const timeline = mutatedManifest?.timeline;
  if (timeline !== undefined) {
    errors.push(...validateTimelineDeclaration(timeline).errors.map((error) => error.message));
    const animations = [];
    if (timeline.defaults?.animation !== undefined) animations.push(["timeline.defaults.animation", timeline.defaults.animation]);
    for (const [slideId, entry] of Object.entries(timeline.slides ?? {})) {
      if (entry?.animation !== undefined) animations.push([`timeline.slides.${slideId}.animation`, entry.animation]);
    }
    for (const [label, animation] of animations) {
      const report = validateStopRevealAnimation(animation, { label });
      errors.push(...report.errors);
    }
    if (timeline.audio?.narration?.voice !== undefined) {
      // V2.0.25: the voice catalog is engine-scoped — the narration engine
      // field (default "kokoro") selects which catalog validates the voice.
      const engine = timeline.audio.narration.engine ?? "kokoro";
      if (engine === "piper") {
        const { isKnownPiperVoice } = await import("../audio/piper.js");
        if (!isKnownPiperVoice(timeline.audio.narration.voice)) {
          errors.push(`timeline.audio.narration.voice ${JSON.stringify(timeline.audio.narration.voice)} is not a provisioned piper voice; pick one from "lattice audio voices"`);
        }
      } else {
        const { isKnownNarrationVoice } = await import("../audio/kokoro.js");
        if (!(await isKnownNarrationVoice(timeline.audio.narration.voice))) {
          errors.push(`timeline.audio.narration.voice ${JSON.stringify(timeline.audio.narration.voice)} is not a kokoro voice; pick one from "lattice audio voices"`);
        }
      }
    }
  }
  const manifestReport = validateDeckManifestV2(mutatedManifest, { expectedId: deckId });
  errors.push(...manifestReport.errors.map((error) => `[${error.type}] ${error.element ?? ""}: ${error.message}`));
  if (errors.length > 0 || timeline === undefined) {
    return { ok: errors.length === 0, errors };
  }
  // Full cross-check (stop ids, frames, reveal markers) against the deck's
  // real slide definitions through the project module pipeline.
  const { resolveTimeline } = await import("@55aaseclab/lattice-runtime/timeline");
  const deckDir = deckDirPath(cwd, config, deckId);
  const entrySlides = mutatedManifest.entry?.slides;
  if (typeof entrySlides === "string" && entrySlides !== "") {
    const { createProjectModuleLoader } = await import("../deck-v2/project-module-loader.js");
    const loader = await createProjectModuleLoader(cwd);
    try {
      const module = await loader.load(path.resolve(deckDir, entrySlides));
      const slideDefinitions = module?.slideDefinitions;
      if (Array.isArray(slideDefinitions)) {
        const resolution = resolveTimeline({
          manifest: mutatedManifest,
          slides: slideDefinitions,
          validateAnimation: (animation, options) => {
            const report = validateStopRevealAnimation(animation, options);
            return { ...report, errors: report.errors.map((message) => ({ type: "invalid-animation", message })) };
          },
        });
        if (!resolution.ok) errors.push(...resolution.errors.map((error) => error.message));
      }
    } catch (error) {
      errors.push(`cannot cross-check the timeline against slide definitions: ${error.message}`);
    } finally {
      await loader.close();
    }
  }
  return { ok: errors.length === 0, errors };
}

async function timelineEditCommand({ args, cwd }) {
  const timelinePath = args.timeline;
  if (args.slide !== undefined || args.field !== undefined) {
    fail({
      error: {
        code: "mutually-exclusive-arguments",
        message: "--timeline targets the deck-level timeline in manifest.json; --slide/--field target content.js. Use one mode, not both.",
      },
    }, 1);
  }
  if (typeof timelinePath !== "string" || timelinePath.trim() === "") {
    fail({ error: { code: "missing-argument", message: "--timeline requires a dot-separated path into the deck's timeline declaration" } }, 2);
  }

  let config;
  try {
    config = await loadConfig(cwd);
  } catch (error) {
    fail({ error: { code: "config-not-found", message: error.message } }, 2);
  }

  let value;
  try {
    value = JSON.parse(args.value);
  } catch (error) {
    fail({
      error: {
        code: "invalid-value",
        message: `--value must be a single JSON value: ${error.message}`,
        hint: 'strings need quotes, e.g. --value \'"rise"\'',
      },
    }, 1);
  }

  const deckId = args.deck;
  const dryRun = Boolean(args["dry-run"]);
  const reason = typeof args.reason === "string" ? args.reason : null;
  const actor = typeof args.actor === "string" && args.actor.trim() !== "" ? args.actor.trim() : "unknown";
  const when = resolveTimestamp(args.timestamp);
  const locksDir = resolveLocksDir(cwd, { locksDir: args["locks-dir"] });
  const migrationDir = path.resolve(cwd, args["migration-dir"] ?? DEFAULT_MIGRATION_DIR);

  const deckDir = deckDirPath(cwd, config, deckId);
  if (!fs.existsSync(deckDir)) {
    fail({ error: { code: "deck-not-found", message: `deck directory not found: ${deckDir}` } }, 1);
  }
  let manifest;
  try {
    manifest = requireV2Manifest(readManifest(deckDir), deckId);
  } catch (error) {
    fail({ error: { code: error.code ?? "invalid-manifest", message: error.message } }, exitCodeForErrorCode(error.code));
  }
  const manifestFile = path.join(deckDir, "manifest.json");
  const relativeManifestFile = path.relative(cwd, manifestFile).split(path.sep).join("/");

  if (manifest.timeline === undefined) {
    fail({
      error: {
        code: "timeline-not-declared",
        message: `deck "${deckId}" does not declare a lattice.timeline.v1 in manifest.json; timeline values can only be edited once the deck declares one`,
      },
    }, 1);
  }

  const sourceBefore = fs.readFileSync(manifestFile, "utf8");
  const sha256Before = sha256Hex(Buffer.from(sourceBefore, "utf8"));

  // 1. Locate the exact value span in manifest.json.
  let target;
  try {
    const records = scanSource(sourceBefore);
    target = locateFieldPath(sourceBefore, records, findRootObjectRecord(records), `timeline.${timelinePath}`);
  } catch (error) {
    fail({
      error: {
        code: error.code ?? "field-location-failed",
        message: error.message,
        file: relativeManifestFile,
        field: `timeline.${timelinePath}`,
      },
    }, exitCodeForErrorCode(error.code));
  }
  const targetText = sourceBefore.slice(target.valueStart, target.valueEnd);

  // 2. No-op refusal, exactly like content edits.
  let currentValue;
  try {
    currentValue = JSON.parse(targetText);
  } catch {
    currentValue = undefined;
  }
  if (currentValue !== undefined && jsonValuesEqual(currentValue, value)) {
    fail({
      error: {
        code: "no-op-edit",
        message: `timeline path "${timelinePath}" already carries this value; refusing a no-op edit`,
        file: relativeManifestFile,
        field: `timeline.${timelinePath}`,
      },
    }, 1);
  }

  // 3. Patch + in-memory mutated manifest, validated against the preset
  //    catalog BEFORE the gate or any write.
  const replacement = serializeJsValue(value, lineIndentation(sourceBefore, target.keyStart));
  const patch = buildPatch(sourceBefore, target, replacement);
  const sha256After = sha256Hex(Buffer.from(patch.patched, "utf8"));
  let mutatedManifest;
  try {
    mutatedManifest = JSON.parse(patch.patched);
  } catch (error) {
    fail({ error: { code: "patched-manifest-invalid", message: `patched manifest.json is not valid JSON: ${error.message}` } }, 1);
  }
  const valueValidation = await validateTimelineValue({ cwd, config, deckId, mutatedManifest });
  if (!valueValidation.ok) {
    fail({
      error: {
        code: "invalid-timeline-value",
        message: "timeline value rejected before write (preset catalog / timeline contract)",
        details: { errors: valueValidation.errors },
        file: relativeManifestFile,
        field: `timeline.${timelinePath}`,
      },
    }, 1);
  }

  const identityManifest = resolveIdentityManifest({ cwd, deckId, liveManifest: manifest, migrationDir });
  const lockRecord = readLockRecord(locksDir, deckId);

  // 4. Content Lock gate — computed BEFORE any write, same fail-closed
  //    semantics as content edits.
  const gate = await runTimelineGate({ cwd, config, deckId, timelinePath, identityManifest, lockRecord, value, dryRun });

  const sourceMap = {
    file: relativeManifestFile,
    slideObject: null,
    target: {
      kind: "property-value",
      fieldPath: `timeline.${timelinePath}`,
      charRange: patch.span.charRange,
      byteRange: patch.span.byteRange,
      line: patch.span.line,
      column: patch.span.column,
    },
    replacedBytes: patch.replacedBytes,
    insertedBytes: patch.insertedBytes,
  };

  if (dryRun) {
    emit({
      dryRun: true,
      deck: deckId,
      timelinePath,
      reason,
      actor,
      when,
      sourceMap,
      inputs: { file: relativeManifestFile, sha256: sha256Before },
      outputs: { file: relativeManifestFile, sha256: sha256After },
      gate,
      wouldWrite: [relativeManifestFile],
    });
    return;
  }

  // 5. Apply the single-span replacement.
  fs.writeFileSync(manifestFile, patch.patched, "utf8");
  const written = fs.readFileSync(manifestFile, "utf8");
  if (sha256Hex(Buffer.from(written, "utf8")) !== sha256After) {
    fail({ error: { code: "write-mismatch", message: "post-write verification of file bytes failed" } }, 1);
  }

  // 6. Verification loop; any failure rolls the edit back byte-exact.
  let postVerify;
  try {
    postVerify = await runTimelinePostWriteVerification({ cwd, config, deckId, timelinePath, value, lockRecord });
  } catch (error) {
    rollback(manifestFile, sourceBefore, sha256Before);
    fail({
      error: { code: "post-verify-failed", message: error.message },
      rolledBack: true,
      inputs: { file: relativeManifestFile, sha256: sha256Before },
    }, 1);
  }
  if (!postVerify.ok) {
    rollback(manifestFile, sourceBefore, sha256Before);
    fail({
      error: { code: postVerify.code, message: postVerify.message },
      rolledBack: true,
      details: postVerify.details ?? null,
      inputs: { file: relativeManifestFile, sha256: sha256Before },
    }, 1);
  }

  // 7. Provenance record.
  const provenanceRecord = buildProvenanceRecord({
    command: "edit",
    actor,
    when,
    deck: deckId,
    slide: null,
    field: `timeline.${timelinePath}`,
    reason,
    value,
    sourceMap,
    inputs: {
      file: relativeManifestFile,
      sha256: sha256Before,
      compositeHash: gate.fingerprintBefore?.compositeHash ?? null,
    },
    outputs: {
      file: relativeManifestFile,
      sha256: sha256After,
      compositeHash: postVerify.fingerprint?.compositeHash ?? null,
    },
    gate: {
      contentLock: gate.summary,
      validate: postVerify.validate,
      fingerprintAfter: postVerify.fingerprint,
    },
  });
  let provenancePath;
  try {
    provenancePath = writeProvenanceRecord(cwd, provenanceRecord);
  } catch (error) {
    fail({ error: { code: "provenance-write-failed", message: error.message } }, 2);
  }

  emit({
    dryRun: false,
    deck: deckId,
    timelinePath,
    reason,
    actor,
    when,
    sourceMap,
    inputs: { file: relativeManifestFile, sha256: sha256Before },
    outputs: { file: relativeManifestFile, sha256: sha256After },
    gate: { contentLock: gate.summary, validate: postVerify.validate },
    fingerprint: postVerify.fingerprint,
    provenance: { schema: provenanceRecord.schema, path: path.relative(cwd, provenancePath).split(path.sep).join("/") },
  });
}

async function runTimelineGate({ cwd, config, deckId, timelinePath, identityManifest, lockRecord, value, dryRun }) {
  if (!lockRecord || !lockRecord.fingerprint) {
    return {
      summary: { mode: "absent", decision: "allow", note: "no stored content lock for this deck" },
      fingerprintBefore: null,
    };
  }

  const reject = (code, message, extra = {}) => {
    fail({
      error: { code, message, deck: deckId, timelinePath, ...extra },
      gate: { contentLock: { mode: "enforced", decision: "reject", lockPath: lockRecord.lockPath } },
      dryRun,
      zeroWrites: true,
    }, 1);
  };

  const { view } = await withDeckView(cwd, config, deckId, () => {});
  const fingerprintBefore = deckFingerprint(view, identityManifest);
  const beforeVerify = verifyContentLock(fingerprintBefore, lockRecord.fingerprint);
  if (!beforeVerify.ok) {
    reject("deck-drifted-from-lock", `deck "${deckId}" no longer verifies against its stored content lock (${beforeVerify.reason}); refusing to edit on top of drift`, {
      diffs: beforeVerify.diffs ?? null,
    });
  }

  // The timeline lives in the manifest, which the content-identity manifest
  // hashes (live-manifest identity): a timeline edit must change the
  // fingerprint, or the lock is not actually protecting it (fail closed).
  const mutatedIdentity = structuredClone(identityManifest);
  if (!applyValueAtPath(mutatedIdentity, `timeline.${timelinePath}`, value)) {
    reject("timeline-path-not-in-identity-manifest", `timeline path "timeline.${timelinePath}" could not be applied to the content-identity manifest`);
  }
  const fingerprintAfter = deckFingerprint(view, mutatedIdentity);
  const afterVerify = verifyContentLock(fingerprintAfter, lockRecord.fingerprint);
  if (afterVerify.ok) {
    reject("gate-inconclusive", "content lock verification did not detect the timeline change; refusing to proceed", {});
  }
  reject("content-lock-gate-rejected", `deck "${deckId}" is content-locked; this timeline edit would change the frozen fingerprint (re-freeze with "lattice lock update --deck ${deckId}" after explicit authorization)`, {
    diffs: afterVerify.diffs ?? null,
    lockPath: lockRecord.lockPath,
  });
}

async function runTimelinePostWriteVerification({ cwd, config, deckId, timelinePath, value, lockRecord }) {
  // Fresh deck view from the files just written (new module pipeline, no
  // stale module cache) — withDeckView re-reads manifest.json, so the
  // identity manifest carries the applied timeline edit.
  const { view, manifest } = await withDeckView(cwd, config, deckId, () => {});

  let current = manifest.timeline;
  for (const segment of String(timelinePath).split(".").map((part) => part.trim()).filter(Boolean)) {
    current = descend(current, segment);
    if (current === undefined) {
      return { ok: false, code: "post-write-manifest-mismatch", message: `re-read manifest does not carry the edited value at "timeline.${timelinePath}"` };
    }
  }
  if (!jsonValuesEqual(current, value)) {
    return { ok: false, code: "post-write-manifest-mismatch", message: `re-read manifest value at "timeline.${timelinePath}" does not match the edit` };
  }

  const fingerprint = deckFingerprint(view, manifest);
  if (lockRecord?.fingerprint) {
    const verify = verifyContentLock(fingerprint, lockRecord.fingerprint);
    if (!verify.ok) {
      return { ok: false, code: "content-lock-verify-failed", message: "content lock verification failed after write", details: verify };
    }
  }

  const validate = await runValidateSubprocess(cwd, deckId);
  if (validate.exitCode !== 0) {
    return {
      ok: false,
      code: "validate-failed",
      message: `lattice validate --deck ${deckId} exited ${validate.exitCode}`,
      details: { stdout: validate.stdout.slice(-4000), stderr: validate.stderr.slice(-4000) },
    };
  }
  return { ok: true, fingerprint, validate: { exitCode: 0, pass: true } };
}

// ---- M9 structure mode -------------------------------------------------------
//
// Slide-level structural edits (add/remove/reorder) through the same
// auditable loop as content edits: derived-shape guards, semantic pre-checks,
// Content Lock gate (locked decks are always rejected, zero writes), exact
// single-span patches per file, multi-file provenance source map, and the
// fresh-import + validate verification loop with byte-exact rollback.

const STRUCTURE_OPS = new Set(["add", "remove", "reorder"]);
const SLIDE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

async function structureEditCommand({ args, cwd }) {
  const op = args.structure;
  if (typeof op !== "string" || !STRUCTURE_OPS.has(op)) {
    fail({
      error: {
        code: "invalid-structure-op",
        message: `--structure must be one of ${[...STRUCTURE_OPS].map((entry) => JSON.stringify(entry)).join(", ")}, got ${JSON.stringify(op ?? null)}`,
      },
    }, 2);
  }

  if (args.field !== undefined) {
    fail({
      error: {
        code: "mutually-exclusive-arguments",
        message: "--structure targets deck structure; --field targets one field inside one slide. Use one mode, not both.",
      },
    }, 1);
  }

  const dryRun = Boolean(args["dry-run"]);
  const reason = typeof args.reason === "string" ? args.reason : null;
  const actor = typeof args.actor === "string" && args.actor.trim() !== "" ? args.actor.trim() : "unknown";
  const when = resolveTimestamp(args.timestamp);
  const locksDir = resolveLocksDir(cwd, { locksDir: args["locks-dir"] });
  const migrationDir = path.resolve(cwd, args["migration-dir"] ?? DEFAULT_MIGRATION_DIR);

  let value;
  if (args.value !== undefined) {
    try {
      value = JSON.parse(args.value);
    } catch (error) {
      fail({
        error: {
          code: "invalid-value",
          message: `--value must be a single JSON value: ${error.message}`,
          hint: 'reorder example: --value \'["intro","overview","wrap-up"]\'',
        },
      }, 1);
    }
  }

  const deckId = args.deck;
  if (typeof deckId !== "string" || deckId === "") {
    fail({ error: { code: "missing-argument", message: "--deck is required" } }, 2);
  }

  let config;
  try {
    config = await loadConfig(cwd);
  } catch (error) {
    fail({ error: { code: "config-not-found", message: error.message } }, 2);
  }

  const deckDir = deckDirPath(cwd, config, deckId);
  if (!fs.existsSync(deckDir)) {
    fail({ error: { code: "deck-not-found", message: `deck directory not found: ${deckDir}` } }, 1);
  }
  let manifest;
  try {
    manifest = requireV2Manifest(readManifest(deckDir), deckId);
  } catch (error) {
    fail({ error: { code: error.code ?? "invalid-manifest", message: error.message } }, exitCodeForErrorCode(error.code));
  }

  const contentFile = path.resolve(deckDir, manifest.entry?.content ?? "./content.js");
  const slidesV2File = path.resolve(deckDir, manifest.entry?.slides ?? "./slides.v2.js");
  const slidesJsFile = path.join(deckDir, "slides.js");
  const notesFile = path.resolve(deckDir, manifest.entry?.notes ?? "./notes.js");
  const manifestFile = path.join(deckDir, "manifest.json");
  const rel = (target) => path.relative(cwd, target).split(path.sep).join("/");

  for (const [label, file] of [["content.js", contentFile], ["slides.v2.js", slidesV2File], ["slides.js", slidesJsFile], ["manifest.json", manifestFile]]) {
    if (!fs.existsSync(file)) {
      fail({ error: { code: "content-not-found", message: `deck ${label} not found: ${file}` } }, 2);
    }
  }

  const sourcesBefore = {
    content: fs.readFileSync(contentFile, "utf8"),
    manifest: fs.readFileSync(manifestFile, "utf8"),
    notes: fs.existsSync(notesFile) ? fs.readFileSync(notesFile, "utf8") : null,
    slides: fs.readFileSync(slidesJsFile, "utf8"),
    slidesV2: fs.readFileSync(slidesV2File, "utf8"),
  };

  // 1. Derived-shape guard: a structural edit may only run on decks whose
  //    slides.js/slides.v2.js derive from content.slides.
  try {
    assertDerivedStructureShape({ slidesSource: sourcesBefore.slides, slidesV2Source: sourcesBefore.slidesV2 });
  } catch (error) {
    fail({ error: { code: error.code, message: error.message, deck: deckId } }, 1);
  }

  // 2. Semantic view + source cross-check.
  const identityManifest = resolveIdentityManifest({ cwd, deckId, liveManifest: manifest, migrationDir });
  const lockRecord = readLockRecord(locksDir, deckId);
  let view;
  try {
    ({ view } = await withDeckView(cwd, config, deckId, () => {}));
  } catch (error) {
    fail({ error: { code: error.code ?? "deck-build-error", message: error.message } }, exitCodeForErrorCode(error.code));
  }
  const contentSlides = view.content?.slides;
  if (!Array.isArray(contentSlides)) {
    fail({ error: { code: "structure-shape-unsupported", message: 'deck content does not carry a "slides" array; structural edits require the derived content shape' } }, 1);
  }
  let crossCheck;
  try {
    crossCheck = crossCheckSlidesSource(sourcesBefore.content, contentSlides);
  } catch (error) {
    fail({ error: { code: error.code, message: error.message, deck: deckId } }, 1);
  }
  const currentIds = crossCheck.ids;

  // 3. Per-op semantic pre-checks (zero writes on any refusal).
  let newSlide = null;
  let notesMutation = null;
  let expectedIds;
  let slideForProvenance = null;
  let provenanceValue = null;

  if (op === "add") {
    const slideId = args.slide;
    if (typeof slideId !== "string" || slideId === "") {
      fail({ error: { code: "missing-argument", message: "--structure add requires --slide <newSlideId>" } }, 2);
    }
    if (!SLIDE_ID_PATTERN.test(slideId)) {
      fail({ error: { code: "invalid-slide-id", message: `--slide must be a stable slug (lowercase letters, digits, hyphens), got ${JSON.stringify(slideId)}` } }, 1);
    }
    if (currentIds.includes(slideId)) {
      fail({ error: { code: "slide-exists", message: `slide id ${JSON.stringify(slideId)} already exists in deck "${deckId}"` } }, 1);
    }
    if (value === undefined) value = {};
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      fail({ error: { code: "invalid-value", message: "--value for --structure add must be a JSON object of content fields" } }, 1);
    }
    if ("id" in value && value.id !== slideId) {
      fail({ error: { code: "invalid-value", message: `--value must not carry a conflicting id (the new slide id comes from --slide ${JSON.stringify(slideId)})` } }, 1);
    }
    newSlide = { ...value, id: slideId };
    const afterId = typeof args.after === "string" ? args.after : null;
    if (args.after !== undefined && (afterId === null || !currentIds.includes(afterId))) {
      fail({ error: { code: "after-slide-not-found", message: `--after ${JSON.stringify(args.after)} does not reference an existing slide in deck "${deckId}"` } }, 1);
    }
    if (typeof args.notes === "string" && args.notes !== "") {
      notesMutation = { add: { id: slideId, text: args.notes } };
    }
    const insertIndex = afterId === null ? currentIds.length : currentIds.indexOf(afterId) + 1;
    expectedIds = [...currentIds.slice(0, insertIndex), slideId, ...currentIds.slice(insertIndex)];
    slideForProvenance = slideId;
    provenanceValue = newSlide;
  } else if (op === "remove") {
    const slideId = args.slide;
    if (typeof slideId !== "string" || slideId === "") {
      fail({ error: { code: "missing-argument", message: "--structure remove requires --slide <slideId>" } }, 2);
    }
    if (!currentIds.includes(slideId)) {
      fail({ error: { code: "slide-not-found", message: `slide id ${JSON.stringify(slideId)} does not exist in deck "${deckId}" (slides: ${currentIds.join(", ")})` } }, 1);
    }
    if (currentIds.length === 1) {
      fail({ error: { code: "structure-would-empty-deck", message: `slide ${JSON.stringify(slideId)} is the deck's only slide; a deck must keep at least one slide` } }, 1);
    }
    if (manifest.timeline?.slides?.[slideId] !== undefined) {
      fail({
        error: {
          code: "structure-slide-in-timeline",
          message: `slide ${JSON.stringify(slideId)} has a lattice.timeline.v1 entry (timeline.slides.${slideId}); remove that timeline entry first, then re-run the structural edit`,
        },
      }, 1);
    }
    const otherRoutes = Object.entries(manifest.routes ?? {})
      .filter(([routeName, route]) => routeName !== "main" && Array.isArray(route) && route.includes(slideId));
    if (otherRoutes.length > 0) {
      fail({
        error: {
          code: "structure-slide-in-other-route",
          message: `slide ${JSON.stringify(slideId)} is referenced by route(s) ${otherRoutes.map(([name]) => JSON.stringify(name)).join(", ")}; remove it from those routes first`,
        },
      }, 1);
    }
    expectedIds = currentIds.filter((id) => id !== slideId);
    slideForProvenance = slideId;
  } else {
    if (!Array.isArray(value) || value.length !== currentIds.length || value.some((id) => typeof id !== "string")) {
      fail({
        error: {
          code: "invalid-value",
          message: `--value for --structure reorder must be a JSON array containing exactly the deck's slide ids in the new order (deck slides: ${currentIds.length})`,
        },
      }, 1);
    }
    const missing = value.filter((id) => !currentIds.includes(id));
    const duplicated = value.filter((id, index) => value.indexOf(id) !== index);
    if (missing.length > 0 || duplicated.length > 0) {
      fail({
        error: {
          code: "invalid-value",
          message: `--value must be a permutation of the deck's slide ids ${JSON.stringify(currentIds)}` +
            (missing.length > 0 ? `; missing: ${missing.map((id) => JSON.stringify(id)).join(", ")}` : "") +
            (duplicated.length > 0 ? `; duplicated: ${[...new Set(duplicated)].map((id) => JSON.stringify(id)).join(", ")}` : ""),
        },
      }, 1);
    }
    if (jsonValuesEqual(value, currentIds)) {
      fail({ error: { code: "no-op-edit", message: "the requested order is the deck's current order; refusing a no-op reorder" } }, 1);
    }
    expectedIds = [...value];
    provenanceValue = [...value];
  }

  // 4. Plan the exact patches (each is one contiguous span per file).
  let contentPatch;
  let manifestPatch;
  let notesPatch;
  try {
    if (op === "add") {
      const afterIndex = typeof args.after === "string" ? currentIds.indexOf(args.after) : null;
      contentPatch = planSlideInsert(sourcesBefore.content, newSlide, { afterIndex });
      manifestPatch = planRouteInsert(sourcesBefore.manifest, slideForProvenance, { afterId: typeof args.after === "string" ? args.after : null });
      notesPatch = notesMutation && sourcesBefore.notes !== null
        ? planNotesInsert(sourcesBefore.notes, notesMutation.add.id, notesMutation.add.text)
        : null;
    } else if (op === "remove") {
      contentPatch = planSlideRemove(sourcesBefore.content, currentIds.indexOf(slideForProvenance));
      manifestPatch = planRouteRemove(sourcesBefore.manifest, slideForProvenance);
      notesPatch = sourcesBefore.notes !== null ? planNotesRemove(sourcesBefore.notes, slideForProvenance) : null;
    } else {
      const textsById = new Map(currentIds.map((id, index) => [id, crossCheck.texts[index]]));
      contentPatch = planSlideReorder(sourcesBefore.content, expectedIds.map((id) => textsById.get(id)));
      manifestPatch = planRouteReorder(sourcesBefore.manifest, expectedIds);
      notesPatch = null;
    }
  } catch (error) {
    fail({ error: { code: error.code ?? "structure-plan-failed", message: error.message, deck: deckId } }, exitCodeForErrorCode(error.code));
  }

  const plannedFiles = [
    { key: "content", file: contentFile, label: rel(contentFile), patch: contentPatch },
    { key: "manifest", file: manifestFile, label: rel(manifestFile), patch: manifestPatch },
    ...(notesPatch ? [{ key: "notes", file: notesFile, label: rel(notesFile), patch: notesPatch }] : []),
  ].map((entry) => ({
    ...entry,
    sha256Before: sha256Hex(Buffer.from(sourcesBefore[entry.key], "utf8")),
    sha256After: sha256Hex(Buffer.from(entry.patch.patched, "utf8")),
  }));

  // 5. Content Lock gate — computed BEFORE any write from an in-memory
  //    simulation of the structural change. A stored lock always rejects a
  //    structural edit (slide order/count and notes are frozen identity).
  const gate = await runStructureGate({
    cwd,
    config,
    deckId,
    op,
    view,
    identityManifest,
    lockRecord,
    expectedIds,
    notesMutation,
    removedId: op === "remove" ? slideForProvenance : null,
    dryRun,
  });

  const sourceMap = {
    file: rel(contentFile),
    slideObject: null,
    target: {
      kind: `structure-${op}`,
      fieldPath: "slides",
      charRange: contentPatch.span.charRange,
      byteRange: contentPatch.span.byteRange,
      line: contentPatch.span.line,
      column: contentPatch.span.column,
    },
    replacedBytes: contentPatch.replacedBytes,
    insertedBytes: contentPatch.insertedBytes,
    files: plannedFiles.map((entry) => ({
      file: entry.label,
      operation: entry.patch.replaced === "" ? "insert" : entry.patch.insertedBytes === 0 ? "remove" : "replace",
      charRange: entry.patch.span.charRange,
      byteRange: entry.patch.span.byteRange,
      line: entry.patch.span.line,
      column: entry.patch.span.column,
      replacedBytes: entry.patch.replacedBytes,
      insertedBytes: entry.patch.insertedBytes,
      sha256Before: entry.sha256Before,
      sha256After: entry.sha256After,
    })),
  };

  if (dryRun) {
    emit({
      dryRun: true,
      deck: deckId,
      structure: op,
      slide: slideForProvenance,
      reason,
      actor,
      when,
      order: { before: currentIds, after: expectedIds },
      sourceMap,
      inputs: { file: rel(contentFile), sha256: plannedFiles[0].sha256Before },
      outputs: { file: rel(contentFile), sha256: plannedFiles[0].sha256After },
      gate,
      wouldWrite: plannedFiles.map((entry) => entry.label),
    });
    return;
  }

  // 6. Apply the patches; every file is written and byte-verified.
  for (const entry of plannedFiles) {
    fs.writeFileSync(entry.file, entry.patch.patched, "utf8");
    const written = fs.readFileSync(entry.file, "utf8");
    if (sha256Hex(Buffer.from(written, "utf8")) !== entry.sha256After) {
      rollbackAll(plannedFiles, sourcesBefore);
      fail({ error: { code: "write-mismatch", message: `post-write verification of ${entry.label} bytes failed` } }, 1);
    }
  }

  // 7. Verification loop; any failure rolls every file back byte-exact.
  let postVerify;
  try {
    postVerify = await runStructurePostWriteVerification({ cwd, config, deckId, expectedIds, notesMutation, lockRecord });
  } catch (error) {
    rollbackAll(plannedFiles, sourcesBefore);
    fail({
      error: { code: "post-verify-failed", message: error.message },
      rolledBack: true,
      inputs: { file: rel(contentFile), sha256: plannedFiles[0].sha256Before },
    }, 1);
  }
  if (!postVerify.ok) {
    rollbackAll(plannedFiles, sourcesBefore);
    fail({
      error: { code: postVerify.code, message: postVerify.message },
      rolledBack: true,
      details: postVerify.details ?? null,
      inputs: { file: rel(contentFile), sha256: plannedFiles[0].sha256Before },
    }, 1);
  }

  // 8. Provenance record (multi-file source map).
  const provenanceRecord = buildProvenanceRecord({
    command: "edit",
    actor,
    when,
    deck: deckId,
    slide: slideForProvenance,
    field: `structure.${op}`,
    reason,
    value: provenanceValue,
    sourceMap,
    inputs: {
      file: rel(contentFile),
      sha256: plannedFiles[0].sha256Before,
      compositeHash: gate.fingerprintBefore?.compositeHash ?? null,
    },
    outputs: {
      file: rel(contentFile),
      sha256: plannedFiles[0].sha256After,
      compositeHash: postVerify.fingerprint?.compositeHash ?? null,
    },
    gate: {
      contentLock: gate.summary,
      validate: postVerify.validate,
      fingerprintAfter: postVerify.fingerprint,
    },
  });
  let provenancePath;
  try {
    provenancePath = writeProvenanceRecord(cwd, provenanceRecord);
  } catch (error) {
    fail({ error: { code: "provenance-write-failed", message: error.message } }, 2);
  }

  emit({
    dryRun: false,
    deck: deckId,
    structure: op,
    slide: slideForProvenance,
    reason,
    actor,
    when,
    order: { before: currentIds, after: expectedIds },
    sourceMap,
    inputs: { file: rel(contentFile), sha256: plannedFiles[0].sha256Before },
    outputs: { file: rel(contentFile), sha256: plannedFiles[0].sha256After },
    gate: { contentLock: gate.summary, validate: postVerify.validate },
    fingerprint: postVerify.fingerprint,
    provenance: { schema: provenanceRecord.schema, path: path.relative(cwd, provenancePath).split(path.sep).join("/") },
  });
}

function rollbackAll(plannedFiles, sourcesBefore) {
  for (const entry of plannedFiles) {
    fs.writeFileSync(entry.file, sourcesBefore[entry.key], "utf8");
    const restored = sha256Hex(fs.readFileSync(entry.file));
    if (restored !== entry.sha256Before) {
      process.stderr.write(`${JSON.stringify({ ok: false, command: "edit", error: { code: "rollback-mismatch", message: `rollback did not restore the original bytes of ${entry.label}` } })}\n`);
      process.exit(2);
    }
  }
}

async function runStructureGate({ cwd, config, deckId, op, view, identityManifest, lockRecord, expectedIds, notesMutation, removedId, dryRun }) {
  if (!lockRecord || !lockRecord.fingerprint) {
    return {
      summary: { mode: "absent", decision: "allow", note: "no stored content lock for this deck" },
      fingerprintBefore: null,
    };
  }

  const reject = (code, message, extra = {}) => {
    fail({
      error: { code, message, deck: deckId, ...extra },
      gate: { contentLock: { mode: "enforced", decision: "reject", lockPath: lockRecord.lockPath } },
      dryRun,
      zeroWrites: true,
    }, 1);
  };

  const fingerprintBefore = deckFingerprint(view, identityManifest);
  const beforeVerify = verifyContentLock(fingerprintBefore, lockRecord.fingerprint);
  if (!beforeVerify.ok) {
    reject("deck-drifted-from-lock", `deck "${deckId}" no longer verifies against its stored content lock (${beforeVerify.reason}); refusing to edit on top of drift`, {
      diffs: beforeVerify.diffs ?? null,
    });
  }

  // Simulate the structural change in memory: the slides array and notes are
  // frozen identity, so a structural edit must always move the fingerprint.
  // Slides the simulation has not seen (add) are represented by their id so
  // the count/order channel still moves; remove reorders the array down.
  const mutatedContent = structuredClone(view.content);
  const mutatedNotes = structuredClone(view.notes);
  const slideById = new Map(mutatedContent.slides.map((slide) => [slide.id, slide]));
  mutatedContent.slides = expectedIds.map((id) => slideById.get(id) ?? { id });
  if (notesMutation?.add) mutatedNotes[notesMutation.add.id] = notesMutation.add.text;
  if (op === "remove" && typeof removedId === "string") delete mutatedNotes[removedId];

  const mutatedView = { ...view, content: mutatedContent, notes: mutatedNotes };
  const fingerprintAfter = deckFingerprint(mutatedView, identityManifest);
  const afterVerify = verifyContentLock(fingerprintAfter, lockRecord.fingerprint);
  if (afterVerify.ok) {
    reject("gate-inconclusive", "content lock verification did not detect the structural change; refusing to proceed", {});
  }
  reject("content-lock-gate-rejected", `deck "${deckId}" is content-locked; a structural edit (${op}) would change the frozen fingerprint (re-freeze with "lattice lock update --deck ${deckId}" after explicit authorization)`, {
    diffs: afterVerify.diffs ?? null,
    lockPath: lockRecord.lockPath,
  });
}

async function runStructurePostWriteVerification({ cwd, config, deckId, expectedIds, notesMutation, lockRecord }) {
  const { view } = await withDeckView(cwd, config, deckId, () => {});
  const ids = Array.isArray(view.content?.slides) ? view.content.slides.map((slide) => slide?.id) : null;
  if (jsonValuesEqual(ids, expectedIds) !== true) {
    return { ok: false, code: "post-write-structure-mismatch", message: `re-imported content carries slide order ${JSON.stringify(ids)}; expected ${JSON.stringify(expectedIds)}` };
  }
  if (view.slideOutputs.length !== expectedIds.length) {
    return { ok: false, code: "post-write-slide-count-mismatch", message: `re-imported deck renders ${view.slideOutputs.length} slide(s) for ${expectedIds.length} content slide(s); the deck's buildSlides must derive from content.slides` };
  }
  if (notesMutation?.add && view.notes[notesMutation.add.id] !== notesMutation.add.text) {
    return { ok: false, code: "post-write-notes-mismatch", message: `re-imported notes do not carry the note for slide ${JSON.stringify(notesMutation.add.id)}` };
  }

  const fingerprint = deckFingerprint(view, identityManifestForPostWrite(cwd, config, deckId));
  if (lockRecord?.fingerprint) {
    const verify = verifyContentLock(fingerprint, lockRecord.fingerprint);
    if (!verify.ok) {
      return { ok: false, code: "content-lock-verify-failed", message: "content lock verification failed after write", details: verify };
    }
  }

  const validate = await runValidateSubprocess(cwd, deckId);
  if (validate.exitCode !== 0) {
    return {
      ok: false,
      code: "validate-failed",
      message: `lattice validate --deck ${deckId} exited ${validate.exitCode}`,
      details: { stdout: validate.stdout.slice(-4000), stderr: validate.stderr.slice(-4000) },
    };
  }
  return { ok: true, fingerprint, validate: { exitCode: 0, pass: true } };
}

function identityManifestForPostWrite(cwd, config, deckId) {
  return resolveIdentityManifest({ cwd, deckId, liveManifest: readManifest(deckDirPath(cwd, config, deckId)) });
}
