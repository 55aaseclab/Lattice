import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createServer as createViteServer } from "vite";
import { INSPECTION_SCHEMA, resolveChromiumExecutable, runInspection } from "../src/commands/inspect.js";

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "inspect-project");
const binPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js");
const join = (...parts) => parts.join("/");

function fakeEnv({ entries = {}, cacheEntries = [], exists = new Set() } = {}) {
  return {
    env: entries,
    homedir: "/home/tester",
    platform: "linux",
    exists: (candidate) => exists.has(candidate),
    readdir: (directory) => cacheEntries[directory] ?? [],
    join,
  };
}

test("resolveChromiumExecutable prefers the explicit --browser path", () => {
  const resolved = resolveChromiumExecutable({
    explicitPath: "/explicit/chromium",
    ...fakeEnv({
      entries: { LATTICE_CHROMIUM: "/env/chromium" },
      exists: new Set(["/explicit/chromium", "/env/chromium", "/usr/bin/google-chrome"]),
    }),
  });
  assert.equal(resolved, "/explicit/chromium");
});

test("resolveChromiumExecutable falls back to LATTICE_CHROMIUM then system paths", () => {
  const withEnv = resolveChromiumExecutable(fakeEnv({
    entries: { LATTICE_CHROMIUM: "/env/chromium" },
    exists: new Set(["/env/chromium", "/usr/bin/google-chrome"]),
  }));
  assert.equal(withEnv, "/env/chromium");

  const systemOnly = resolveChromiumExecutable(fakeEnv({
    exists: new Set(["/usr/bin/chromium-browser", "/usr/bin/google-chrome"]),
  }));
  assert.equal(systemOnly, "/usr/bin/google-chrome");
});

test("resolveChromiumExecutable picks the newest Playwright cache revision and full Chromium first", () => {
  const cache = "/home/tester/.cache/ms-playwright";
  const resolved = resolveChromiumExecutable(fakeEnv({
    cacheEntries: {
      [cache]: ["chromium-1148", "chromium_headless_shell-1243", "chromium-1208", "ffmpeg-1011"],
    },
    exists: new Set([
      `${cache}/chromium-1148/chrome-linux/chrome`,
      `${cache}/chromium-1208/chrome-linux/chrome`,
      `${cache}/chromium_headless_shell-1243/chrome-headless-shell-linux/chrome-headless-shell`,
    ]),
  }));
  assert.equal(resolved, `${cache}/chromium-1208/chrome-linux/chrome`);
});

test("resolveChromiumExecutable scans PLAYWRIGHT_BROWSERS_PATH and returns null without candidates", () => {
  const cache = "/custom-browsers";
  const resolved = resolveChromiumExecutable(fakeEnv({
    entries: { PLAYWRIGHT_BROWSERS_PATH: cache },
    cacheEntries: { [cache]: ["chromium-1300"] },
    exists: new Set([`${cache}/chromium-1300/chrome-linux/chrome`]),
  }));
  assert.equal(resolved, `${cache}/chromium-1300/chrome-linux/chrome`);

  assert.equal(resolveChromiumExecutable(fakeEnv({ exists: new Set() })), null);
});

test("runInspection rejects business projects without a config", async () => {
  await assert.rejects(
    runInspection({ cwd: os.tmpdir() }),
    /lattice\.config\.js not found/,
  );
});

test("runInspection rejects projects with no decks before launching a browser", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-inspect-"));
  fs.writeFileSync(path.join(parent, "lattice.config.js"), "export default { title: 'Empty' };\n");
  await assert.rejects(
    runInspection({ cwd: parent, exists: () => false }),
    /no decks found/,
  );
});

test("runInspection rejects unknown inspect options before doing any work", async () => {
  await assert.rejects(
    runInspection({ cwd: os.tmpdir(), args: { rendered: true, deck: "clean", watcher: "1" } }),
    (error) => {
      assert.match(error.message, /unknown inspect option\(s\): --watcher/);
      return true;
    },
  );
});

test("runInspection accepts the canonical --rendered spelling", async () => {
  await assert.rejects(
    runInspection({ cwd: fixtureDir, args: { rendered: true, deck: "clean" }, exists: () => false, readdir: () => [] }),
    /no headless Chromium found/,
  );
});

test("runInspection fails with an actionable message when no Chromium is available", async () => {
  await assert.rejects(
    runInspection({ cwd: fixtureDir, args: { deck: "clean" }, exists: () => false, readdir: () => [] }),
    (error) => {
      assert.match(error.message, /no headless Chromium found/);
      assert.match(error.message, /--browser/);
      return true;
    },
  );
});

test("lattice inspect --help prints command help from the real entrypoint, exits 0, and has no inspection side effects", () => {
  // Runs from packages/cli (no lattice.config.js): any attempt to load
  // config, start a server, or launch a browser would fail loudly on stderr
  // or hang, so a clean exit with empty stderr proves help short-circuits.
  const result = spawnSync(process.execPath, [binPath, "inspect", "--help"], { encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /lattice inspect --rendered/);
  assert.match(result.stdout, /--deck <id>/);
  assert.match(result.stdout, /--out <file>/);
  assert.match(result.stdout, /--timeout <ms>/);
  assert.match(result.stdout, /--browser <path>/);
  assert.match(result.stdout, /compatibility alias/i);
  assert.match(result.stdout, /lattice\.inspection\.v1/);
  assert.match(result.stdout, /Exit codes?: 0 clean/);
  assert.doesNotMatch(result.stdout, /"schema"|"decks"|\[lattice\] (dev server|inspect failed)/);
});

const chromiumExecutable = resolveChromiumExecutable();
const skipReason = chromiumExecutable ? false : "no headless Chromium available on this machine";

test("runInspection accepts a comma-separated --deck list", { skip: skipReason }, async () => {
  const { report, exitCode } = await runInspection({
    cwd: fixtureDir,
    args: { rendered: true, deck: "clean,broken-image", timeout: 30000 },
  });
  assert.equal(exitCode, 1);
  assert.deepEqual(report.decks.map((deck) => deck.deck), ["clean", "broken-image"]);
  assert.deepEqual(report.decks.map((deck) => deck.ok), [true, false]);
  assert.equal(report.decks[1].errors[0].type, "missing-asset");
});

test("inspect --rendered collects a clean deck with exit code 0 and a schema'd artifact", { skip: skipReason }, async () => {
  const { report, exitCode } = await runInspection({
    cwd: fixtureDir,
    args: { rendered: true, deck: "clean", timeout: 30000 },
    generatedAt: "2026-10-23T00:00:00.000Z",
  });
  assert.equal(exitCode, 0);
  assert.equal(report.schema, INSPECTION_SCHEMA);
  assert.equal(report.generatedAt, "2026-10-23T00:00:00.000Z");
  assert.equal(report.ok, true);
  assert.equal(report.errorCount, 0);
  assert.equal(report.browser.executable, chromiumExecutable);
  assert.ok(report.browser.version);
  assert.equal(report.decks.length, 1);
  const [deck] = report.decks;
  assert.equal(deck.deck, "clean");
  assert.equal(deck.ok, true);
  assert.deepEqual(deck.errors, []);
  assert.ok(deck.slides >= 1);
  assert.ok(deck.readiness);
  assert.ok(deck.url.includes("?deck=clean&inspect=1"));
  assert.deepEqual(deck.pageErrors, []);
});

test("inspect reports clipped content as an addressable text-overflow finding", { skip: skipReason }, async () => {
  const { report, exitCode } = await runInspection({ cwd: fixtureDir, args: { deck: "overflow", timeout: 30000 } });
  assert.equal(exitCode, 1);
  assert.equal(report.ok, false);
  const [error] = report.decks[0].errors;
  assert.equal(error.type, "text-overflow");
  assert.equal(error.area, "body");
  assert.equal(error.element, "clipped copy");
  assert.ok(error.overflow.y > 0);
  assert.match(error.message, /overflows area "body"/);
});

test("inspect reports missing images as missing-asset findings", { skip: skipReason }, async () => {
  const { report, exitCode } = await runInspection({ cwd: fixtureDir, args: { deck: "broken-image", timeout: 30000 } });
  assert.equal(exitCode, 1);
  const [error] = report.decks[0].errors;
  assert.equal(error.type, "missing-asset");
  assert.ok(error.url.includes("missing.png"));
  assert.deepEqual(report.decks[0].readiness.images.failed, [error.url]);
});

test("inspect fails with ready-timeout when the app never signals readiness", { skip: skipReason }, async () => {
  const { report, exitCode } = await runInspection({ cwd: fixtureDir, args: { deck: "stall", timeout: 2500 } });
  assert.equal(exitCode, 1);
  assert.equal(report.ok, false);
  const [error] = report.decks[0].errors;
  assert.equal(error.type, "ready-timeout");
  assert.match(error.message, /app-ready signal/);
  assert.equal(report.decks[0].slides, 0);
});

test("inspect blocks on uncaught page errors even when the inspection report is clean", { skip: skipReason }, async () => {
  const { report, exitCode } = await runInspection({ cwd: fixtureDir, args: { rendered: true, deck: "crash", timeout: 30000 } });
  assert.equal(exitCode, 1);
  assert.equal(report.ok, false);
  const [deck] = report.decks;
  assert.ok(deck.pageErrors.some((text) => text.includes("fixture page crash")), JSON.stringify(deck.pageErrors));
  const pageErrorFindings = deck.errors.filter((error) => error.type === "page-error");
  assert.equal(pageErrorFindings.length, 1);
  assert.equal(pageErrorFindings[0].slide, "crash");
  assert.equal(pageErrorFindings[0].area, null);
  assert.equal(pageErrorFindings[0].element, "page");
  assert.match(pageErrorFindings[0].message, /uncaught page error: fixture page crash/);
  assert.equal(deck.ok, false);
  assert.equal(report.errorCount >= 1, true);
});

test("inspect does not publish before image decode settles", { skip: skipReason }, async () => {
  const { report, exitCode } = await runInspection({ cwd: fixtureDir, args: { rendered: true, deck: "slow-image", timeout: 30000 } });
  assert.equal(exitCode, 0);
  const [deck] = report.decks;
  assert.equal(deck.ok, true);
  assert.deepEqual(deck.errors, []);
  assert.equal(deck.readiness.images.total, 1);
  assert.deepEqual(deck.readiness.images.failed, []);
  // The fixture image responds after 700ms; readiness must have waited for
  // load + decode instead of publishing an unstable early report.
  assert.ok(deck.readiness.durationMs >= 400, `readiness.durationMs was ${deck.readiness.durationMs}`);
});

test("inspect reports a hung image decode as ready-timeout naming the blocking image", { skip: skipReason }, async () => {
  // The runtime's in-page readiness deadline (10s) expires before the CLI
  // timeout, so the published report itself names the hung image.
  const { report, exitCode } = await runInspection({ cwd: fixtureDir, args: { rendered: true, deck: "hung-image", timeout: 12000 } });
  assert.equal(exitCode, 1);
  assert.equal(report.ok, false);
  const [deck] = report.decks;
  const readyTimeout = deck.errors.find((error) => error.type === "ready-timeout");
  assert.ok(readyTimeout, JSON.stringify(deck.errors));
  assert.match(readyTimeout.message, /hung\.png/);
  assert.equal(deck.slides, 0);
});

test("inspect reports a failing theme token as a blocking contrast finding", { skip: skipReason }, async () => {
  const { report, exitCode } = await runInspection({ cwd: fixtureDir, args: { rendered: true, deck: "contrast", timeout: 30000 } });
  assert.equal(exitCode, 1);
  assert.equal(report.ok, false);
  const [deck] = report.decks;
  assert.equal(deck.errors.length, 1, JSON.stringify(deck.errors));
  const finding = deck.errors[0];
  assert.equal(finding.type, "contrast");
  assert.equal(finding.slide, "contrast");
  assert.equal(finding.token, "title-color/slide-bg");
  assert.deepEqual(finding.colors, { foreground: "#777777", background: "#ffffff" });
  assert.ok(finding.ratio < finding.minimum, `ratio ${finding.ratio} must fall below ${finding.minimum}`);
  assert.match(finding.message, /contrast is .*:1; minimum is/);
});

test("inspect reports over-budget slides as blocking density findings", { skip: skipReason }, async () => {
  const { report, exitCode } = await runInspection({ cwd: fixtureDir, args: { rendered: true, deck: "density", timeout: 30000 } });
  assert.equal(exitCode, 1);
  assert.equal(report.ok, false);
  const [deck] = report.decks;
  assert.equal(deck.errors.length, 1, JSON.stringify(deck.errors));
  const finding = deck.errors[0];
  assert.equal(finding.type, "density");
  assert.equal(String(finding.slide), "1");
  assert.ok(finding.counts.elements > finding.limits.elements, JSON.stringify(finding));
  assert.equal(finding.limits.elements, 60);
  assert.match(finding.message, /density threshold/);
});

test("inspect reports used webfonts with FontFace status error as blocking missing-font findings", { skip: skipReason }, async () => {
  const { report, exitCode } = await runInspection({ cwd: fixtureDir, args: { rendered: true, deck: "missing-font", timeout: 30000 } });
  assert.equal(exitCode, 1);
  assert.equal(report.ok, false);
  const [deck] = report.decks;
  assert.equal(deck.errors.length, 1, JSON.stringify(deck.errors));
  const finding = deck.errors[0];
  assert.equal(finding.type, "missing-font");
  assert.equal(finding.slide, "missing-font");
  assert.equal(finding.element, "Lattice Fixture Missing");
  assert.equal(finding.family, "Lattice Fixture Missing");
  assert.match(finding.message, /webfont failed to load/);
  assert.deepEqual(deck.readiness.fontsFailed, ["Lattice Fixture Missing"]);
});

test("inspect leaves system-font fallback and unused webfonts unflagged", { skip: skipReason }, async () => {
  const { report, exitCode } = await runInspection({ cwd: fixtureDir, args: { rendered: true, deck: "clean-fonts", timeout: 30000 } });
  assert.equal(exitCode, 0);
  assert.equal(report.ok, true);
  const [deck] = report.decks;
  assert.deepEqual(deck.errors, []);
  assert.deepEqual(deck.readiness.fontsFailed, []);
  assert.ok(deck.slides >= 1);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("inspect --rendered first run cannot publish an Outdated Optimize Dep ready-timeout", { skip: skipReason }, async () => {
  // Reproduce the verification-matrix failure: while the inspection run's
  // pages load, a second real Vite server with a different config hash
  // re-optimizes the shared dependency cache, so in-flight optimized-dep
  // requests answer HTTP 504 "Outdated Optimize Dep" and the app never boots.
  const fixtureNodeModules = path.join(fixtureDir, "node_modules");
  for (const dir of [".vite", ".vite-lattice-inspect"]) {
    fs.rmSync(path.join(fixtureNodeModules, dir), { recursive: true, force: true });
  }

  const inspection = runInspection({ cwd: fixtureDir, args: { rendered: true, deck: "clean", timeout: 30000 } });
  // Start the intruder mid-load, exactly like `npm run validate` (its registry
  // server) or a dev server racing the inspection run.
  const intruderStarted = sleep(1200).then(() => createViteServer({
    root: fixtureDir,
    appType: "custom",
    server: { middlewareMode: true },
    define: { __LATTICE_MATRIX_INTRUDER__: "true" }, // distinct config hash
  }));

  let report;
  let exitCode;
  let intruder;
  try {
    ({ report, exitCode } = await inspection);
    intruder = await intruderStarted;
  } finally {
    if (intruder) await intruder.close().catch(() => {});
    else await intruderStarted.then((server) => server.close().catch(() => {}), () => {});
  }

  assert.equal(exitCode, 0, JSON.stringify(report.decks, null, 2));
  const [deck] = report.decks;
  assert.equal(deck.deck, "clean");
  assert.equal(deck.ok, true, JSON.stringify(deck.errors, null, 2));
  assert.ok(deck.slides >= 1, "clean deck must render slides on the first cold run");
  assert.equal(deck.errors.some((error) => error.type === "ready-timeout"), false);
  // The measured pass itself must be free of optimized-dep 504s: the run may
  // absorb transients during warmup, never during measurement.
  const measurement504s = deck.consoleErrors.filter((entry) =>
    (entry.url ?? "").includes("/node_modules/.vite") && entry.text.includes("504"));
  assert.deepEqual(measurement504s, [], JSON.stringify(deck.consoleErrors, null, 2));
});
