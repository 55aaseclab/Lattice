// M7 render gates: reveal appears by stop frame order in real MP4 renders
// (抽帧断言), audioTracks are mixed into one AAC track (ffprobe-verified on
// both backends), cross-backend still parity holds for timeline decks, and
// static (v1) decks keep the pre-timeline host contract untouched.

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

import { compareScreenshotPng } from "../src/commands/screenshot.js";
import { TIMELINE_DECK_ID, writeDeckRegistry, writeProjectConfig, writeTimelineDeck } from "./helpers/timeline-fixture.js";

const cliIndex = fileURLToPath(new URL("../src/index.js", import.meta.url));
const tmpRoot = fileURLToPath(new URL("./tmp", import.meta.url));

function makeProject() {
  const projectRoot = mkdtempSync(path.join(tmpRoot, "m7-render-"));
  writeProjectConfig(projectRoot);
  writeTimelineDeck(projectRoot);
  writeDeckRegistry(projectRoot);
  return projectRoot;
}

function runCli(cwd, args) {
  return spawnSync(process.execPath, [cliIndex, ...args], { cwd, encoding: "utf8", timeout: 600000 });
}

// Remotion serves bundles over an internal HTTP server; when the full suite
// runs many render-bearing test files in parallel, two servers can collide on
// a port and fail a render with a transient 404. The underlying pipeline is
// deterministic, so a retry after a short cooldown is safe and keeps the
// suite's parallel execution intact.
function runCliWithRetry(cwd, args, attempts = 3) {
  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync(process.execPath, [cliIndex, ...args], { cwd, encoding: "utf8", timeout: 600000 });
    if (result.status === 0) return result;
    last = result;
    const transient = /404|ECONNREFUSED|could not select|getStaticCompositions|fetch failed/i.test(`${result.stderr}${result.stdout}`);
    if (!transient) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, attempt * 2000);
  }
  return last;
}


function ffprobeJson(artifactPath) {
  const stdout = execFileSync("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", artifactPath], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

function diffRatio(bufferA, bufferB) {
  const comparison = compareScreenshotPng(bufferA, bufferB);
  if (comparison.dimensionMismatch) throw new Error(`dimension mismatch: ${comparison.width}x${comparison.height} vs ${comparison.baselineWidth}x${comparison.baselineHeight}`);
  return comparison.diffRatio;
}

async function renderStills(projectRoot, backend, frames, label) {
  const dir = path.join(projectRoot, "out", `${backend}-${label}`);
  mkdirSync(dir, { recursive: true });
  for (const frame of frames) {
    const output = path.join(dir, `frame-${String(frame).padStart(5, "0")}.png`);
    const result = runCliWithRetry(projectRoot, ["video", "still", "--deck", TIMELINE_DECK_ID, "--backend", backend, "--frame", String(frame), "--output", output]);
    assert.equal(result.status, 0, `${backend} still ${frame} failed: ${result.stderr}`);
  }
  return dir;
}

function stillPath(dir, frame) {
  return path.join(dir, `frame-${String(frame).padStart(5, "0")}.png`);
}

// Timeline geometry (route main): intro [0,90) stops open@0 point@40;
// reveal [90,190) stops base@90 step-1@130 step-2@160; outro [190,220).
const FRAMES = { beforeStep1: 100, afterStep1: 131, quiet: 145, afterStep2: 161, still: 195 };

test("MP4 renders reveal content by stop frame order (抽帧断言, both backends)", async () => {
  const projectRoot = makeProject();
  try {
    const exported = runCli(projectRoot, ["export", "--deck", TIMELINE_DECK_ID]);
    assert.equal(exported.status, 0, exported.stderr);

    for (const backend of ["remotion", "hyperframes"]) {
      const dir = await renderStills(projectRoot, backend, [FRAMES.beforeStep1, FRAMES.afterStep1, FRAMES.quiet, FRAMES.afterStep2], "order");
      const beforeStep1 = readFileSync(stillPath(dir, FRAMES.beforeStep1));
      const afterStep1 = readFileSync(stillPath(dir, FRAMES.afterStep1));
      const quiet = readFileSync(stillPath(dir, FRAMES.quiet));
      const afterStep2 = readFileSync(stillPath(dir, FRAMES.afterStep2));

      // step-1 reveals at global frame 130 (window 121..130): before it the
      // region is empty, after it visible.
      const revealStep1 = diffRatio(beforeStep1, afterStep1);
      assert.ok(revealStep1 > 0.01, `${backend}: step-1 reveal must change the frame (got ${revealStep1})`);
      // The quiet dwell between the reveal windows paints identical frames.
      const dwell = diffRatio(afterStep1, quiet);
      assert.ok(dwell < 0.001, `${backend}: frames between stops must be identical (got ${dwell})`);
      // step-2 reveals at global frame 160 (window 151..160).
      const revealStep2 = diffRatio(quiet, afterStep2);
      assert.ok(revealStep2 > 0.005, `${backend}: step-2 reveal must change the frame (got ${revealStep2})`);
      // Reveals are cumulative: the final state differs from the first stop.
      const cumulative = diffRatio(afterStep1, afterStep2);
      assert.ok(cumulative > 0.005, `${backend}: step-2 must add to step-1 (got ${cumulative})`);
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("cross-backend frame parity holds for timeline decks (stop boundaries and mid-animation)", async () => {
  const projectRoot = makeProject();
  try {
    const exported = runCli(projectRoot, ["export", "--deck", TIMELINE_DECK_ID]);
    assert.equal(exported.status, 0, exported.stderr);
    const frames = [0, 20, 36, 91, 126, 131, 158, 161, 195];
    const remotionDir = await renderStills(projectRoot, "remotion", frames, "parity");
    const hyperframesDir = await renderStills(projectRoot, "hyperframes", frames, "parity");
    for (const frame of frames) {
      const ratio = diffRatio(readFileSync(stillPath(remotionDir, frame)), readFileSync(stillPath(hyperframesDir, frame)));
      assert.ok(ratio <= 0.005, `frame ${frame}: cross-backend diff ratio ${ratio}`);
    }
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("audioTracks are mixed into a single AAC track (ffprobe, both backends); silent plans stay silent", async () => {
  const projectRoot = makeProject();
  try {
    const exported = runCli(projectRoot, ["export", "--deck", TIMELINE_DECK_ID]);
    assert.equal(exported.status, 0, exported.stderr);

    const totalFrames = 220;
    for (const backend of ["remotion", "hyperframes"]) {
      const output = path.join(projectRoot, "out", `${backend}-audio.mp4`);
      const result = runCliWithRetry(projectRoot, ["video", "render", "--deck", TIMELINE_DECK_ID, "--backend", backend, "--output", output]);
      assert.equal(result.status, 0, `${backend} render failed: ${result.stderr}`);

      const probe = ffprobeJson(output);
      const audioStreams = probe.streams.filter((stream) => stream.codec_type === "audio");
      const videoStreams = probe.streams.filter((stream) => stream.codec_type === "video");
      assert.equal(audioStreams.length, 1, `${backend}: exactly one audio stream`);
      assert.equal(audioStreams[0].codec_name, "aac", `${backend}: aac audio codec`);
      assert.equal(videoStreams.length, 1);
      assert.equal(videoStreams[0].nb_frames, String(totalFrames), `${backend}: frame count unchanged by the audio mix`);
      assert.ok(Number(audioStreams[0].duration) > 1, `${backend}: audio stream carries the deck's tone`);
      // The mixed audio is actually audible content, not digital silence.
      const loudness = spawnSync("ffmpeg", [
        "-hide_banner", "-i", output, "-map", "0:a", "-af", "volumedetect", "-f", "null", "-",
      ], { encoding: "utf8" });
      const meanVolume = /mean_volume:\s*(-?[\d.]+) dB/.exec(loudness.stderr)?.[1];
      assert.ok(meanVolume !== undefined && Number(meanVolume) > -60, `${backend}: mixed track is audible (mean ${meanVolume} dB)`);
    }

    // A silent plan (no audioTracks) keeps the video-only contract.
    const silentManifest = path.join(projectRoot, "decks", TIMELINE_DECK_ID, "manifest.json");
    const manifest = JSON.parse(readFileSync(silentManifest, "utf8"));
    const audioTracks = manifest.timeline.audioTracks;
    delete manifest.timeline.audioTracks;
    writeFileSync(silentManifest, JSON.stringify(manifest, null, 2), "utf8");
    const silentOutput = path.join(projectRoot, "out", "remotion-silent.mp4");
    const silentResult = runCliWithRetry(projectRoot, ["video", "render", "--deck", TIMELINE_DECK_ID, "--backend", "remotion", "--output", silentOutput]);
    assert.equal(silentResult.status, 0, silentResult.stderr);
    const silentProbe = ffprobeJson(silentOutput);
    assert.equal(silentProbe.streams.filter((stream) => stream.codec_type === "audio").length, 0);
    void audioTracks;
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}, { timeout: 600000 });

test("static (v1) plans keep the pre-timeline host contract byte-for-byte at the contract surface", async () => {
  const projectRoot = makeProject();
  try {
    const deckDir = path.join(projectRoot, "decks", TIMELINE_DECK_ID);
    const manifestPath = path.join(deckDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest.timeline;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

    const exported = runCli(projectRoot, ["export", "--deck", TIMELINE_DECK_ID]);
    assert.equal(exported.status, 0, exported.stderr);
    for (const backend of ["remotion", "hyperframes"]) {
      const still = runCli(projectRoot, ["video", "still", "--deck", TIMELINE_DECK_ID, "--backend", backend, "--frame", "0", "--output", path.join(projectRoot, "out", `static-${backend}.png`)]);
      assert.equal(still.status, 0, still.stderr);
    }

    const remotionManifest = JSON.parse(readFileSync(path.join(projectRoot, ".lattice", "generated", "remotion", "host", "public", "lattice-host-manifest.json"), "utf8"));
    for (const clip of remotionManifest.clips) {
      assert.equal("stops" in clip, false, "static host manifest must not carry stops");
      assert.equal("animation" in clip, false, "static host manifest must not carry animation");
    }
    const composition = readFileSync(path.join(projectRoot, ".lattice", "generated", "remotion", "host", "LatticeComposition.jsx"), "utf8");
    assert.ok(!composition.includes("__latticeStopState"), "static composition must not inline the stop driver");
    assert.ok(!composition.includes("data-lattice-anim"), "static composition must not carry animation attributes");

    const hyperframes = readFileSync(path.join(projectRoot, ".lattice", "generated", "hyperframes", "composition", "index.html"), "utf8");
    assert.ok(!hyperframes.includes("__latticeStopState"), "static hyperframes composition must not inline the stop driver");
    assert.ok(!hyperframes.includes("data-lattice-stop="), "static hyperframes canvas must not carry stop attributes");
    assert.match(hyperframes, /style="--lattice-local-frame:0;/, "static canvas keeps the exact pre-timeline style attribute");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("workbench- and CLI-rendered artifacts share one planHash (same compile path)", async () => {
  const projectRoot = makeProject();
  try {
    const exported = runCli(projectRoot, ["export", "--deck", TIMELINE_DECK_ID]);
    assert.equal(exported.status, 0, exported.stderr);
    const planResult = runCli(projectRoot, ["video", "plan", "--deck", TIMELINE_DECK_ID, "--output", path.join(projectRoot, "out", "plan-a.json")]);
    assert.equal(planResult.status, 0, planResult.stderr);
    const planJson = readFileSync(path.join(projectRoot, "out", "plan-a.json"), "utf8");
    assert.ok(planJson.includes("lattice.video-plan.v2"));
    // Deterministic: a second compile produces the identical plan bytes.
    runCli(projectRoot, ["video", "plan", "--deck", TIMELINE_DECK_ID, "--output", path.join(projectRoot, "out", "plan-b.json")]);
    assert.equal(readFileSync(path.join(projectRoot, "out", "plan-b.json"), "utf8"), planJson);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
