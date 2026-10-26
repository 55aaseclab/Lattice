import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ACCUMULATING_FLAGS_BY_COMMAND, parseArgs } from "../src/args.js";

const cliIndex = fileURLToPath(new URL("../src/index.js", import.meta.url));

test("repeated non-accumulating flags keep the pre-M1 last-value-wins behavior", () => {
  // The exact M1 regression repro: "lattice validate --deck demo --deck m1-test"
  // used to produce an Array and crash with "path argument ... Array".
  const { args } = parseArgs(["--deck", "demo", "--deck", "m1-test"]);
  assert.equal(args.deck, "m1-test");
  assert.equal(Array.isArray(args.deck), false);
});

test("parseArgs still treats boolean flags and --values correctly", () => {
  const { args, rest } = parseArgs(["--dry-run", "--deck", "x", "positional", "--empty"]);
  assert.equal(args["dry-run"], true);
  assert.equal(args.deck, "x");
  assert.equal(args.empty, true);
  assert.deepEqual(rest, ["positional"]);
});

test("only migrate --slide accumulates, per the explicit allowlist", () => {
  assert.deepEqual([...ACCUMULATING_FLAGS_BY_COMMAND.keys()], ["migrate"]);
  assert.deepEqual([...ACCUMULATING_FLAGS_BY_COMMAND.get("migrate")], ["slide"]);

  const migrateArgs = parseArgs(["--slide", "intro", "--slide", "chart", "--slide", "closing"], {
    accumulate: ACCUMULATING_FLAGS_BY_COMMAND.get("migrate"),
  }).args;
  assert.deepEqual(migrateArgs.slide, ["intro", "chart", "closing"]);

  // The same flag outside the allowlist stays last-value-wins.
  const nonAccumulating = parseArgs(["--slide", "intro", "--slide", "chart"]).args;
  assert.equal(nonAccumulating.slide, "chart");
});

test("migrate --deck stays last-value-wins even while --slide accumulates", () => {
  const { args } = parseArgs(["--deck", "a", "--deck", "b", "--slide", "s1", "--slide", "s2"], {
    accumulate: ACCUMULATING_FLAGS_BY_COMMAND.get("migrate"),
  });
  assert.equal(args.deck, "b");
  assert.deepEqual(args.slide, ["s1", "s2"]);
});

test("end-to-end: repeated --deck through the real CLI picks the last deck instead of crashing", () => {
  const root = mkdtempSync(join(tmpdir(), "lattice-args-"));
  try {
    mkdirSync(join(root, "decks"), { recursive: true });
    writeFileSync(
      join(root, "lattice.config.js"),
      `export default { title: "Args Fixture", decksDir: "decks", outDir: "dist", registry: "./decks/registry.js", theme: "simple-light" };\n`,
      "utf8",
    );
    writeFileSync(join(root, "decks", "registry.js"), `export const deckRegistry = {};\n`, "utf8");

    const result = spawnSync(process.execPath, [cliIndex, "validate", "--deck", "demo", "--deck", "m1-test"], {
      cwd: root,
      encoding: "utf8",
      timeout: 60000,
      env: process.env,
    });
    // Last value wins: only "m1-test" is validated (and missing here), so the
    // CLI must fail with a deck diagnostic — never the Array "path argument"
    // crash the parser regression introduced.
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes("m1-test"), `stderr must name the last deck: ${result.stderr}`);
    assert.ok(!result.stderr.includes("path argument"), `stderr must not be the Array path crash: ${result.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
