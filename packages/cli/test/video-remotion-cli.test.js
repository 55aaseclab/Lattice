import assert from "node:assert/strict";
import { test, after } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, cpSync, readFileSync, rmSync, existsSync, statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import { validateVideoPlan } from "@55aaseclab/lattice-runtime/video-plan";
import { hashTree } from "./video-remotion-fixtures.js";

const cliIndex = fileURLToPath(new URL("../src/index.js", import.meta.url));
const fixtureDir = fileURLToPath(new URL("./fixtures/video-conformance-project", import.meta.url));
const run = promisify(execFile);

// The CLI pipeline runs against a copy of the fixture inside the repo tree
// (packages/cli/test/tmp is gitignored): vite must resolve the workspace
// runtime package by walking up, and generated artifacts must never touch the
// tracked fixture.
const testTmpRoot = fileURLToPath(new URL("./tmp", import.meta.url));
mkdirSync(testTmpRoot, { recursive: true });
const projectRoot = mkdtempSync(join(testTmpRoot, "m4-conformance-"));

function runCli(args, { timeout = 300000 } = {}) {
  return spawnSync(process.execPath, [cliIndex, ...args], {
    cwd: projectRoot,
    encoding: "utf8",
    timeout,
    env: process.env,
  });
}

after(async () => {
  rmSync(projectRoot, { recursive: true, force: true });
});

let bundlePath = null;
let planPath = null;
let deckSourceHashBefore = null;

test("CLI export produces the Slide Web Bundle for the conformance deck", () => {
  mkdirSync(projectRoot, { recursive: true });
  cpSync(fixtureDir, projectRoot, { recursive: true });
  deckSourceHashBefore = hashTree(join(projectRoot, "decks", "conformance"));

  const result = runCli(["export", "--deck", "conformance", "--out", join(projectRoot, "dist-bundle")]);
  assert.equal(result.status, 0, `export failed: ${result.stderr}\n${result.stdout}`);
  bundlePath = join(projectRoot, "dist-bundle");
  for (const entry of ["index.html", "manifest.json", "content.json", "layout.json", "notes.json"]) {
    assert.ok(existsSync(join(bundlePath, entry)), `${entry} missing from the export bundle`);
  }
});

test("CLI video plan compiles the engine-neutral plan with real provenance", () => {
  planPath = join(projectRoot, "plan.json");
  const result = runCli(["video", "plan", "--deck", "conformance", "--bundle-dir", bundlePath, "--output", planPath]);
  assert.equal(result.status, 0, `video plan failed: ${result.stderr}\n${result.stdout}`);
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  assert.equal(validateVideoPlan(plan).ok, true);
  assert.equal(plan.totalFrames, 90);
  assert.equal(plan.fps, 30);
  assert.equal(plan.width, 960);
  assert.equal(plan.height, 540);
  assert.equal(plan.clips.length, 3);
  assert.match(plan.provenance.bundleHash, /^[0-9a-f]{64}$/);
  assert.match(plan.provenance.deckHash, /^[0-9a-f]{64}$/);
});

test("CLI video still renders a real 960x540 PNG into the requested output", () => {
  const outPath = join(projectRoot, "out", "remotion.png");
  const result = runCli([
    "video", "still",
    "--deck", "conformance",
    "--backend", "remotion",
    "--frame", "52",
    "--bundle-dir", bundlePath,
    "--output", outPath,
  ]);
  assert.equal(result.status, 0, `video still failed: ${result.stderr}\n${result.stdout}`);
  assert.ok(existsSync(outPath), "the still must be written to the requested output");
  assert.ok(result.stdout.includes("Still written to"), `stdout should report the artifact: ${result.stdout}`);

  const png = PNG.sync.read(readFileSync(outPath));
  assert.equal(png.width, 960);
  assert.equal(png.height, 540);
  let nonWhite = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i] < 240 || png.data[i + 1] < 240 || png.data[i + 2] < 240) nonWhite += 1;
  }
  assert.ok(nonWhite / (png.width * png.height) > 0.01, "the CLI still must be non-empty");

  // The generated host lives in the project's isolated generated directory.
  const generatedDir = join(projectRoot, ".lattice", "generated", "remotion");
  assert.ok(existsSync(join(generatedDir, "host", "host-config.js")), "generated host must exist under .lattice/generated/remotion");
  assert.ok(existsSync(join(generatedDir, "remotion-project.json")));
});

test("CLI video render produces an MP4 that ffprobe verifies end to end", async () => {
  const outPath = join(projectRoot, "out", "remotion.mp4");
  const result = runCli([
    "video", "render",
    "--deck", "conformance",
    "--backend", "remotion",
    "--bundle-dir", bundlePath,
    "--output", outPath,
  ]);
  assert.equal(result.status, 0, `video render failed: ${result.stderr}\n${result.stdout}`);
  assert.ok(result.stdout.includes("Video written to"), `stdout should report the artifact: ${result.stdout}`);

  const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", outPath]);
  const probe = JSON.parse(stdout);
  const stream = probe.streams.find((s) => s.codec_type === "video");
  assert.equal(stream.codec_name, "h264");
  assert.equal(stream.width, 960);
  assert.equal(stream.height, 540);
  assert.equal(stream.avg_frame_rate, "30/1");
  assert.equal(stream.nb_frames, "90");
  assert.ok(Math.abs(Number(probe.format.duration) - 3) < 0.2);
  assert.ok(statSync(outPath).size > 10_000);
});

test("CLI render refuses to write into the canonical deck source", () => {
  const result = runCli([
    "video", "render",
    "--deck", "conformance",
    "--backend", "remotion",
    "--bundle-dir", bundlePath,
    "--output", join(projectRoot, "decks", "conformance", "evil.mp4"),
  ], { timeout: 120000 });
  assert.equal(result.status, 2, "writing into the deck source must exit 2");
  assert.ok(result.stderr.includes("canonical deck source"), `stderr must name the guard: ${result.stderr}`);
  assert.ok(!existsSync(join(projectRoot, "decks", "conformance", "evil.mp4")), "no artifact may be written into the deck source");
});

test("CLI still rejects out-of-range frames with exit 2", () => {
  const result = runCli([
    "video", "still",
    "--deck", "conformance",
    "--backend", "remotion",
    "--frame", "999",
    "--bundle-dir", bundlePath,
    "--output", join(projectRoot, "out", "beyond.png"),
  ], { timeout: 120000 });
  assert.equal(result.status, 2);
  assert.ok(result.stderr.includes("outside the plan range"), `stderr: ${result.stderr}`);
});

test("A28: CLI renders leave the canonical deck source byte-identical", () => {
  const deckDir = join(projectRoot, "decks", "conformance");
  assert.equal(hashTree(deckDir), deckSourceHashBefore, "canonical deck source unchanged by export, plan, still, and render");
  assert.ok(existsSync(join(projectRoot, ".lattice", "generated", "remotion")), "generated outputs live in the isolation directory");
});

test("CLI video doctor reports the installed Remotion toolchain as available", () => {
  const result = runCli(["video", "doctor", "--backend", "remotion"], { timeout: 120000 });
  assert.equal(result.status, 0, `doctor failed: ${result.stderr}\n${result.stdout}`);
  assert.ok(result.stdout.includes("Backend: remotion"));
  assert.ok(result.stdout.includes("Status: available"), `doctor must report availability: ${result.stdout}`);
  assert.ok(result.stdout.includes("4.0.539"), `doctor must report the exact installed Remotion version: ${result.stdout}`);
});

test("CLI video still requires a backend id", () => {
  const result = runCli(["video", "still", "--deck", "conformance", "--frame", "0"], { timeout: 60000 });
  assert.equal(result.status, 2);
  assert.ok(result.stderr.includes("--backend"));
});

test("CLI video still without a real bundle fails fast", () => {
  // No dist/static-decks bundle and no --bundle-dir: a v2 deck cannot render.
  const result = runCli([
    "video", "render", "--deck", "conformance", "--backend", "remotion",
    "--output", join(projectRoot, "out", "nope.mp4"),
  ], { timeout: 120000 });
  assert.equal(result.status, 2);
  assert.ok(
    result.stderr.includes("no real Slide Web Bundle identity") || result.stderr.includes("requires a real Slide Web Bundle"),
    `stderr: ${result.stderr}`,
  );
});

function listTmpGenerated() {
  try {
    return readdirSync(join(projectRoot, ".lattice", "generated", "remotion"));
  } catch {
    return [];
  }
}
void listTmpGenerated;
