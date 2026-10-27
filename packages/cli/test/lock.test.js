// M6 — Content Lock CLI: verify (read-only) and update (re-freeze), plus the
// machine-consumable convergence loop on a real fixture project.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(testDir, "..");
const runtimeRoot = path.resolve(cliRoot, "..", "runtime");
const binPath = path.join(cliRoot, "src", "index.js");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-lock-tests-"));

const { scaffoldTemplate } = await import("./helpers/scaffold-project.js");

function runCli(cwd, args) {
  return spawnSync(process.execPath, [binPath, ...args], { cwd, encoding: "utf8", timeout: 300000 });
}

function readJsonOutput(result, stream = "stdout") {
  const text = (stream === "stderr" ? result.stderr : result.stdout).trim();
  const start = text.indexOf("{");
  assert.ok(start >= 0, `expected JSON output, got: ${text}`);
  return JSON.parse(text.slice(start));
}

function makeProject(name, { decks } = {}) {
  const projectDir = fs.mkdtempSync(path.join(tmpRoot, `lattice-lock-${name}-`));
  fs.writeFileSync(
    path.join(projectDir, "lattice.config.js"),
    'export default {\n  title: "Lock Test",\n  registry: null,\n};\n',
    "utf8",
  );
  for (const deck of decks ?? ["lock-deck"]) {
    scaffoldTemplate(projectDir, "simple-light", { deckId: deck, title: `${deck} title` }, { runtimeRoot });
  }
  return projectDir;
}

test("lock verify on a project without locks fails with a missing-lock diagnostic and creates nothing", () => {
  const project = makeProject("missing");
  const result = runCli(project, ["lock", "verify"]);
  assert.equal(result.status, 1);
  const report = readJsonOutput(result, "stderr");
  assert.equal(report.ok, false);
  assert.equal(report.decks[0].status, "missing");
  assert.equal(report.decks[0].ok, false);
  assert.ok(!fs.existsSync(path.join(project, ".lattice", "content-locks")), "verify must never create locks");
  fs.rmSync(project, { recursive: true, force: true });
});

test("lock update creates a deterministic v4 lock record and verify passes", () => {
  const project = makeProject("create");
  const result = runCli(project, [
    "lock", "update", "--deck", "lock-deck", "--actor", "agent:test",
    "--timestamp", "2026-10-27T00:00:00.000Z", "--reason", "initial freeze",
  ]);
  assert.equal(result.status, 0, result.stderr);
  const report = readJsonOutput(result, "stdout");
  assert.equal(report.decks[0].status, "created");
  assert.ok(report.decks[0].provenance, "a lock write must be audited with a provenance record");
  assert.ok(fs.existsSync(path.join(project, report.decks[0].provenance)));

  const lockPath = path.join(project, ".lattice", "content-locks", "lock-deck.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  assert.equal(lock.schema, "lattice.content-lock.v4");
  assert.equal(lock.deckId, "lock-deck");
  assert.equal(lock.createdAt, "2026-10-27T00:00:00.000Z");
  assert.equal(lock.fingerprint.version, 4);
  assert.equal(lock.fingerprint.slideCount, 3);

  const verify = runCli(project, ["lock", "verify", "--deck", "lock-deck"]);
  assert.equal(verify.status, 0);
  assert.equal(readJsonOutput(verify, "stdout").decks[0].status, "ok");

  // A verification run is read-only: lock bytes and mtime stay identical.
  const before = fs.readFileSync(lockPath);
  const mtimeBefore = fs.statSync(lockPath).mtimeMs;
  runCli(project, ["lock", "verify"]);
  assert.ok(Buffer.compare(before, fs.readFileSync(lockPath)) === 0);
  assert.equal(mtimeBefore, fs.statSync(lockPath).mtimeMs);

  // Re-freezing an unchanged deck is a skip, not a rewrite.
  const again = runCli(project, ["lock", "update", "--deck", "lock-deck", "--actor", "agent:test"]);
  assert.equal(again.status, 0);
  const againReport = readJsonOutput(again, "stdout");
  assert.equal(againReport.decks[0].status, "unchanged");
  assert.equal(againReport.decks[0].skipped, true);
  assert.ok(Buffer.compare(before, fs.readFileSync(lockPath)) === 0, "unchanged decks keep their lock bytes");
  fs.rmSync(project, { recursive: true, force: true });
});

test("lock verify detects out-of-band drift and update re-freezes after a deliberate change", () => {
  const project = makeProject("drift");
  runCli(project, ["lock", "update", "--deck", "lock-deck", "--actor", "agent:test"]);
  const lockPath = path.join(project, ".lattice", "content-locks", "lock-deck.json");
  const frozenBytes = fs.readFileSync(lockPath);

  // Deliberate human edit of the canonical source (the documented evolution
  // path: hand edit, then re-freeze with `lattice lock update`).
  const contentFile = path.join(project, "decks", "lock-deck", "content.js");
  fs.writeFileSync(contentFile, fs.readFileSync(contentFile, "utf8").replace("Deck Title Goes Here", "Evolved Title"), "utf8");

  const verify = runCli(project, ["lock", "verify"]);
  assert.equal(verify.status, 1);
  const verifyReport = readJsonOutput(verify, "stderr");
  assert.equal(verifyReport.decks[0].status, "mismatch");
  // The title feeds both the content channel and the rendered slide output.
  assert.ok(verifyReport.decks[0].diffs.includes("contentHash"));
  assert.ok(verifyReport.decks[0].diffs.includes("slideHashes"));

  const update = runCli(project, ["lock", "update", "--deck", "lock-deck", "--actor", "agent:test", "--reason", "deliberate evolution"]);
  assert.equal(update.status, 0);
  const updateReport = readJsonOutput(update, "stdout");
  assert.equal(updateReport.decks[0].status, "updated");
  assert.notEqual(updateReport.decks[0].previousCompositeHash, updateReport.decks[0].compositeHash);
  assert.ok(Buffer.compare(frozenBytes, fs.readFileSync(lockPath)) !== 0);

  const verifyAfter = runCli(project, ["lock", "verify"]);
  assert.equal(verifyAfter.status, 0);
  fs.rmSync(project, { recursive: true, force: true });
});

test("lock commands are JSON-out with explicit exit codes for bad usage", () => {
  const project = makeProject("usage");
  const unknown = runCli(project, ["lock", "frobnicate"]);
  assert.equal(unknown.status, 2);
  assert.equal(readJsonOutput(unknown, "stderr").error.code, "unknown-subcommand");

  const missingDeck = runCli(project, ["lock", "verify", "--deck", "no-such-deck"]);
  assert.equal(missingDeck.status, 1);
  assert.equal(readJsonOutput(missingDeck, "stderr").decks[0].status, "not-found");

  const help = runCli(project, ["lock", "--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /verify/);
  assert.match(help.stdout, /update/);
  fs.rmSync(project, { recursive: true, force: true });
});

test("the full agent convergence loop passes end to end on a fixture project", () => {
  const project = makeProject("loop");
  const steps = [
    { cmd: ["lock", "update", "--deck", "lock-deck", "--actor", "agent:test"], expect: 0 },
    { cmd: ["lock", "verify", "--deck", "lock-deck"], expect: 0 },
    { cmd: ["edit", "--deck", "lock-deck", "--slide", "intro", "--field", "subtitle", "--value", '"Loop subtitle"', "--actor", "agent:test"], expect: 1 },
    { cmd: ["validate", "--deck", "lock-deck"], expect: 0 },
  ];
  for (const step of steps) {
    const result = runCli(project, step.cmd);
    assert.equal(
      result.status,
      step.expect,
      `step ${JSON.stringify(step.cmd)} must exit ${step.expect}, got ${result.status}: ${result.stdout} ${result.stderr}`,
    );
  }
  fs.rmSync(project, { recursive: true, force: true });
});
