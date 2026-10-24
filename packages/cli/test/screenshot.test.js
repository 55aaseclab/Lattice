import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { PNG } from "pngjs";
import { resolveChromiumExecutable } from "../src/commands/browser.js";
import { SCREENSHOT_SCHEMA, compareScreenshotPng, runScreenshot, screenshotHelpText } from "../src/commands/screenshot.js";

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "inspect-project");
const binPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "index.js");
const chromiumExecutable = resolveChromiumExecutable();
const skipReason = chromiumExecutable ? false : "no headless Chromium available on this machine";

const sha256 = (file) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function assertValidPng(file, { width = 960, height = 540 } = {}) {
  // Captures are element screenshots of the slide canvas at its authored
  // 960x540 geometry (Reveal renders scale 1 inside the app shell at the
  // fixed 1280x720/DPR 1 viewport), so dimensions are deterministic.
  const buffer = fs.readFileSync(file);
  assert.deepEqual([...buffer.subarray(0, 8)], PNG_SIGNATURE, `${file} is not a PNG`);
  const png = PNG.sync.read(buffer);
  assert.equal(png.width, width, `${file} width`);
  assert.equal(png.height, height, `${file} height`);
  return png;
}

const solidPng = ({ width, height, color }) => {
  const png = new PNG({ width, height });
  for (let index = 0; index < png.data.length; index += 4) {
    png.data[index] = color[0];
    png.data[index + 1] = color[1];
    png.data[index + 2] = color[2];
    png.data[index + 3] = 255;
  }
  return PNG.sync.write(png);
};

test("compareScreenshotPng yields zero diff for identical pixels and metrics for mutations", () => {
  const baseline = solidPng({ width: 4, height: 4, color: [255, 255, 255] });
  const identical = compareScreenshotPng(baseline, baseline);
  assert.equal(identical.dimensionMismatch, false);
  assert.equal(identical.diffPixels, 0);
  assert.equal(identical.diffRatio, 0);

  const mutated = solidPng({ width: 4, height: 4, color: [255, 255, 255] });
  // Flip one visible pixel (row 0, col 0) to opaque red.
  const decoded = PNG.sync.read(mutated);
  decoded.data[0] = 255;
  decoded.data[1] = 0;
  decoded.data[2] = 0;
  const result = compareScreenshotPng(PNG.sync.write(decoded), baseline);
  assert.equal(result.dimensionMismatch, false);
  assert.equal(result.diffPixels, 1);
  assert.equal(result.diffRatio, 1 / 16);
  assert.ok(result.diffBuffer.length > 8);
  assert.deepEqual([...result.diffBuffer.subarray(0, 8)], PNG_SIGNATURE);
});

test("compareScreenshotPng flags dimension mismatches without a diff image", () => {
  const result = compareScreenshotPng(solidPng({ width: 3, height: 3, color: [0, 0, 0] }), solidPng({ width: 4, height: 4, color: [0, 0, 0] }));
  assert.equal(result.dimensionMismatch, true);
  assert.equal(result.diffBuffer, null);
  assert.equal(result.diffRatio, null);
});

test("runScreenshot rejects unknown options before doing any work", async () => {
  await assert.rejects(
    runScreenshot({ cwd: os.tmpdir(), args: { rendered: true, deck: "stable" } }),
    (error) => {
      assert.match(error.message, /unknown screenshot option\(s\): --rendered/);
      return true;
    },
  );
});

test("runScreenshot rejects invalid --max-diff-ratio values", async () => {
  await assert.rejects(
    runScreenshot({ cwd: os.tmpdir(), args: { "max-diff-ratio": "1.5" } }),
    /invalid --max-diff-ratio/,
  );
  await assert.rejects(
    runScreenshot({ cwd: os.tmpdir(), args: { "max-diff-ratio": "abc" } }),
    /invalid --max-diff-ratio/,
  );
});

test("lattice screenshot --help prints command help from the real entrypoint, exits 0, and has no side effects", () => {
  const result = spawnSync(process.execPath, [binPath, "screenshot", "--help"], { encoding: "utf8", timeout: 30000 });
  assert.equal(result.status, 0, `stderr: ${result.stderr}`);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /lattice screenshot/);
  assert.match(result.stdout, /--update-baseline/);
  assert.match(result.stdout, /--baseline-dir <dir>/);
  assert.match(result.stdout, /--max-diff-ratio <n>/);
  assert.match(result.stdout, /lattice\.screenshots\.v1/);
  assert.match(result.stdout, /Exit codes?: 0 clean/);
  assert.doesNotMatch(result.stdout, /"schema"|"decks"|\[lattice\] (dev server|screenshot failed)/);
  assert.equal(screenshotHelpText().length > 0, true);
});

// Shared workspace for the sequential capture → compare → mutate E2E chain.
let work = null;
const ensureWork = () => {
  if (!work) {
    work = {
      dir: fs.mkdtempSync(path.join(os.tmpdir(), "lattice-screens-")),
      baselines: null,
      out: null,
    };
    work.baselines = path.join(work.dir, "baselines");
    work.out = path.join(work.dir, "out");
  }
  return work;
};

test("screenshot --update-baseline explicitly creates valid canonical baselines", { skip: skipReason }, async () => {
  const { baselines, out } = ensureWork();
  const { report, exitCode } = await runScreenshot({
    cwd: fixtureDir,
    args: {
      deck: "stable",
      "update-baseline": true,
      "baseline-dir": baselines,
      out,
      timeout: 30000,
    },
  });
  assert.equal(exitCode, 0, JSON.stringify(report.decks, null, 2));
  assert.equal(report.schema, SCREENSHOT_SCHEMA);
  assert.equal(report.mode, "update");
  assert.equal(report.ok, true);
  assert.deepEqual(report.viewport, { width: 1280, height: 720, deviceScaleFactor: 1 });
  const [deck] = report.decks;
  assert.equal(deck.deck, "stable");
  assert.deepEqual(deck.slides.map((slide) => slide.status), ["created", "created"]);
  for (const slide of deck.slides) {
    assert.ok(slide.baseline, JSON.stringify(slide));
    assertValidPng(path.resolve(fixtureDir, slide.baseline));
    assertValidPng(path.resolve(fixtureDir, slide.actual));
  }
});

test("clean repeat comparison diffs 0 and never rewrites baselines", { skip: skipReason }, async () => {
  const { baselines, out } = ensureWork();
  const baselineFiles = [
    path.join(baselines, "stable", "1.png"),
    path.join(baselines, "stable", "2.png"),
  ];
  const hashesBefore = baselineFiles.map(sha256);

  const { report, exitCode } = await runScreenshot({
    cwd: fixtureDir,
    args: { deck: "stable", "baseline-dir": baselines, out, timeout: 30000 },
  });

  assert.equal(exitCode, 0, JSON.stringify(report.decks, null, 2));
  assert.equal(report.mode, "compare");
  assert.equal(report.ok, true);
  const [deck] = report.decks;
  assert.deepEqual(deck.slides.map((slide) => slide.status), ["match", "match"]);
  assert.deepEqual(deck.slides.map((slide) => slide.diffRatio), [0, 0]);
  assert.deepEqual(deck.errors, []);
  // Comparison must not silently rewrite baselines.
  assert.deepEqual(baselineFiles.map(sha256), hashesBefore);
  // No stale diff artifacts on clean matches.
  for (const slide of deck.slides) {
    assert.equal(slide.diff, null);
    assert.equal(fs.existsSync(path.join(out, "stable", `${slideFileNameFor(slide.address)}.diff.png`)), false);
  }
});

function slideFileNameFor(address) {
  return String(address).replace(/[^A-Za-z0-9._-]+/g, "-") || "slide";
}

test("a deterministic visible mutation produces a blocking visual-regression finding with retained artifacts", { skip: skipReason }, async () => {
  const { baselines, out } = ensureWork();
  const baselineFiles = [
    path.join(baselines, "stable", "1.png"),
    path.join(baselines, "stable", "2.png"),
  ];
  const hashesBefore = baselineFiles.map(sha256);
  process.env.FIXTURE_VARIANT = "b";
  try {
    const { report, exitCode } = await runScreenshot({
      cwd: fixtureDir,
      args: { deck: "stable", "baseline-dir": baselines, out, timeout: 30000 },
    });
    assert.equal(exitCode, 1);
    assert.equal(report.ok, false);
    const [deck] = report.decks;
    const finding = deck.errors.find((error) => error.type === "visual-regression");
    assert.ok(finding, JSON.stringify(deck.errors, null, 2));
    assert.equal(finding.slide, "1");
    assert.ok(finding.diffRatio > 0, JSON.stringify(finding));
    assert.ok(finding.diffPixels > 0);
    assert.match(finding.message, /pixel diff [\d.]+% \(\d+ px, limit 0\); diff: /);
    assertValidPng(path.resolve(fixtureDir, finding.artifact));
    assertValidPng(path.resolve(fixtureDir, finding.diff));
    assert.equal(deck.slides[0].status, "diff");
    // Unchanged second slide still matches and keeps no stale diff artifact.
    assert.equal(deck.slides[1].status, "match");
    // The failing comparison must not rewrite baselines.
    assert.deepEqual(baselineFiles.map(sha256), hashesBefore);
  } finally {
    delete process.env.FIXTURE_VARIANT;
  }
});

test("comparison against a missing baseline is a blocking finding and retains the actual capture", { skip: skipReason }, async () => {
  const { baselines, out } = ensureWork();
  const { report, exitCode } = await runScreenshot({
    cwd: fixtureDir,
    args: { deck: "solo", "baseline-dir": baselines, out, timeout: 30000 },
  });
  assert.equal(exitCode, 1);
  assert.equal(report.ok, false);
  const [deck] = report.decks;
  assert.equal(deck.errors.length, 1, JSON.stringify(deck.errors));
  const finding = deck.errors[0];
  assert.equal(finding.type, "missing-baseline");
  assert.equal(finding.slide, "1");
  assert.match(finding.message, /--update-baseline/);
  assert.ok(finding.artifact);
  assertValidPng(path.resolve(fixtureDir, finding.artifact));
  assert.equal(deck.slides[0].status, "missing-baseline");
  assert.equal(deck.slides[0].baseline, null);
  assert.equal(fs.existsSync(path.join(baselines, "solo", "1.png")), false);
});

test("the real entrypoint runs capture, writes the report file, and exits 0 for new baselines", { skip: skipReason }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-screens-bin-"));
  const baselines = path.join(dir, "baselines");
  const out = path.join(dir, "out");
  const reportFile = path.join(dir, "report.json");
  const result = spawnSync(process.execPath, [
    binPath,
    "screenshot",
    "--deck",
    "solo",
    "--update-baseline",
    "--baseline-dir",
    baselines,
    "--out",
    out,
    "--report",
    reportFile,
    "--timeout",
    "30000",
  ], { encoding: "utf8", timeout: 120000, cwd: fixtureDir });
  assert.equal(result.status, 0, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.equal(result.stderr, "");
  const written = JSON.parse(result.stdout);
  assert.equal(written.schema, SCREENSHOT_SCHEMA);
  assert.equal(written.mode, "update");
  assert.equal(JSON.parse(fs.readFileSync(reportFile, "utf8")).schema, SCREENSHOT_SCHEMA);
  assertValidPng(path.join(baselines, "solo", "1.png"));
  assertValidPng(path.join(out, "solo", "1.png"));
});

test("runScreenshot accepts a comma-separated --deck list", { skip: skipReason }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-screens-list-"));
  const { report, exitCode } = await runScreenshot({
    cwd: fixtureDir,
    args: {
      deck: "clean,solo",
      "update-baseline": true,
      "baseline-dir": path.join(dir, "baselines"),
      out: path.join(dir, "out"),
      timeout: 30000,
    },
  });
  assert.equal(exitCode, 0, JSON.stringify(report.decks, null, 2));
  assert.deepEqual(report.decks.map((deck) => deck.deck), ["clean", "solo"]);
  assert.deepEqual(report.decks.map((deck) => deck.slides.length), [2, 1]);
  assert.ok(fs.existsSync(path.join(dir, "baselines", "clean", "1.png")));
  assert.ok(fs.existsSync(path.join(dir, "baselines", "solo", "1.png")));
});

test("a deck that cannot render is an infrastructure failure: real entrypoint exits 2", { skip: skipReason }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-screens-stall-"));
  const baselines = path.join(dir, "baselines");
  const out = path.join(dir, "out");
  const reportFile = path.join(dir, "report.json");
  const result = spawnSync(process.execPath, [
    binPath,
    "screenshot",
    "--deck",
    "stall",
    "--timeout",
    "1000",
    "--baseline-dir",
    baselines,
    "--out",
    out,
    "--report",
    reportFile,
  ], { encoding: "utf8", timeout: 120000, cwd: fixtureDir });
  assert.equal(result.status, 2, `stdout: ${result.stdout.slice(0, 400)}\nstderr: ${result.stderr}`);
  // The versioned report is still produced and names the capture failure.
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema, SCREENSHOT_SCHEMA);
  assert.equal(report.ok, false);
  assert.equal(report.decks[0].deck, "stall");
  assert.equal(report.decks[0].errors[0].type, "capture-failed");
  assert.equal(JSON.parse(fs.readFileSync(reportFile, "utf8")).schema, SCREENSHOT_SCHEMA);
  // No baselines may be created for a deck that failed to render.
  assert.equal(fs.existsSync(path.join(baselines, "stall")), false);
});

test("real entrypoint rejects unknown options with exit 2 and no report", { skip: skipReason }, () => {
  const result = spawnSync(process.execPath, [binPath, "screenshot", "--deck", "stable", "--bogus"], { encoding: "utf8", timeout: 30000, cwd: fixtureDir });
  assert.equal(result.status, 2, `stdout: ${result.stdout}\nstderr: ${result.stderr}`);
  assert.match(result.stderr, /unknown screenshot option\(s\): --bogus/);
  assert.equal(result.stdout, "");
});
