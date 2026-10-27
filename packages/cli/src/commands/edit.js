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
import { verifyContentLock } from "@55aaseclab/lattice-runtime";

const EDIT_USAGE = `Usage: lattice edit --deck <id> --slide <slideId> --field <path> --value <json>
                      [--dry-run] [--reason <text>] [--actor <id>] [--timestamp <iso>]
                      [--locks-dir <dir>] [--migration-dir <dir>] [--provenance-dir <dir>] [--help]

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
