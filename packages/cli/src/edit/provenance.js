// Provenance records for agent-driven canonical-source edits.
//
// Every applied `lattice edit` and every lock (re)freeze writes one
// machine-readable record answering who/when/what: the actor, the instant,
// the exact byte range touched (edit → source file → byte range), the input
// and output hashes, the affected deck/slide, and the gate decisions.
// Records are deterministic JSON apart from the recorded wall-clock instant,
// which callers can pin for reproducible runs.

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const PROVENANCE_SCHEMA = "lattice.provenance.v1";

export function provenanceDirPath(cwd, overrides = {}) {
  return path.resolve(cwd, overrides.provenanceDir ?? ".lattice/provenance");
}

export function provenanceFileName({ when, deck, slide, outputSha256 }) {
  const stamp = String(when).replace(/[:.]/g, "-");
  const parts = [stamp, deck];
  if (slide) parts.push(slide);
  parts.push((outputSha256 || "nooutput").slice(0, 8));
  return `${parts.join("-")}.json`;
}

export function buildProvenanceRecord(record) {
  const {
    command,
    actor,
    when,
    deck,
    slide = null,
    field = null,
    dryRun = false,
    reason = null,
    value = null,
    sourceMap = null,
    inputs = null,
    outputs = null,
    gate = null,
    lockUpdate = null,
  } = record;

  if (!command) throw new Error("provenance record requires command");
  if (!actor) throw new Error("provenance record requires actor");
  if (!when) throw new Error("provenance record requires when");
  if (!deck) throw new Error("provenance record requires deck");

  return {
    schema: PROVENANCE_SCHEMA,
    command,
    actor,
    when,
    dryRun,
    deck,
    slide,
    field,
    reason,
    value,
    sourceMap,
    inputs,
    outputs,
    gate,
    lockUpdate,
  };
}

export function writeProvenanceRecord(cwd, record, overrides = {}) {
  const dir = provenanceDirPath(cwd, overrides);
  fs.mkdirSync(dir, { recursive: true });
  const fileName = provenanceFileName({
    when: record.when,
    deck: record.deck,
    slide: record.slide,
    outputSha256: record.outputs?.sha256 ?? null,
  });
  const filePath = path.join(dir, fileName);
  fs.writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return filePath;
}

export function sha256Hex(bufferOrString) {
  return createHash("sha256").update(bufferOrString).digest("hex");
}
