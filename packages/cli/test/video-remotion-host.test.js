import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureBackendsInitialized, getBackend } from "../src/video/registry.js";
import {
  generateRemotionHost,
  extractBundleStylesheets,
  REMOTION_COMPOSITION_ID,
  REMOTION_HOST_SCHEMA,
} from "../src/video/remotion/host-template.js";
import {
  loadConformanceSlideDefinitions,
  makeConformanceBundle,
  makeConformancePlan,
  hashTree,
} from "./video-remotion-fixtures.js";

ensureBackendsInitialized();

function makeProject() {
  return mkdtempSync(join(tmpdir(), "lattice-remotion-host-"));
}

test("extractBundleStylesheets keeps link and inline order and ignores non-stylesheet links", () => {
  const stylesheets = extractBundleStylesheets([
    "<!doctype html><html><head>",
    "<meta charset=\"utf-8\">",
    "<link rel=\"icon\" href=\"./favicon.ico\">",
    "<link rel=\"stylesheet\" crossorigin href=\"./assets/entry-AAA.css\">",
    "<style>body{margin:0}</style>",
    "<link href=\"./assets/missing-rel.css\">",
    "<link rel=\"stylesheet\" href=\"./assets/entry-BBB.css\">",
    "</head><body></body></html>",
  ].join("\n"));
  assert.deepEqual(stylesheets, [
    { kind: "link", href: "./assets/entry-AAA.css" },
    { kind: "inline", css: "body{margin:0}" },
    { kind: "link", href: "./assets/entry-BBB.css" },
  ]);
});

test("remotion prepare generates a complete deterministic host with DO NOT EDIT provenance", async () => {
  const projectRoot = makeProject();
  try {
    const slideDefinitions = await loadConformanceSlideDefinitions();
    const bundleDir = makeConformanceBundle(projectRoot, { slideDefinitions });
    const plan = makeConformancePlan({ bundleDir, slideDefinitions });
    const backend = getBackend("remotion");
    const workDir = join(projectRoot, ".lattice", "generated", "remotion");

    const prepared = await backend.prepare({ plan, bundleDir, workDir, projectRoot });
    const hostDir = join(prepared.workDir, "host");

    for (const file of ["index.js", "Root.jsx", "LatticeComposition.jsx", "host-config.js"]) {
      const content = readFileSync(join(hostDir, file), "utf8");
      assert.ok(content.includes("DO NOT EDIT"), `${file} must carry DO NOT EDIT`);
      assert.ok(content.includes(prepared.planHash), `${file} must carry the plan hash`);
    }

    const hostManifest = JSON.parse(readFileSync(join(hostDir, "public", "lattice-host-manifest.json"), "utf8"));
    assert.equal(hostManifest.schema, REMOTION_HOST_SCHEMA);
    assert.equal(hostManifest.compositionId, REMOTION_COMPOSITION_ID);
    assert.equal(hostManifest.planHash, prepared.planHash);
    assert.equal(hostManifest.bundleHash, prepared.bundleHash);
    assert.equal(hostManifest.width, 960);
    assert.equal(hostManifest.height, 540);
    assert.equal(hostManifest.fps, 30);
    assert.equal(hostManifest.totalFrames, 90);
    assert.equal(hostManifest.slideBinding, "route-position");
    assert.deepEqual(
      hostManifest.clips.map((clip) => [clip.slideId, clip.startFrame, clip.durationFrames, clip.contentIndex]),
      [
        ["intro", 0, 30, 0],
        ["progress", 30, 45, 1],
        ["asset", 75, 15, 2],
      ],
    );
    assert.ok(hostManifest.stylesheets.some((entry) => entry.kind === "link" && entry.href.endsWith(".css")),
      "the bundle stylesheet surface must be carried into the host manifest");

    const configSource = readFileSync(join(hostDir, "host-config.js"), "utf8");
    assert.ok(configSource.includes(`compositionId: "${REMOTION_COMPOSITION_ID}"`));
    assert.ok(configSource.includes("durationInFrames: 90"));

    // The Slide Web Bundle is copied, never referenced or moved: the original
    // bundle stays canonical.
    const { computeBundleIdentityHash } = await import("../src/video/bundle.js");
    assert.equal(computeBundleIdentityHash(join(hostDir, "public", "bundle")), computeBundleIdentityHash(bundleDir));

    // The generated host is deterministic: regenerating produces identical bytes.
    const firstTree = JSON.stringify({
      index: readFileSync(join(hostDir, "index.js"), "utf8"),
      root: readFileSync(join(hostDir, "Root.jsx"), "utf8"),
      composition: readFileSync(join(hostDir, "LatticeComposition.jsx"), "utf8"),
      config: readFileSync(join(hostDir, "host-config.js"), "utf8"),
      manifest: readFileSync(join(hostDir, "public", "lattice-host-manifest.json"), "utf8"),
    });
    await backend.prepare({ plan, bundleDir, workDir, projectRoot });
    const secondTree = JSON.stringify({
      index: readFileSync(join(hostDir, "index.js"), "utf8"),
      root: readFileSync(join(hostDir, "Root.jsx"), "utf8"),
      composition: readFileSync(join(hostDir, "LatticeComposition.jsx"), "utf8"),
      config: readFileSync(join(hostDir, "host-config.js"), "utf8"),
      manifest: readFileSync(join(hostDir, "public", "lattice-host-manifest.json"), "utf8"),
    });
    assert.equal(firstTree, secondTree, "host regeneration must be byte-identical");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("remotion prepare keeps the M3 project surface and adds the host section", async () => {
  const projectRoot = makeProject();
  try {
    const slideDefinitions = await loadConformanceSlideDefinitions();
    const bundleDir = makeConformanceBundle(projectRoot, { slideDefinitions });
    const plan = makeConformancePlan({ bundleDir, slideDefinitions });
    const backend = getBackend("remotion");
    const workDir = join(projectRoot, ".lattice", "generated", "remotion");

    const prepared = await backend.prepare({ plan, bundleDir, workDir, projectRoot });

    const projectJson = JSON.parse(readFileSync(join(prepared.workDir, "remotion-project.json"), "utf8"));
    assert.equal(projectJson.schema, "lattice.remotion-project.v1");
    assert.equal(projectJson.bundleDir, bundleDir);
    assert.equal(projectJson.bundleHash, prepared.bundleHash);
    assert.equal(projectJson.planHash, prepared.planHash);
    assert.ok(projectJson.videoPlanPath.endsWith("video-plan.json"));
    assert.equal(projectJson.host.compositionId, REMOTION_COMPOSITION_ID);
    assert.ok(projectJson.host.entryPoint.endsWith("index.js"));
    assert.ok(projectJson.host.manifestPath.endsWith("lattice-host-manifest.json"));

    const header = readFileSync(join(prepared.workDir, "LATTICE_REMOTION.md"), "utf8");
    assert.ok(header.includes("DO NOT EDIT"));
    assert.ok(header.includes(`plan-hash: ${prepared.planHash}`));
    assert.ok(header.includes(`bundle-hash: ${prepared.bundleHash}`));
    assert.ok(existsSync(join(prepared.workDir, "video-plan.json")));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("unbindable clips are tolerated at prepare and fail rendering with unbound-slide-content", async () => {
  const projectRoot = makeProject();
  try {
    // A structurally valid bundle whose content.json has no slides (the same
    // shape M3's synthetic bundles use): prepare stays structural, rendering
    // must refuse instead of silently rendering the wrong slide.
    const bundleDir = join(projectRoot, "bundle");
    mkdirSync(join(bundleDir, "assets"), { recursive: true });
    writeFileSync(join(bundleDir, "index.html"), "<!doctype html><html><head></head><body><div id=\"app\"></div></body></html>", "utf8");
    writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify({
      schema: "lattice.deck.v1",
      id: "test",
      title: "Test",
      entry: { content: "./content.json", layout: "./layout.json", notes: "./notes.json" },
    }), "utf8");
    writeFileSync(join(bundleDir, "content.json"), JSON.stringify({ id: "test", slides: [] }), "utf8");
    writeFileSync(join(bundleDir, "layout.json"), "[]", "utf8");
    writeFileSync(join(bundleDir, "notes.json"), "[]", "utf8");

    const plan = makeConformancePlan({ bundleDir, deckId: "test", slideDefinitions: await loadConformanceSlideDefinitions() });
    const backend = getBackend("remotion");
    const workDir = join(projectRoot, ".lattice", "generated", "remotion");
    const prepared = await backend.prepare({ plan, bundleDir, workDir, projectRoot });

    const hostManifest = JSON.parse(readFileSync(join(prepared.workDir, "host", "public", "lattice-host-manifest.json"), "utf8"));
    assert.ok(hostManifest.clips.every((clip) => clip.contentIndex === null), "clips without bundle content must be unbound, never guessed");

    await assert.rejects(
      () => backend.renderStill({ prepared, frame: 0, output: join(projectRoot, "still.png") }),
      (error) => error.name === "VideoBackendError" && error.cause === "unbound-slide-content",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("renderStill rejects invalid arguments and missing hosts without any Remotion call", async () => {
  const projectRoot = makeProject();
  try {
    const slideDefinitions = await loadConformanceSlideDefinitions();
    const bundleDir = makeConformanceBundle(projectRoot, { slideDefinitions });
    const plan = makeConformancePlan({ bundleDir, slideDefinitions });
    const backend = getBackend("remotion");
    const workDir = join(projectRoot, ".lattice", "generated", "remotion");
    const prepared = await backend.prepare({ plan, bundleDir, workDir, projectRoot });

    await assert.rejects(
      () => backend.renderStill({}),
      (error) => error.name === "VideoBackendError" && error.cause === "invalid-prepared",
    );
    await assert.rejects(
      () => backend.renderStill({ prepared, frame: -1, output: join(projectRoot, "x.png") }),
      (error) => error.name === "VideoBackendError" && error.cause === "invalid-frame",
    );
    await assert.rejects(
      () => backend.renderStill({ prepared, frame: 1.5, output: join(projectRoot, "x.png") }),
      (error) => error.name === "VideoBackendError" && error.cause === "invalid-frame",
    );
    await assert.rejects(
      () => backend.renderStill({ prepared, frame: 0, output: "" }),
      (error) => error.name === "VideoBackendError" && error.cause === "invalid-output",
    );
    await assert.rejects(
      () => backend.renderStill({ prepared: { backendId: "remotion", planHash: "x", workDir: "/nonexistent" }, frame: 0, output: join(projectRoot, "x.png") }),
      (error) => error.name === "VideoBackendError" && error.cause === "missing-host",
    );
    await assert.rejects(
      () => backend.renderVideo({ prepared: { backendId: "remotion", planHash: "x", workDir: "/nonexistent" }, output: join(projectRoot, "x.mp4") }),
      (error) => error.name === "VideoBackendError" && error.cause === "missing-host",
    );

    // Argument failures keep diagnosable failure logs beside the host.
    const failuresDir = join(prepared.workDir, "failures");
    assert.ok(existsSync(failuresDir), "invalid-frame failures must leave a failure log");
    const logs = readdirSync(failuresDir);
    assert.ok(logs.some((name) => name.startsWith("render-still-invalid-frame-")), `got: ${logs.join(", ")}`);
    const logContent = readFileSync(join(failuresDir, logs[0]), "utf8");
    assert.ok(logContent.includes("DO NOT EDIT"));
    assert.ok(logContent.includes(prepared.planHash));
    assert.ok(logContent.includes("frame"));
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("out-of-range frames are rejected against the host manifest totalFrames", async () => {
  const projectRoot = makeProject();
  try {
    const slideDefinitions = await loadConformanceSlideDefinitions();
    const bundleDir = makeConformanceBundle(projectRoot, { slideDefinitions });
    const plan = makeConformancePlan({ bundleDir, slideDefinitions });
    const backend = getBackend("remotion");
    const workDir = join(projectRoot, ".lattice", "generated", "remotion");
    const prepared = await backend.prepare({ plan, bundleDir, workDir, projectRoot });

    await assert.rejects(
      () => backend.renderStill({ prepared, frame: plan.totalFrames, output: join(projectRoot, "x.png") }),
      (error) => error.name === "VideoBackendError" && error.cause === "invalid-frame" && error.message.includes("totalFrames 90"),
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("a host manifest tampered after prepare is rejected via plan-hash mismatch", async () => {
  const projectRoot = makeProject();
  try {
    const slideDefinitions = await loadConformanceSlideDefinitions();
    const bundleDir = makeConformanceBundle(projectRoot, { slideDefinitions });
    const plan = makeConformancePlan({ bundleDir, slideDefinitions });
    const backend = getBackend("remotion");
    const workDir = join(projectRoot, ".lattice", "generated", "remotion");
    const prepared = await backend.prepare({ plan, bundleDir, workDir, projectRoot });

    const manifestPath = join(prepared.workDir, "host", "public", "lattice-host-manifest.json");
    const tampered = JSON.parse(readFileSync(manifestPath, "utf8"));
    tampered.planHash = "0".repeat(64);
    writeFileSync(manifestPath, JSON.stringify(tampered, null, 2), "utf8");

    await assert.rejects(
      () => backend.renderStill({ prepared, frame: 0, output: join(projectRoot, "x.png") }),
      (error) => error.name === "VideoBackendError" && error.cause === "host-mismatch",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("inspectArtifact describes PNG artifacts through ffprobe", async () => {
  const { PNG } = await import("pngjs");
  const projectRoot = makeProject();
  try {
    const backend = getBackend("remotion");
    const pngPath = join(projectRoot, "probe.png");
    const png = new PNG({ width: 960, height: 540 });
    for (let i = 0; i < png.data.length; i += 4) {
      png.data[i] = 200;
      png.data[i + 1] = 30;
      png.data[i + 2] = 40;
      png.data[i + 3] = 255;
    }
    writeFileSync(pngPath, PNG.sync.write(png));

    const metadata = await backend.inspectArtifact(pngPath);
    assert.equal(metadata.width, 960);
    assert.equal(metadata.height, 540);
    assert.equal(metadata.format, "png");
    assert.equal(metadata.totalFrames, 1);

    await assert.rejects(
      () => backend.inspectArtifact(join(projectRoot, "missing.png")),
      (error) => error.name === "VideoBackendError" && error.cause === "artifact-missing",
    );
    await assert.rejects(
      () => backend.inspectArtifact(""),
      (error) => error.name === "VideoBackendError" && error.cause === "invalid-artifact-path",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("canonical conformance deck sources never import a video backend", async () => {
  const deckDir = join(
    new URL(".", import.meta.url).pathname,
    "fixtures",
    "video-conformance-project",
    "decks",
    "conformance",
  );
  const treeHash = hashTree(deckDir);
  assert.match(treeHash, /^[0-9a-f]{64}$/);
  const sources = ["slides.v2.js", "assets/lattice-conformance.svg"];
  for (const rel of sources) {
    const content = readFileSync(join(deckDir, rel), "utf8");
    assert.doesNotMatch(content, /\bremotion\b|@remotion\//, `${rel} must not reference a video backend`);
  }
});
