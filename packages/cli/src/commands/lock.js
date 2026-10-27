// lattice lock — Content Lock verify/update for lattice.deck.v2 decks.
//
// `lattice lock verify` recomputes each deck's semantic content fingerprint
// (content + notes + buildSlides output + content-identity manifest) and
// compares it with the stored lock record in .lattice/content-locks/<id>.json.
// It is strictly read-only: a missing lock is a failure, never a creation.
//
// `lattice lock update` re-freezes the lock(s): it writes a fresh record only
// after recomputing the fingerprint, skipping decks whose fingerprint is
// unchanged (byte and mtime preserved). Deliberate content evolution of a
// locked deck goes through this command, not through `lattice edit`, which
// refuses any fingerprint-changing edit on a locked deck.
//
// All output is JSON. Exit codes: 0 all decks ok, 1 any verify failure,
// 2 configuration or infrastructure failure.

import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/index.js";
import { CONTENT_LOCK_SCHEMA } from "@55aaseclab/lattice-runtime/content-lock";
import {
  DEFAULT_MIGRATION_DIR,
  deckDirPath,
  deckFingerprint,
  listDeckIds,
  lockPathFor,
  readLockRecord,
  readManifest,
  requireV2Manifest,
  resolveIdentityManifest,
  resolveLocksDir,
  withDeckView,
} from "../edit/deck-view.js";
import { buildProvenanceRecord, sha256Hex, writeProvenanceRecord } from "../edit/provenance.js";
import { verifyContentLock } from "@55aaseclab/lattice-runtime";

const LOCK_USAGE = `Usage: lattice lock verify [--deck <id>] [--locks-dir <dir>] [--migration-dir <dir>]
       lattice lock update  [--deck <id>] [--actor <id>] [--timestamp <iso>]
                            [--reason <text>] [--locks-dir <dir>] [--migration-dir <dir>]
                            [--provenance-dir <dir>]
       lattice lock --help

Verify or re-freeze Content Lock records for lattice.deck.v2 decks.

verify  Recompute each deck's semantic content fingerprint and compare it
        with .lattice/content-locks/<deckId>.json. Read-only: a missing lock
        is reported and fails the run; it is never created.
update  Recompute fingerprints and write/refresh lock records. Unchanged
        decks are skipped without touching lock bytes or mtime. Every write
        is audited with a provenance record. Used after a deliberate,
        human-owned source change; "lattice edit" itself refuses to change
        locked content.

Both commands load deck modules through the project's vite pipeline (CSS
imports in slide modules work exactly like in the portal) and resolve the
content-identity manifest from .lattice/migration/<deckId>.json when an
explicit v1→v2 migration report exists.

Output: one JSON object with a per-deck "decks" array. Exit codes:
0 all decks verified/updated, 1 any verification failure, 2 configuration or
infrastructure failure.`;

function fail(payload, exitCode = 1) {
  process.stderr.write(`${JSON.stringify({ ok: false, command: "lock", ...payload }, null, 2)}\n`);
  process.exit(exitCode);
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify({ ok: true, command: "lock", ...payload }, null, 2)}\n`);
}

export async function lockCommand({ args, cwd = process.cwd(), rest = [] }) {
  if (args.help) {
    console.log(LOCK_USAGE);
    return;
  }
  const subcommand = rest[0] ?? args.subcommand;
  if (subcommand !== "verify" && subcommand !== "update") {
    fail({ error: { code: "unknown-subcommand", message: "usage: lattice lock verify|update (see --help)" } }, 2);
  }

  let config;
  try {
    config = await loadConfig(cwd);
  } catch (error) {
    fail({ error: { code: "config-not-found", message: error.message } }, 2);
  }

  const deckIds = args.deck ? [args.deck] : listDeckIds(path.resolve(cwd, config.decksDir));
  if (deckIds.length === 0) {
    fail({ error: { code: "no-decks", message: `no decks found in ${path.resolve(cwd, config.decksDir)}` } }, 1);
  }

  const locksDir = resolveLocksDir(cwd, { locksDir: args["locks-dir"] });
  const migrationDir = path.resolve(cwd, args["migration-dir"] ?? DEFAULT_MIGRATION_DIR);
  const isUpdate = subcommand === "update";
  const actor = typeof args.actor === "string" && args.actor.trim() !== "" ? args.actor.trim() : "unknown";
  const when = resolveTimestamp(args.timestamp);
  const reason = typeof args.reason === "string" ? args.reason : null;

  const decks = [];
  let anyFailure = false;

  for (const deckId of deckIds) {
    try {
      const deckDir = deckDirPath(cwd, config, deckId);
      if (!fs.existsSync(deckDir)) {
        decks.push({ deck: deckId, status: "not-found", ok: false });
        anyFailure = true;
        continue;
      }
      const manifest = requireV2Manifest(readManifest(deckDir), deckId);
      const identityManifest = resolveIdentityManifest({ cwd, deckId, liveManifest: manifest, migrationDir });
      const { view } = await withDeckView(cwd, config, deckId, () => {});
      const fingerprint = deckFingerprint(view, identityManifest);
      const lockPath = lockPathFor(locksDir, deckId);
      const stored = readLockRecord(locksDir, deckId);

      if (!isUpdate) {
        if (!stored?.fingerprint) {
          decks.push({ deck: deckId, status: "missing", ok: false, lockPath: rel(cwd, lockPath), compositeHash: fingerprint.compositeHash });
          anyFailure = true;
          continue;
        }
        const verify = verifyContentLock(fingerprint, stored.fingerprint);
        decks.push(
          verify.ok
            ? { deck: deckId, status: "ok", ok: true, lockPath: rel(cwd, lockPath), compositeHash: fingerprint.compositeHash }
            : { deck: deckId, status: "mismatch", ok: false, lockPath: rel(cwd, lockPath), compositeHash: fingerprint.compositeHash, diffs: verify.diffs ?? [verify.reason] },
        );
        if (!verify.ok) anyFailure = true;
        continue;
      }

      if (stored?.fingerprint && verifyContentLock(fingerprint, stored.fingerprint).ok) {
        decks.push({ deck: deckId, status: "unchanged", ok: true, lockPath: rel(cwd, lockPath), compositeHash: fingerprint.compositeHash, skipped: true });
        continue;
      }

      const record = {
        schema: CONTENT_LOCK_SCHEMA,
        deckId,
        createdAt: when,
        fingerprint,
      };
      const previousComposite = stored?.fingerprint?.compositeHash ?? null;
      const lockBytesBefore = stored ? fs.readFileSync(lockPath) : null;
      fs.mkdirSync(locksDir, { recursive: true });
      fs.writeFileSync(lockPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
      const provenanceRecord = buildProvenanceRecord({
        command: "lock update",
        actor,
        when,
        deck: deckId,
        reason,
        sourceMap: null,
        inputs: { file: rel(cwd, lockPath), sha256: lockBytesBefore ? sha256Hex(lockBytesBefore) : null, compositeHash: previousComposite },
        outputs: { file: rel(cwd, lockPath), sha256: sha256Hex(fs.readFileSync(lockPath)), compositeHash: fingerprint.compositeHash },
        gate: { contentLock: { mode: "refreeze", decision: "write" } },
      });
      const provenancePath = writeProvenanceRecord(cwd, provenanceRecord);
      decks.push({
        deck: deckId,
        status: previousComposite ? "updated" : "created",
        ok: true,
        lockPath: rel(cwd, lockPath),
        compositeHash: fingerprint.compositeHash,
        previousCompositeHash: previousComposite,
        provenance: rel(cwd, provenancePath),
      });
    } catch (error) {
      decks.push({ deck: deckId, status: "error", ok: false, errorCode: error.code ?? "deck-error", message: error.message });
      anyFailure = true;
    }
  }

  if (anyFailure) {
    fail({ action: subcommand, decks }, 1);
  }
  emit({ action: subcommand, decks });
}

function rel(cwd, target) {
  return path.relative(cwd, target).split(path.sep).join("/");
}

function resolveTimestamp(input) {
  const candidate = typeof input === "string" && input.trim() !== "" ? input.trim() : new Date().toISOString();
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) {
    fail({ error: { code: "invalid-timestamp", message: `--timestamp must be an ISO instant, got ${JSON.stringify(input)}` } }, 2);
  }
  return parsed.toISOString();
}
