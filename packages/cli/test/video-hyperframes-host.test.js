import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureBackendsInitialized, getBackend } from "../src/video/registry.js";
import {
  generateHyperFramesHost,
  extractBundleStylesheets,
  resolveVendoredGsapSource,
  HYPERFRAMES_COMPOSITION_ID,
  HYPERFRAMES_HOST_SCHEMA,
} from "../src/video/hyperframes/host-template.js";
import { resolveHyperFramesCliEntry } from "../src/video/hyperframes/render-support.js";
import {
  loadConformanceSlideDefinitions,
  makeConformanceBundle,
  makeConformancePlan,
} from "./video-remotion-fixtures.js";

ensureBackendsInitialized();

function makeProject() {
  return mkdtempSync(join(tmpdir(), "lattice-hyperframes-host-"));
}

async function makePrepared({ deckId = "conformance" } = {}) {
  const projectRoot = makeProject();
  const slideDefinitions = await loadConformanceSlideDefinitions();
  const bundleDir = makeConformanceBundle(projectRoot, { slideDefinitions });
  const plan = makeConformancePlan({ bundleDir, slideDefinitions, deckId });
  const backend = getBackend("hyperframes");
  const workDir = join(projectRoot, ".lattice", "generated", "hyperframes");
  const prepared = await backend.prepare({ plan, bundleDir, workDir, projectRoot });
  return { projectRoot, slideDefinitions, bundleDir, plan, backend, workDir, prepared };
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

test("hyperframes prepare generates a complete deterministic master composition with DO NOT EDIT provenance", async () => {
  const { projectRoot, plan, bundleDir, backend, workDir, prepared } = await makePrepared();
  try {
    const compositionDir = join(prepared.workDir, "composition");

    const indexHtml = readFileSync(join(compositionDir, "index.html"), "utf8");
    assert.ok(indexHtml.includes("DO NOT EDIT"), "composition must carry DO NOT EDIT");
    assert.ok(indexHtml.includes(prepared.planHash), "composition must carry the plan hash");
    assert.ok(indexHtml.includes(prepared.bundleHash), "composition must carry the bundle hash");
    assert.ok(indexHtml.includes(`data-composition-id="${HYPERFRAMES_COMPOSITION_ID}"`));
    assert.ok(indexHtml.includes('data-width="960"'));
    assert.ok(indexHtml.includes('data-height="540"'));
    assert.ok(indexHtml.includes('data-fps="30"'));
    assert.ok(indexHtml.includes('data-duration="3"'));
    assert.ok(indexHtml.includes("window.LATTICE_HOST"), "composition must embed the host configuration");
    assert.ok(indexHtml.includes("__timelines"), "composition must register the GSAP timeline");
    assert.ok(indexHtml.includes("lattice-video-canvas"));
    assert.ok(indexHtml.includes("--lattice-local-frame"), "canvas must carry the canonical frame variables");
    assert.ok(indexHtml.includes('<base href="./bundle/">'), "bundle references resolve through the copied bundle");
    assert.ok(indexHtml.includes("<style>@font-face{font-family:\"Arial\";src:local(\"Arial\")}"),
      "local-only font stubs must keep the compiler from injecting substitute webfonts");
    assert.ok(indexHtml.includes("html,body,*{text-rendering:auto}"),
      "the compiler's geometricPrecision rule must be overridden for glyph parity");
    assert.ok(!/<script\b[^>]*\bsrc\s*=/i.test(indexHtml), "no external script may be loaded");
    assert.ok(!/<link\b[^>]*\bhref\s*=\s*["']https?:/i.test(indexHtml), "no remote stylesheet may be loaded");
    assert.ok(!/url\(\s*["']?https?:/i.test(indexHtml), "no remote css resource may be referenced");
    assert.ok(!/@import\s+https?:/i.test(indexHtml), "no remote css import may be referenced");
    assert.ok(indexHtml.length > 60_000, "the inlined gsap runtime must be part of the composition");

    const hostManifest = JSON.parse(readFileSync(join(compositionDir, "lattice-host-manifest.json"), "utf8"));
    assert.equal(hostManifest.schema, HYPERFRAMES_HOST_SCHEMA);
    assert.equal(hostManifest.compositionId, HYPERFRAMES_COMPOSITION_ID);
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

    // The Slide Web Bundle is copied, never referenced or moved: the original
    // bundle stays canonical.
    const { computeBundleIdentityHash } = await import("../src/video/bundle.js");
    assert.equal(computeBundleIdentityHash(join(compositionDir, "bundle")), computeBundleIdentityHash(bundleDir));

    // The generated composition is deterministic: regenerating produces
    // identical bytes for every generated file.
    const snapshotTree = () => JSON.stringify({
      index: readFileSync(join(compositionDir, "index.html"), "utf8"),
      manifest: readFileSync(join(compositionDir, "lattice-host-manifest.json"), "utf8"),
      theme: readFileSync(join(compositionDir, "bundle", "assets", "theme.css"), "utf8"),
    });
    const firstTree = snapshotTree();
    await backend.prepare({ plan, bundleDir, workDir, projectRoot });
    const secondTree = snapshotTree();
    assert.equal(firstTree, secondTree, "composition regeneration must be byte-identical");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("hyperframes prepare keeps the M3 project surface and adds the composition section", async () => {
  const { projectRoot, bundleDir, prepared } = await makePrepared();
  try {
    const projectJson = JSON.parse(readFileSync(join(prepared.workDir, "hyperframes-project.json"), "utf8"));
    assert.equal(projectJson.schema, "lattice.hyperframes-project.v1");
    assert.equal(projectJson.bundleDir, bundleDir);
    assert.equal(projectJson.bundleHash, prepared.bundleHash);
    assert.equal(projectJson.planHash, prepared.planHash);
    assert.ok(projectJson.videoPlanPath.endsWith("video-plan.json"));
    assert.equal(projectJson.composition.compositionId, HYPERFRAMES_COMPOSITION_ID);
    assert.ok(projectJson.composition.entryPoint.endsWith("index.html"));
    assert.ok(projectJson.composition.manifestPath.endsWith("lattice-host-manifest.json"));

    const header = readFileSync(join(prepared.workDir, "LATTICE_HYPERFRAMES.md"), "utf8");
    assert.ok(header.includes("DO NOT EDIT"));
    assert.ok(header.includes(`plan-hash: ${prepared.planHash}`));
    assert.ok(header.includes(`bundle-hash: ${prepared.bundleHash}`));
    assert.ok(header.includes("M5"), "the M5 generation header must replace the M3 stub text");
    assert.ok(existsSync(join(prepared.workDir, "video-plan.json")));

    const writtenPlan = JSON.parse(readFileSync(join(prepared.workDir, "video-plan.json"), "utf8"));
    assert.equal(writtenPlan.provenance.bundleHash, prepared.bundleHash);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("generated composition embeds every plan clip's bound slide html", async () => {
  const { projectRoot, prepared } = await makePrepared();
  try {
    const indexHtml = readFileSync(join(prepared.workDir, "composition", "index.html"), "utf8");
    const configMatch = indexHtml.match(/window\.LATTICE_HOST = (\{[\s\S]*?\});<\/script>/);
    assert.ok(configMatch, "the host configuration script must embed a JSON object");
    const hostConfig = JSON.parse(configMatch[1]);
    const slideDefinitions = await loadConformanceSlideDefinitions();
    for (const [index, slide] of slideDefinitions.entries()) {
      const html = typeof slide.html === "function" ? slide.html() : slide.html;
      assert.equal(hostConfig.clips[index].html, html, `slide ${slide.id} markup must be embedded in the host configuration`);
    }
    assert.ok(indexHtml.includes("lattice-conformance.svg"), "the bundled asset reference must be part of the slide markup");
    assert.ok(configMatch[1].includes("\\u003c") === false || hostConfig.clips[0].html.includes("<"),
      "inline-script JSON escaping must be transparent after parsing");
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
    const backend = getBackend("hyperframes");
    const workDir = join(projectRoot, ".lattice", "generated", "hyperframes");
    const prepared = await backend.prepare({ plan, bundleDir, workDir, projectRoot });

    const hostManifest = JSON.parse(readFileSync(join(prepared.workDir, "composition", "lattice-host-manifest.json"), "utf8"));
    assert.ok(hostManifest.clips.every((clip) => clip.contentIndex === null), "clips without bundle content must be unbound, never guessed");

    await assert.rejects(
      () => backend.renderStill({ prepared, frame: 0, output: join(projectRoot, "still.png") }),
      (error) => error.name === "VideoBackendError" && error.cause === "unbound-slide-content",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("renderStill rejects invalid arguments and missing hosts without any CLI call", async () => {
  const { projectRoot, backend, prepared } = await makePrepared();
  try {
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
      () => backend.renderStill({ prepared: { backendId: "hyperframes", planHash: "x", workDir: "/nonexistent" }, frame: 0, output: join(projectRoot, "x.png") }),
      (error) => error.name === "VideoBackendError" && error.cause === "missing-host",
    );
    await assert.rejects(
      () => backend.renderVideo({ prepared: { backendId: "hyperframes", planHash: "x", workDir: "/nonexistent" }, output: join(projectRoot, "x.mp4") }),
      (error) => error.name === "VideoBackendError" && error.cause === "missing-host",
    );

    // Argument failures keep diagnosable failure logs beside the composition.
    const failuresDir = join(prepared.workDir, "failures");
    assert.ok(existsSync(failuresDir), "invalid-frame failures must leave a failure log");
    const { readdirSync } = await import("node:fs");
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
  const { projectRoot, plan, backend, prepared } = await makePrepared();
  try {
    await assert.rejects(
      () => backend.renderStill({ prepared, frame: plan.totalFrames, output: join(projectRoot, "x.png") }),
      (error) => error.name === "VideoBackendError" && error.cause === "invalid-frame" && error.message.includes("totalFrames 90"),
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("a host manifest tampered after prepare is rejected via plan-hash mismatch", async () => {
  const { projectRoot, backend, prepared } = await makePrepared();
  try {
    const manifestPath = join(prepared.workDir, "composition", "lattice-host-manifest.json");
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

test("the vendored gsap runtime resolves from the pinned dependency and contains no inline script terminator", async () => {
  const gsapSource = await resolveVendoredGsapSource();
  assert.ok(gsapSource.includes("gsap"), "the gsap runtime must be resolved");
  assert.ok(!gsapSource.includes("</script"), "the vendored gsap runtime must be safe to inline into the composition");
  const { binPath, version } = resolveHyperFramesCliEntry();
  assert.equal(version, "0.8.206", "the exact pinned hyperframes version must be resolved");
  assert.ok(binPath.endsWith(join("hyperframes", "bin", "hyperframes.mjs")), `unexpected CLI entry: ${binPath}`);
});

test("hyperframes doctor reports the exact installed toolchain as available", async () => {
  const { projectRoot, backend } = await makePrepared();
  try {
    const report = await backend.doctor();
    assert.equal(report.status, "available");
    assert.equal(report.exitCode, 0);
    const messages = report.diagnostics.map((diag) => diag.message);
    assert.ok(messages.some((m) => m.includes("HyperFrames v0.8.206")), `doctor must pin the exact version: ${messages.join(" | ")}`);
    assert.ok(messages.some((m) => m.includes("gsap v3.15.0")), `doctor must report the vendored gsap version: ${messages.join(" | ")}`);
    assert.ok(messages.some((m) => m.includes("Node.js: v")), `doctor must report the Node version: ${messages.join(" | ")}`);
    assert.ok(messages.some((m) => m.toLowerCase().includes("browser")), `doctor must report the pinned browser: ${messages.join(" | ")}`);
    assert.ok(!messages.some((m) => m.includes("@hyperframes/cli")), "no phantom package names may be referenced");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
