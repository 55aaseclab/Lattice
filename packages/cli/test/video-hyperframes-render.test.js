import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import { ensureBackendsInitialized, getBackend } from "../src/video/registry.js";
import {
  loadConformanceSlideDefinitions,
  makeConformanceBundle,
  makeConformancePlan,
  hashTree,
} from "./video-remotion-fixtures.js";

ensureBackendsInitialized();

const run = promisify(execFile);

// A30-A32 execute real HyperFrames renders (headless Chromium capture +
// ffmpeg encode through the pinned hyperframes CLI). The renders are slow by
// design: no mock may replace them.
const FRAME_INTRO = 0;
const FRAME_PROGRESS_MID = 52; // inside the frame-driven progress slide
const FRAME_ASSET = 85; // inside the bundled-asset slide
const TOTAL_FRAMES = 90;

async function pixelStats(pngPath) {
  const png = PNG.sync.read(readFileSync(pngPath));
  let nonWhite = 0;
  const buckets = new Set();
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i];
    const g = png.data[i + 1];
    const b = png.data[i + 2];
    if (r < 240 || g < 240 || b < 240) nonWhite += 1;
    buckets.add(`${r >> 3},${g >> 3},${b >> 3}`);
  }
  return {
    width: png.width,
    height: png.height,
    nonWhiteRatio: nonWhite / (png.width * png.height),
    colorBuckets: buckets.size,
  };
}

function pixelDiff(pathA, pathB) {
  const a = PNG.sync.read(readFileSync(pathA));
  const b = PNG.sync.read(readFileSync(pathB));
  if (a.width !== b.width || a.height !== b.height) return -1;
  const diff = new PNG({ width: a.width, height: b.height });
  return pixelmatch(new Uint8Array(a.data), new Uint8Array(b.data), new Uint8Array(diff.data), a.width, a.height, { threshold: 0.1 });
}


const suiteRoot = mkdtempSync(join(tmpdir(), "lattice-hyperframes-render-"));
const workDir = join(suiteRoot, ".lattice", "generated", "hyperframes");
const rendersDir = join(workDir, "renders");

// Shared rendered fixtures: one prepare feeds all acceptance renders, exactly
// like repeated CLI stills against one deck.
const shared = {};
async function getShared() {
  if (shared.prepared) return shared;
  const slideDefinitions = await loadConformanceSlideDefinitions();
  const bundleDir = makeConformanceBundle(suiteRoot, { slideDefinitions });
  const plan = makeConformancePlan({ bundleDir, slideDefinitions });
  shared.preCanonicalState = {
    bundleHash: hashTree(bundleDir),
    projectHash: hashTree(suiteRoot, { skip: [".lattice"] }),
  };
  const backend = getBackend("hyperframes");
  const prepared = await backend.prepare({ plan, bundleDir, workDir, projectRoot: suiteRoot });
  shared.prepared = prepared;
  shared.backend = backend;
  shared.plan = plan;
  return shared;
}

test("A30: one bundle renders three non-empty 960x540 stills across slides and mid-frames", async () => {
  const { backend, prepared } = await getShared();

  const stillPaths = {
    intro: join(rendersDir, `still-${FRAME_INTRO}.png`),
    progress: join(rendersDir, `still-${FRAME_PROGRESS_MID}.png`),
    asset: join(rendersDir, `still-${FRAME_ASSET}.png`),
  };
  const artifacts = [];
  for (const [label, frame] of [["intro", FRAME_INTRO], ["progress", FRAME_PROGRESS_MID], ["asset", FRAME_ASSET]]) {
    const artifact = await backend.renderStill({ prepared, frame, output: stillPaths[label] });
    artifacts.push({ label, artifact });
  }

  for (const { label, artifact } of artifacts) {
    assert.equal(artifact.backendId, "hyperframes");
    assert.equal(artifact.planHash, prepared.planHash);
    assert.equal(artifact.metadata.width, 960);
    assert.equal(artifact.metadata.height, 540);
    assert.equal(artifact.metadata.format, "png");
    const stats = await pixelStats(artifact.path);
    assert.equal(stats.width, 960);
    assert.equal(stats.height, 540);
    assert.ok(stats.nonWhiteRatio > 0.01, `${label} still must be non-empty (non-white ratio ${stats.nonWhiteRatio})`);
    assert.ok(stats.colorBuckets > 4, `${label} still must carry real content (${stats.colorBuckets} color buckets)`);
  }

  // Different slides and mid-frames must render visibly different pixels.
  assert.ok(pixelDiff(stillPaths.intro, stillPaths.progress) > 0, "intro vs progress stills must differ");
  assert.ok(pixelDiff(stillPaths.progress, stillPaths.asset) > 0, "progress vs asset stills must differ");
  assert.ok(pixelDiff(stillPaths.intro, stillPaths.asset) > 0, "intro vs asset stills must differ");

  // The frame-driven progress geometry must reflect the canonical frame
  // state: the same progress slide at two different local frames differs.
  const laterProgress = join(rendersDir, `still-progress-late.png`);
  await backend.renderStill({ prepared, frame: FRAME_PROGRESS_MID + 10, output: laterProgress });
  assert.ok(pixelDiff(stillPaths.progress, laterProgress) > 0, "the frame-driven slide must advance with the frame");
});

test("A31: the backend renders the complete MP4 and ffprobe verifies size, fps, frames, duration, and codec", async () => {
  const { backend, prepared, plan } = await getShared();
  const videoPath = join(rendersDir, "video.mp4");

  const artifact = await backend.renderVideo({ prepared, output: videoPath });
  assert.equal(artifact.path, videoPath);
  assert.equal(artifact.metadata.width, 960);
  assert.equal(artifact.metadata.height, 540);
  assert.equal(artifact.metadata.fps, 30);
  assert.equal(artifact.metadata.totalFrames, TOTAL_FRAMES);
  assert.equal(artifact.metadata.codec, "h264");
  assert.equal(artifact.metadata.format, "mp4");

  // Independent ffprobe evidence straight from the system binary.
  const { stdout } = await run("ffprobe", ["-v", "error", "-print_format", "json", "-show_format", "-show_streams", videoPath]);
  const probe = JSON.parse(stdout);
  const stream = probe.streams.find((s) => s.codec_type === "video");
  assert.equal(stream.codec_name, "h264");
  assert.equal(stream.width, 960);
  assert.equal(stream.height, 540);
  assert.equal(stream.avg_frame_rate, "30/1");
  assert.equal(stream.nb_frames, String(TOTAL_FRAMES));
  const duration = Number(probe.format.duration);
  const expected = TOTAL_FRAMES / plan.fps;
  assert.ok(Math.abs(duration - expected) < 0.2, `duration ${duration} must be ~${expected}s`);
  assert.ok(statSync(videoPath).size > 10_000, "the MP4 must carry real encoded content");

  // The encoded frames must not all be identical: decoded frames from two
  // different points in the timeline differ.
  const f1 = join(rendersDir, "extracted-0.png");
  const f2 = join(rendersDir, "extracted-45.png");
  await run("ffmpeg", ["-y", "-v", "error", "-i", videoPath, "-vf", "select=eq(n\\,0)", "-frames:v", "1", f1]);
  await run("ffmpeg", ["-y", "-v", "error", "-i", videoPath, "-vf", "select=eq(n\\,45)", "-frames:v", "1", f2]);
  assert.ok(pixelDiff(f1, f2) > 0, "decoded MP4 frames must differ across the timeline");
});

test("A32: rendering leaves canonical inputs untouched and writes only inside the generated directory", async () => {
  const { backend, prepared, preCanonicalState } = await getShared();

  // The stills and video above were rendered from the bundle copy; the
  // canonical bundle tree and the whole project (outside .lattice) must be
  // byte-identical to their pre-render state.
  const bundleDir = prepared.bundlePath;
  assert.equal(hashTree(bundleDir), preCanonicalState.bundleHash, "canonical bundle unchanged after rendering");
  assert.equal(hashTree(suiteRoot, { skip: [".lattice"] }), preCanonicalState.projectHash, "no writes outside .lattice/generated");

  const still = await backend.renderStill({
    prepared,
    frame: FRAME_PROGRESS_MID,
    output: join(rendersDir, "a32-check.png"),
  });
  assert.ok(still.path.startsWith(workDir + "/") || still.path === workDir, "still artifacts stay inside .lattice/generated/hyperframes");
  const video = await backend.renderVideo({ prepared, output: join(rendersDir, "a32-check.mp4") });
  assert.ok(video.path.startsWith(workDir + "/") || video.path === workDir, "video artifacts stay inside .lattice/generated/hyperframes");

  assert.equal(hashTree(bundleDir), preCanonicalState.bundleHash, "canonical bundle unchanged after second render pass");
  assert.equal(hashTree(suiteRoot, { skip: [".lattice"] }), preCanonicalState.projectHash, "project tree still unchanged");

  // The plan identity is preserved across renders: the prepared plan hash
  // matches the host manifest and the generated video-plan.json.
  const hostManifest = JSON.parse(readFileSync(join(prepared.workDir, "composition", "lattice-host-manifest.json"), "utf8"));
  assert.equal(hostManifest.planHash, prepared.planHash);
  const writtenPlan = JSON.parse(readFileSync(join(prepared.workDir, "video-plan.json"), "utf8"));
  assert.equal(writtenPlan.provenance.bundleHash, prepared.bundleHash);
});

test("A29-parity: the same FrameAddress renders byte-identical stills; different frames differ", async () => {
  const { backend, prepared } = await getShared();
  const firstPath = join(rendersDir, "repeat-first.png");
  const secondPath = join(rendersDir, "repeat-second.png");

  await backend.renderStill({ prepared, frame: FRAME_PROGRESS_MID, output: firstPath });
  await backend.renderStill({ prepared, frame: FRAME_PROGRESS_MID, output: secondPath });

  const first = readFileSync(firstPath);
  const second = readFileSync(secondPath);
  assert.ok(first.equals(second), "same-frame HyperFrames stills must be byte-identical");

  const otherPath = join(rendersDir, "repeat-other-frame.png");
  await backend.renderStill({ prepared, frame: FRAME_INTRO, output: otherPath });
  assert.ok(pixelDiff(firstPath, otherPath) > 0, "different frames must not collapse to the same pixels");
});

test("render failures keep diagnosable failure logs and typed errors", async () => {
  const { backend, prepared } = await getShared();

  await assert.rejects(
    () => backend.renderStill({ prepared, frame: TOTAL_FRAMES + 5, output: join(rendersDir, "beyond.png") }),
    (error) => error.name === "VideoBackendError" && error.cause === "invalid-frame",
  );

  const failuresDir = join(prepared.workDir, "failures");
  assert.ok(existsSync(failuresDir), "failure log directory must exist");
  const logs = readdirSync(failuresDir).filter((name) => name.endsWith(".log"));
  assert.ok(logs.length > 0, "at least one failure log must be preserved");
  const log = readFileSync(join(failuresDir, logs[logs.length - 1]), "utf8");
  assert.ok(log.includes("DO NOT EDIT"), "failure log carries the DO NOT EDIT marker");
  assert.ok(log.includes(prepared.planHash), "failure log names the plan hash");
  assert.ok(log.includes("error:"), "failure log carries the error message");
});

test("inspectArtifact rejects a corrupt artifact as probe-failed", async () => {
  const { backend } = await getShared();
  const bogusPath = join(rendersDir, "not-a-video.mp4");
  await (await import("node:fs/promises")).writeFile(bogusPath, Buffer.from("this is not an mp4", "utf8"));

  await assert.rejects(
    () => backend.inspectArtifact(bogusPath),
    (error) => error.name === "VideoBackendError" && error.backendId === "hyperframes" && error.cause === "probe-failed",
  );
});

after(async () => {
  rmSync(suiteRoot, { recursive: true, force: true });
});
