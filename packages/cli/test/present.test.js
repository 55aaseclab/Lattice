import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// M2 A14 — `lattice present --deck <id>` CLI surface: starts the presentation
// server for a lattice.deck.v2 deck without any video backend; v1 decks and
// unknown ids fail explicitly with the documented exit codes.

const cliIndex = fileURLToPath(new URL("../src/index.js", import.meta.url));
const fixtureProject = fileURLToPath(new URL("./fixtures/presentation-project", import.meta.url));

function makeV1Project() {
  const root = mkdtempSync(join(tmpdir(), "lattice-present-v1-"));
  writeFileSync(
    join(root, "lattice.config.js"),
    'export default { title: "V1", decksDir: "decks", outDir: "dist", dev: { port: 4689, host: "localhost" } };\n',
    "utf8",
  );
  mkdirSync(join(root, "decks", "old-deck"), { recursive: true });
  writeFileSync(
    join(root, "decks", "old-deck", "manifest.json"),
    JSON.stringify({ schema: "lattice.deck.v1", id: "old-deck", title: "Old", theme: "simple-light", entry: { content: "./content.js" } }, null, 2),
    "utf8",
  );
  writeFileSync(join(root, "decks", "old-deck", "content.js"), "export default { slides: [] };\n", "utf8");
  return root;
}

test("present requires --deck (exit code 2)", () => {
  const result = spawnSync(process.execPath, [cliIndex, "present"], { cwd: fixtureProject, encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /present requires --deck/);
});

test("present rejects an unknown deck explicitly (exit code 1)", () => {
  const result = spawnSync(process.execPath, [cliIndex, "present", "--deck", "ghost"], { cwd: fixtureProject, encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /unknown deck id: ghost/);
});

test("present rejects a v1 deck with migration guidance instead of presenting it", () => {
  const root = makeV1Project();
  try {
    const result = spawnSync(process.execPath, [cliIndex, "present", "--deck", "old-deck"], { cwd: root, encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /lattice\.deck\.v2 required/);
    assert.match(result.stderr, /lattice migrate --deck old-deck/);
    assert.ok(!result.stdout.includes("present deck"), "a v1 deck must never be presented");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("present starts the server and prints the stable presentation URL without any video backend", async () => {
  const child = spawn(process.execPath, [cliIndex, "present", "--deck", "present-demo", "--port", "4678"], {
    cwd: fixtureProject,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  try {
    const deadline = Date.now() + 30000;
    while (!stdout.includes("present deck") && Date.now() < deadline && child.exitCode === null) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.match(stdout, /presentation server: http:\/\/localhost:\d+\//);
    assert.match(stdout, /present deck "present-demo": \/[^\s]*deck=present-demo&present=1/);
    // The URL must use stable ids only; no backend banner or doctor output.
    assert.ok(!/remotion|hyperframes/i.test(stdout + stderr), "present must not reference a video backend");
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolve) => {
      child.once("exit", resolve);
      setTimeout(resolve, 2000);
    });
  }
});
