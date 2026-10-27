import assert from "node:assert/strict";
import { test, after } from "node:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, cpSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { PNG } from "pngjs";
import { ensureBackendsInitialized, getBackend } from "../src/video/registry.js";
import { hashVideoPlan } from "@55aaseclab/lattice-runtime/video-plan";
import {
  loadConformanceSlideDefinitions,
  makeConformanceBundle,
  makeConformancePlan,
  hashTree,
} from "./video-remotion-fixtures.js";

ensureBackendsInitialized();

const cliIndex = fileURLToPath(new URL("../src/index.js", import.meta.url));
const fixtureDir = fileURLToPath(new URL("./fixtures/video-conformance-project", import.meta.url));

// The CLI pipeline runs against a copy of the fixture inside the repo tree
// (packages/cli/test/tmp is gitignored): vite must resolve the workspace
// runtime package by walking up, and generated artifacts must never touch the
// tracked fixture.
const cliTmpRoot = fileURLToPath(new URL("./tmp", import.meta.url));
mkdirSync(cliTmpRoot, { recursive: true });

// A34 compares the two backends' pixels for the same canonical frames. The
// frames cover every stop/scene boundary (each plan clip start), the final
// frame, and fixed mid-frames — including the A26/A30 mid-frames.
const STOP_BOUNDARY_FRAMES = [0, 30, 75];
const FIXED_MID_FRAMES = [15, 52, 85];
const LAST_FRAME = 89;
const PARITY_FRAMES = [...new Set([...STOP_BOUNDARY_FRAMES, ...FIXED_MID_FRAMES, LAST_FRAME])].sort((a, b) => a - b);

// Fixed-environment visual thresholds (PRD 7.3: pre-approved SSIM and max
// diff ratio for cross-engine comparisons). Both backends are pinned to the
// same Chromium executable (HYPERFRAMES_BROWSER_PATH = the Remotion-resolved
// browser) and the generated HyperFrames composition neutralizes the engine's
// substitute-webfont injection and text-rendering rewrite, so rendering is
// structurally identical. The measured residual on this fixed environment is
// a deterministic ±1/255 text-antialiasing rounding difference on glyph edge
// pixels (2026-10-26, Chrome for Testing 153.0.8010.12 for both engines):
//   max channel difference: 1/255
//   differing-pixel ratio:  <= 0.28% of the frame
//   windowed SSIM:          1.000000 (grayscale, 8x8 windows)
// A wrong slide, a wrong frame state, a missing asset, or a stylesheet
// regression produces differences orders of magnitude beyond these bounds.
const PARITY_THRESHOLDS = Object.freeze({
  maxChannelDiff: 1,
  maxDiffPixelRatio: 0.005,
  minSsim: 0.999,
});

function grayscale(png) {
  const gray = new Float64Array(png.width * png.height);
  for (let i = 0, j = 0; i < png.data.length; i += 4, j += 1) {
    gray[j] = 0.299 * png.data[i] + 0.587 * png.data[i + 1] + 0.114 * png.data[i + 2];
  }
  return gray;
}

function windowedSsim(grayA, grayB, width, height, windowSize = 8) {
  const C1 = 6.5025;
  const C2 = 58.5225;
  let total = 0;
  let windows = 0;
  for (let wy = 0; wy + windowSize <= height; wy += windowSize) {
    for (let wx = 0; wx + windowSize <= width; wx += windowSize) {
      let meanA = 0;
      let meanB = 0;
      const n = windowSize * windowSize;
      for (let y = 0; y < windowSize; y += 1) {
        for (let x = 0; x < windowSize; x += 1) {
          meanA += grayA[(wy + y) * width + wx + x];
          meanB += grayB[(wy + y) * width + wx + x];
        }
      }
      meanA /= n;
      meanB /= n;
      let varA = 0;
      let varB = 0;
      let covAB = 0;
      for (let y = 0; y < windowSize; y += 1) {
        for (let x = 0; x < windowSize; x += 1) {
          const da = grayA[(wy + y) * width + wx + x] - meanA;
          const db = grayB[(wy + y) * width + wx + x] - meanB;
          varA += da * da;
          varB += db * db;
          covAB += da * db;
        }
      }
      varA /= n - 1;
      varB /= n - 1;
      covAB /= n - 1;
      total += ((2 * meanA * meanB + C1) * (2 * covAB + C2)) / ((meanA * meanA + meanB * meanB + C1) * (varA + varB + C2));
      windows += 1;
    }
  }
  return windows > 0 ? total / windows : 0;
}

/** Pixel comparison plus an amplified diff artifact (identical pixels stay white). */
function comparePixels(pathA, pathB, diffPngPath) {
  const a = PNG.sync.read(readFileSync(pathA));
  const b = PNG.sync.read(readFileSync(pathB));
  assert.equal(a.width, b.width, "both backends must render the same canvas width");
  assert.equal(a.height, b.height, "both backends must render the same canvas height");

  const diff = new PNG({ width: a.width, height: a.height });
  let differing = 0;
  let maxChannelDiff = 0;
  for (let i = 0; i < a.data.length; i += 4) {
    const dr = Math.abs(a.data[i] - b.data[i]);
    const dg = Math.abs(a.data[i + 1] - b.data[i + 1]);
    const db = Math.abs(a.data[i + 2] - b.data[i + 2]);
    const channelMax = Math.max(dr, dg, db);
    if (channelMax > 0) differing += 1;
    if (channelMax > maxChannelDiff) maxChannelDiff = channelMax;
    const amplified = Math.min(255, channelMax * 128);
    diff.data[i] = 255 - amplified;
    diff.data[i + 1] = 255 - amplified;
    diff.data[i + 2] = 255 - amplified;
    diff.data[i + 3] = 255;
  }
  if (diffPngPath) writeFileSync(diffPngPath, PNG.sync.write(diff));

  return {
    width: a.width,
    height: a.height,
    differingPixels: differing,
    diffPixelRatio: differing / (a.width * a.height),
    maxChannelDiff,
    ssim: windowedSsim(grayscale(a), grayscale(b), a.width, a.height),
  };
}

function assertWithinThresholds(frame, metrics) {
  assert.ok(
    metrics.maxChannelDiff <= PARITY_THRESHOLDS.maxChannelDiff,
    `frame ${frame}: max channel diff ${metrics.maxChannelDiff} exceeds the fixed threshold ${PARITY_THRESHOLDS.maxChannelDiff}`,
  );
  assert.ok(
    metrics.diffPixelRatio <= PARITY_THRESHOLDS.maxDiffPixelRatio,
    `frame ${frame}: differing-pixel ratio ${metrics.diffPixelRatio.toFixed(5)} exceeds the fixed threshold ${PARITY_THRESHOLDS.maxDiffPixelRatio}`,
  );
  assert.ok(
    metrics.ssim >= PARITY_THRESHOLDS.minSsim,
    `frame ${frame}: SSIM ${metrics.ssim.toFixed(6)} falls below the fixed threshold ${PARITY_THRESHOLDS.minSsim}`,
  );
}

const suiteRoot = mkdtempSync(join(tmpdir(), "lattice-video-parity-"));
const parityDiffsDir = join(suiteRoot, ".lattice", "generated", "parity-diffs");

// Shared prepared renders: both backends consume the exact same plan object
// and bundle directory.
const shared = {};
async function getSharedPrepared() {
  if (shared.remotion) return shared;
  const slideDefinitions = await loadConformanceSlideDefinitions();
  const bundleDir = makeConformanceBundle(suiteRoot, { slideDefinitions });
  const plan = makeConformancePlan({ bundleDir, slideDefinitions });
  shared.plan = plan;
  shared.bundleDir = bundleDir;
  shared.remotion = await getBackend("remotion").prepare({
    plan,
    bundleDir,
    workDir: join(suiteRoot, ".lattice", "generated", "remotion"),
    projectRoot: suiteRoot,
  });
  shared.hyperframes = await getBackend("hyperframes").prepare({
    plan,
    bundleDir,
    workDir: join(suiteRoot, ".lattice", "generated", "hyperframes"),
    projectRoot: suiteRoot,
  });
  shared.stills = {};
  return shared;
}

test("A33: both backends consume the identical VideoPlan hash and prepared metadata agrees field by field", async () => {
  const { plan, remotion, hyperframes } = await getSharedPrepared();

  assert.equal(remotion.planHash, hyperframes.planHash);
  assert.equal(remotion.planHash, hashVideoPlan(plan));
  assert.equal(remotion.bundleHash, hyperframes.bundleHash);
  assert.equal(remotion.bundleHash, plan.provenance.bundleHash);
  assert.notEqual(remotion.workDir, hyperframes.workDir, "each backend prepares in its own generated directory");

  // Both generated hosts carry the same canonical plan bytes.
  const remotionPlanBytes = readFileSync(join(remotion.workDir, "video-plan.json"), "utf8");
  const hyperframesPlanBytes = readFileSync(join(hyperframes.workDir, "video-plan.json"), "utf8");
  assert.equal(remotionPlanBytes, hyperframesPlanBytes, "both backends must persist the identical canonical plan");

  const remotionManifest = JSON.parse(readFileSync(join(remotion.workDir, "host", "public", "lattice-host-manifest.json"), "utf8"));
  const hyperframesManifest = JSON.parse(readFileSync(join(hyperframes.workDir, "composition", "lattice-host-manifest.json"), "utf8"));
  for (const field of ["planHash", "bundleHash", "deckId", "routeId", "width", "height", "fps", "totalFrames", "slideBinding"]) {
    assert.deepEqual(hyperframesManifest[field], remotionManifest[field], `host manifests must agree on ${field}`);
  }
  assert.deepEqual(
    hyperframesManifest.clips.map(({ slideId, startFrame, durationFrames, contentIndex }) => ({ slideId, startFrame, durationFrames, contentIndex })),
    remotionManifest.clips.map(({ slideId, startFrame, durationFrames, contentIndex }) => ({ slideId, startFrame, durationFrames, contentIndex })),
    "host manifests must agree on every clip boundary",
  );
});

test("A34: both backends pass visual parity at every stop/scene boundary, the last frame, and fixed mid-frames", async () => {
  const { remotion, hyperframes } = await getSharedPrepared();
  mkdirSync(parityDiffsDir, { recursive: true });

  const remotionBackend = getBackend("remotion");
  const hyperframesBackend = getBackend("hyperframes");
  const summary = { thresholds: PARITY_THRESHOLDS, frames: {} };

  for (const frame of PARITY_FRAMES) {
    const remotionPath = join(remotion.workDir, "parity", `remotion-f${frame}.png`);
    const hyperframesPath = join(hyperframes.workDir, "parity", `hyperframes-f${frame}.png`);
    const diffPath = join(parityDiffsDir, `frame-${String(frame).padStart(4, "0")}-diff.png`);

    await remotionBackend.renderStill({ prepared: remotion, frame, output: remotionPath });
    await hyperframesBackend.renderStill({ prepared: hyperframes, frame, output: hyperframesPath });
    shared.stills[frame] = { remotion: remotionPath, hyperframes: hyperframesPath };

    const metrics = comparePixels(remotionPath, hyperframesPath, diffPath);
    summary.frames[frame] = metrics;
    assertWithinThresholds(frame, metrics);
  }

  writeFileSync(join(parityDiffsDir, "parity-summary.json"), JSON.stringify(summary, null, 2), "utf8");

  // Parity evidence is an artifact of the generated directories, never source.
  assert.ok(parityDiffsDir.startsWith(join(suiteRoot, ".lattice", "generated") + "/"));
});

test("A34: scene-boundary stills carry real distinct content on both backends", async () => {
  await getSharedPrepared();
  // The A34 run rendered every boundary frame for both backends.
  for (const backendId of ["remotion", "hyperframes"]) {
    const [first, second, third] = STOP_BOUNDARY_FRAMES.map((frame) => shared.stills[frame][backendId]);
    assert.ok(existsSync(first) && existsSync(second) && existsSync(third));
    assert.ok(comparePixels(first, second).differingPixels > 0, `${backendId} boundaries must render distinct slides`);
    assert.ok(comparePixels(second, third).differingPixels > 0, `${backendId} boundaries must render distinct slides`);
    assert.ok(comparePixels(first, third).differingPixels > 0, `${backendId} boundaries must render distinct slides`);
  }
});

test("A35: the same deck renders consecutively through --backend hyperframes and --backend remotion without source changes", async () => {
  const cliProject = mkdtempSync(join(cliTmpRoot, "parity-cli-"));
  try {
    cpSync(fixtureDir, cliProject, { recursive: true });
    const runCli = (args) => spawnSync(process.execPath, [cliIndex, ...args], {
      cwd: cliProject,
      encoding: "utf8",
      timeout: 600000,
      env: process.env,
    });

    mkdirSync(join(cliProject, "out"), { recursive: true });
    const bundleOut = join(cliProject, "dist-bundle");
    const exported = runCli(["export", "--deck", "conformance", "--out", bundleOut]);
    assert.equal(exported.status, 0, `export failed: ${exported.stderr}\n${exported.stdout}`);

    const deckHash = () => hashTree(join(cliProject, "decks", "conformance"));
    const bundleHash = () => hashTree(bundleOut);
    const hashBefore = { deck: deckHash(), bundle: bundleHash() };

    const hyperframesOut = join(cliProject, "out", "switch-hyperframes.png");
    const first = runCli([
      "video", "still", "--deck", "conformance", "--backend", "hyperframes",
      "--frame", "52", "--bundle-dir", bundleOut, "--output", hyperframesOut,
    ]);
    assert.equal(first.status, 0, `hyperframes CLI still failed: ${first.stderr}\n${first.stdout}`);
    const hashAfterHyperframes = { deck: deckHash(), bundle: bundleHash() };

    const remotionOut = join(cliProject, "out", "switch-remotion.png");
    const second = runCli([
      "video", "still", "--deck", "conformance", "--backend", "remotion",
      "--frame", "52", "--bundle-dir", bundleOut, "--output", remotionOut,
    ]);
    assert.equal(second.status, 0, `remotion CLI still failed: ${second.stderr}\n${second.stdout}`);
    const hashAfterRemotion = { deck: deckHash(), bundle: bundleHash() };

    assert.deepEqual(hashAfterHyperframes, hashBefore, "switching to hyperframes must not modify canonical sources");
    assert.deepEqual(hashAfterRemotion, hashBefore, "switching to remotion must not modify canonical sources");
    assert.ok(existsSync(hyperframesOut) && existsSync(remotionOut), "both backends must produce their artifacts");
    assert.ok(existsSync(join(cliProject, ".lattice", "generated", "hyperframes")), "hyperframes host lives in its generated directory");
    assert.ok(existsSync(join(cliProject, ".lattice", "generated", "remotion")), "remotion host lives in its generated directory");

    const metrics = comparePixels(hyperframesOut, remotionOut, join(parityDiffsDir, "cli-f52-diff.png"));
    assertWithinThresholds("cli-f52", metrics);
  } finally {
    rmSync(cliProject, { recursive: true, force: true });
  }
});

test("A35: no dev/present/static-export surface statically reaches a video backend module or package", async () => {
  const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

  function staticImports(filePath) {
    const source = readFileSync(filePath, "utf8");
    // Static import/export-from statements only. Dynamic `await import("...")`
    // is the sanctioned lazy boundary and is intentionally NOT followed.
    const specifiers = [];
    for (const match of source.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s*["']([^"']+)["']/g)) {
      specifiers.push(match[1]);
    }
    for (const match of source.matchAll(/(?:^|\n)\s*export\s[^;]*?from\s*["']([^"']+)["']/g)) {
      specifiers.push(match[1]);
    }
    return specifiers;
  }

  function resolveModule(fromFile, specifier) {
    if (!specifier.startsWith(".")) return { external: specifier };
    return { local: new URL(specifier, new URL(`file://${fromFile}`)).pathname };
  }

  function collectStaticGraph(entryFile) {
    const visited = new Set();
    const externals = new Set();
    const queue = [entryFile];
    while (queue.length > 0) {
      const current = queue.pop();
      if (visited.has(current)) continue;
      visited.add(current);
      let source;
      try {
        source = readFileSync(current, "utf8");
      } catch {
        continue;
      }
      for (const specifier of staticImports(current)) {
        const resolved = resolveModule(current, specifier);
        if (resolved.external) {
          externals.add(resolved.external);
          continue;
        }
        queue.push(resolved.local);
      }
    }
    return { visited, externals };
  }

  const indexFile = join(srcDir, "index.js");
  const { visited, externals } = collectStaticGraph(indexFile);

  for (const entry of [...visited]) {
    const normalized = entry.replaceAll("\\", "/");
    assert.ok(
      !normalized.includes("/video/remotion/"),
      `static graph from index.js must not reach the Remotion adapter (reached ${normalized})`,
    );
    assert.ok(
      !normalized.includes("/video/hyperframes/"),
      `static graph from index.js must not reach the HyperFrames adapter (reached ${normalized})`,
    );
    assert.ok(
      !normalized.endsWith("/video/registry.js"),
      `static graph from index.js must not reach the backend registry (reached ${normalized})`,
    );
  }
  for (const external of externals) {
    assert.ok(
      !/^(remotion|@remotion\/|hyperframes)/.test(external),
      `static graph from index.js must not import a video backend package (${external})`,
    );
  }

  // Each no-video surface must not statically import anything from video/.
  for (const command of ["dev.js", "present.js", "export.js"]) {
    const commandFile = join(srcDir, "commands", command);
    const { visited: commandModules } = collectStaticGraph(commandFile);
    for (const moduleFile of commandModules) {
      const normalized = moduleFile.replaceAll("\\", "/");
      assert.ok(
        !normalized.includes("/video/"),
        `${command} must not statically import video modules (reached ${normalized})`,
      );
    }
  }

  // The adapters load their engine packages lazily: any engine import must be
  // dynamic, so a missing backend dependency cannot break the other surfaces.
  const adapterFiles = [
    join(srcDir, "video", "remotion", "adapter.js"),
    join(srcDir, "video", "remotion", "render-support.js"),
    join(srcDir, "video", "remotion", "host-template.js"),
    join(srcDir, "video", "hyperframes", "adapter.js"),
    join(srcDir, "video", "hyperframes", "render-support.js"),
    join(srcDir, "video", "hyperframes", "host-template.js"),
  ];
  for (const adapterFile of adapterFiles) {
    for (const specifier of staticImports(adapterFile)) {
      assert.ok(
        !/^(remotion|@remotion\/|hyperframes|gsap)/.test(specifier),
        `${adapterFile} must not statically import engine packages (${specifier})`,
      );
    }
  }
});

test("A35: video backend packages are only ever imported dynamically inside the adapters", async () => {
  const videoDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "video");
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".js")) files.push(full);
    }
  };
  walk(videoDir);
  assert.ok(files.length > 0);

  for (const file of files) {
    const normalized = file.replaceAll("\\", "/");
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/(?:^|\n)\s*import\s[^;]*?from\s*["']([^"']+)["']/g)) {
      assert.ok(
        !/^(remotion|@remotion\/|hyperframes|gsap)/.test(match[1]),
        `${file} must not statically import ${match[1]}`,
      );
    }
    // Dynamic engine imports are allowed only inside the owning adapter, and
    // the HyperFrames adapter shells out to its CLI instead of importing it.
    const dynamic = [...source.matchAll(/import\(\s*["']([^"']+)["']\s*\)/g)].map((m) => m[1]);
    const engineImports = dynamic.filter((spec) => /^(remotion|@remotion\/|hyperframes|gsap)/.test(spec));
    if (normalized.includes("/video/remotion/")) {
      assert.ok(
        engineImports.every((spec) => spec === "remotion" || spec.startsWith("@remotion/")),
        `unexpected engine import in ${file}: ${engineImports.join(", ")}`,
      );
    } else {
      assert.equal(engineImports.length, 0, `${file} must not import engine packages`);
    }
  }
});

after(async () => {
  rmSync(suiteRoot, { recursive: true, force: true });
});
