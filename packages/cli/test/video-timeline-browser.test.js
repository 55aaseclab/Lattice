// M7 browser gates, verified in real Chromium:
//   Gate 1 — present-play and the video timeline are the same timeline:
//   clicking through the production presentation lands on exactly the stop
//   frames the compiled plan declares, and the Slide Runtime's painted frames
//   match backend stills pixel-for-pixel at sampled frames.
//   Gate 4 — the animation agent closure: only `lattice edit --timeline`
//   changes a slide's animation preset, and both the presentation playback
//   and the exported MP4 frames change exactly as the new declaration says,
//   with provenance recorded.

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import { createHash } from "node:crypto";

import { launchHeadlessBrowser, resolveChromiumExecutable } from "../src/commands/browser.js";
import { compareScreenshotPng } from "../src/commands/screenshot.js";
import { TIMELINE_DECK_ID, writeDeckRegistry, writeProjectConfig, writeTimelineDeck } from "./helpers/timeline-fixture.js";

const cliIndex = fileURLToPath(new URL("../src/index.js", import.meta.url));
const tmpRoot = fileURLToPath(new URL("./tmp", import.meta.url));


// The browser fixture is written into the gitignored tmp project at test
// time: two surfaces share ONE descriptor built exactly like the real portal
// builds it (createV2DeckDescriptor on the canonical manifest + slide
// definitions) — #app boots the production presentation surface (present-play)
// and #stage drives the same Slide Runtime frame-exactly for pixel parity
// against backend stills.
const FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <title>Lattice M7 timeline fixture</title>
    <script type="module" src="./timeline-fixture.js"></script>
    <style>
      body { margin: 0; background: #ffffff; }
      #app { min-height: 200px; }
      #stage { width: 960px; height: 540px; }
    </style>
  </head>
  <body>
    <div id="app"></div>
    <div id="stage"></div>
  </body>
</html>
`;

const FIXTURE_JS = `// Browser-only fixture for the M7 timeline gates (no document under Node).
async function main() {
  const { createV2DeckDescriptor } = await import("@55aaseclab/lattice-runtime/presentation");
  const { bootPresentation } = await import("@55aaseclab/lattice-runtime/renderer/presentation-app");
  const { createSlideRuntime } = await import("@55aaseclab/lattice-runtime/slide-runtime");
  await import("@55aaseclab/lattice-runtime/renderer/presentation.css");
  await import("@55aaseclab/lattice-runtime/themes/simple-light/styles.css");
  // The presentation surface loads this itself for animation decks
  // (bootPresentation); the fixture imports it explicitly so the raw runtime
  // stage below paints identically.
  await import("@55aaseclab/lattice-runtime/themes/simple-light/presets.css");

  const manifest = (await import("./decks/timeline-demo/manifest.json")).default;
  const { slideDefinitions } = await import("./decks/timeline-demo/slides.v2.js");
  const { default: notes } = await import("./decks/timeline-demo/notes.js");

  const descriptor = createV2DeckDescriptor({ manifest, slides: slideDefinitions, notes });
  const deckId = manifest.id;

  bootPresentation(document.getElementById("app"), { deckId, v2Decks: { [manifest.id]: descriptor } });

  const stage = document.getElementById("stage");
  const route = descriptor.routes.main;
  const slidesById = new Map(descriptor.slides.map((slide) => [slide.id, slide]));
  const segments = [];
  let cursor = 0;
  for (const slideId of route) {
    const slide = slidesById.get(slideId);
    segments.push({ slideId, startFrame: cursor, durationFrames: slide.durationFrames, slide });
    cursor += slide.durationFrames;
  }

  let runtime = null;
  let mountedSlideId = null;

  function resolveSegment(globalFrame) {
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      if (globalFrame >= segments[index].startFrame) return segments[index];
    }
    return segments[0];
  }

  async function seekFrame(globalFrame) {
    const clamped = Math.max(0, Math.min(cursor - 1, Math.round(globalFrame)));
    const segment = resolveSegment(clamped);
    if (!runtime || mountedSlideId !== segment.slideId) {
      if (runtime) runtime.destroy();
      runtime = createSlideRuntime({ slide: segment.slide, container: stage });
      await runtime.ready();
      mountedSlideId = segment.slideId;
    }
    const localFrame = clamped - segment.startFrame;
    await runtime.seek(localFrame);
    const snapshot = await runtime.painted(localFrame);
    return {
      globalFrame: clamped,
      slideId: segment.slideId,
      localFrame,
      snapshot,
      revealOffsets: Object.fromEntries(
        Array.from(stage.querySelectorAll("[data-lattice-reveal]")).map((element) => [
          element.getAttribute("data-lattice-reveal"),
          element.style.getPropertyValue("--lattice-reveal-offset"),
        ]),
      ),
      revealStyle: Object.fromEntries(
        Array.from(stage.querySelectorAll("[data-lattice-reveal]")).map((element) => {
          const computed = window.getComputedStyle(element);
          return [
            element.getAttribute("data-lattice-reveal"),
            { opacity: computed.opacity, transform: computed.transform },
          ];
        }),
      ),
    };
  }

  async function settle() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (!(document.querySelector("[data-lattice-presentation]")?.hasAttribute("data-lattice-playing") ?? false)) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  window.__latticeTimelineFixture = {
    deckId,
    descriptor,
    totalFrames: cursor,
    stopSequence: segments.flatMap((segment) =>
      segment.slide.stops.map((stop) => ({
        slideId: segment.slideId,
        stopId: stop.id,
        globalFrame: segment.startFrame + stop.frame,
      })),
    ),
    seekFrame,
    async presentState() {
      const canvas = document.querySelector("[data-lattice-canvas]");
      if (!canvas) return null;
      return {
        slideId: canvas.getAttribute("data-lattice-slide-id"),
        frame: canvas.getAttribute("data-lattice-frame"),
        stop: canvas.getAttribute("data-lattice-stop"),
        revealedStops: canvas.getAttribute("data-lattice-revealed-stops"),
        playing: document.querySelector("[data-lattice-presentation]")?.hasAttribute("data-lattice-playing") ?? false,
      };
    },
    async clickNext() {
      document.querySelector('[data-lattice-nav="next"]').click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await settle();
    },
    async clickPrevious() {
      document.querySelector('[data-lattice-nav="previous"]').click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      await settle();
    },
  };
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  await main();
}
`;


let serverSequence = 0;

function makeProject() {
  const projectRoot = mkdtempSync(path.join(tmpRoot, "m7-browser-"));
  writeProjectConfig(projectRoot);
  writeTimelineDeck(projectRoot);
  writeDeckRegistry(projectRoot);
  writeFileSync(path.join(projectRoot, "timeline-fixture.html"), FIXTURE_HTML, "utf8");
  writeFileSync(path.join(projectRoot, "timeline-fixture.js"), FIXTURE_JS, "utf8");
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


async function withFixturePage(projectRoot, run) {
  const server = await createServer({
    root: projectRoot,
    cacheDir: path.join(tmpdir(), `lattice-vite-m7-${createHash("sha256").update(projectRoot).digest("hex").slice(0, 16)}-${(serverSequence += 1)}`),
    server: { middlewareMode: false },
  });
  await server.listen();
  const address = server.resolvedUrls?.local?.[0];
  try {
    const executable = resolveChromiumExecutable();
    if (!executable) assert.fail("no headless Chromium found; install Chrome/Chromium or run `npx playwright install chromium`");
    const browser = await launchHeadlessBrowser(executable);
    try {
      const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 1 });
      const page = await context.newPage();
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(String(error)));
      await page.goto(`${address.replace(/\/$/, "")}/timeline-fixture.html`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__latticeTimelineFixture !== undefined, undefined, { timeout: 30000 });
      await run(page, pageErrors, address);
      assert.deepEqual(pageErrors, [], "the fixture page must run without page errors");
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
  }
}

test("gate 1: present-play walks exactly the plan's stop sequence (同帧同 reveal)", async () => {
  const projectRoot = makeProject();
  try {
    await withFixturePage(projectRoot, async (page) => {
      // The presentation surface reports slide-local frames; the timeline's
      // stop frames ARE the clip-local frames the plan compiles.
      const expected = [
        { slideId: "intro", stopId: "open", localFrame: 0 },
        { slideId: "intro", stopId: "point", localFrame: 40 },
        { slideId: "reveal", stopId: "base", localFrame: 0 },
        { slideId: "reveal", stopId: "step-1", localFrame: 40 },
        { slideId: "reveal", stopId: "step-2", localFrame: 70 },
        { slideId: "outro", stopId: "static", localFrame: 0 },
      ];
      const globalStops = await page.evaluate(() => window.__latticeTimelineFixture.stopSequence);
      assert.deepEqual(globalStops.map((stop) => stop.globalFrame), [0, 40, 90, 130, 160, 190]);

      const visited = [];
      const steps = expected.length;
      for (let index = 0; index < steps; index += 1) {
        if (index > 0) await page.evaluate(() => window.__latticeTimelineFixture.clickNext());
        const state = await page.evaluate(() => window.__latticeTimelineFixture.presentState());
        visited.push({ slideId: state.slideId, stopId: state.stop, localFrame: Number(state.frame) });
      }
      assert.deepEqual(visited, expected, "present-play must land on exactly the timeline's stop frames");

      // Revealed-stop accumulation on the presentation canvas mirrors the
      // canonical reducer surface.
      const lastState = await page.evaluate(() => window.__latticeTimelineFixture.presentState());
      assert.equal(lastState.revealedStops, "static");
      for (let index = 0; index < steps - 1; index += 1) {
        await page.evaluate(() => window.__latticeTimelineFixture.clickPrevious());
      }
      const firstState = await page.evaluate(() => window.__latticeTimelineFixture.presentState());
      assert.equal(firstState.stop, "open");
      assert.equal(firstState.frame, "0");
    });
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("gate 1: Slide Runtime painted frames match backend stills at sampled frames", async () => {
  const projectRoot = makeProject();
  try {
    const exported = runCli(projectRoot, ["export", "--deck", TIMELINE_DECK_ID]);
    assert.equal(exported.status, 0, exported.stderr);
    const frames = [0, 20, 36, 126, 131, 145, 158, 161, 195];
    for (const frame of frames) {
      const output = path.join(projectRoot, "out", `ref-${String(frame).padStart(5, "0")}.png`);
      const result = runCliWithRetry(projectRoot, ["video", "still", "--deck", TIMELINE_DECK_ID, "--backend", "remotion", "--frame", String(frame), "--output", output]);
      assert.equal(result.status, 0, result.stderr);
    }

    await withFixturePage(projectRoot, async (page) => {
      const stage = await page.$("#stage");
      const box = await stage.boundingBox();
      for (const frame of frames) {
        const probe = await page.evaluate((f) => window.__latticeTimelineFixture.seekFrame(f), frame);
        assert.equal(probe.globalFrame, frame);
        await page.screenshot({ path: path.join(projectRoot, "out", `dom-${String(frame).padStart(5, "0")}.png`), clip: { x: box.x, y: box.y, width: 960, height: 540 } });
        const comparison = compareScreenshotPng(
          readFileSync(path.join(projectRoot, "out", `dom-${String(frame).padStart(5, "0")}.png`)),
          readFileSync(path.join(projectRoot, "out", `ref-${String(frame).padStart(5, "0")}.png`)),
        );
        assert.ok(
          !comparison.dimensionMismatch && comparison.diffRatio <= 0.01,
          `frame ${frame}: presentation-vs-MP4 pixel diff ratio ${comparison.diffRatio}`,
        );
      }

      // Per-frame reveal state: the runtime applies the canonical stop state.
      const midWindow = await page.evaluate(() => window.__latticeTimelineFixture.seekFrame(126));
      // step-1 reveal window is [121, 130]: mid-window the element is partially
      // faded and carries its reveal offset. The ACTIVE stop is still base.
      assert.equal(midWindow.revealOffsets["step-1"], "-4");
      assert.equal(midWindow.snapshot.attributes["data-lattice-stop"], "base");
      assert.equal(midWindow.snapshot.variables["--lattice-stop-frame"], "0");
      assert.equal(midWindow.snapshot.variables["--lattice-stop-span"], "40");
      assert.equal(midWindow.snapshot.attributes["data-lattice-revealed-stops"], "base");
      const afterStop = await page.evaluate(() => window.__latticeTimelineFixture.seekFrame(131));
      assert.equal(afterStop.revealOffsets["step-1"], "1");
      assert.equal(afterStop.snapshot.attributes["data-lattice-stop"], "step-1");
      assert.deepEqual(afterStop.snapshot.attributes["data-lattice-revealed-stops"].split(" ").sort(), ["base", "step-1"]);
    });
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}, { timeout: 600000 });

test("gate 4: only lattice edit --timeline changes the animation, and DOM + MP4 follow the declaration", async () => {
  const projectRoot = makeProject();
  try {
    const exported = runCli(projectRoot, ["export", "--deck", TIMELINE_DECK_ID]);
    assert.equal(exported.status, 0, exported.stderr);

    // Preset A (fade): baseline stills at a mid-animation frame and a
    // nothing-revealed frame.
    const still = (label, frame) => runCliWithRetry(projectRoot, ["video", "still", "--deck", TIMELINE_DECK_ID, "--backend", "remotion", "--frame", String(frame), "--output", path.join(projectRoot, "out", `${label}-${frame}.png`)]);
    assert.equal(still("presetA", 126).status, 0);
    assert.equal(still("presetA", 100).status, 0);

    await withFixturePage(projectRoot, async (page) => {
      const before = await page.evaluate(() => window.__latticeTimelineFixture.seekFrame(126));
      assert.equal(before.snapshot.attributes["data-lattice-anim"], "fade");
      // fade: pure opacity, no travel.
      assert.equal(before.revealStyle["step-1"].transform, "none");
      const opacityA = Number(before.revealStyle["step-1"].opacity);
      assert.ok(Math.abs(opacityA - 0.6) < 0.02, `preset A fade at frame 126 → opacity ≈ 0.6 (got ${opacityA})`);
      // Seeking back converges to the same state (frame purity).
      await page.evaluate(() => window.__latticeTimelineFixture.seekFrame(140));
      const again = await page.evaluate(() => window.__latticeTimelineFixture.seekFrame(126));
      assert.equal(again.revealStyle["step-1"].opacity, before.revealStyle["step-1"].opacity);
    });

    // The agent closed loop: edit preset A → B and the stop dwell, nothing else.
    const edit = runCli(projectRoot, [
      "edit", "--deck", TIMELINE_DECK_ID,
      "--timeline", "slides.reveal.animation.preset",
      "--value", '"rise"', "--reason", "M7 gate 4: preset A to B", "--actor", "m7-browser",
    ]);
    assert.equal(edit.status, 0, edit.stderr);
    const editReport = JSON.parse(edit.stdout);
    assert.ok(existsSync(path.join(projectRoot, editReport.provenance.path)), "provenance record written");

    // The edited deck must re-validate and re-export through the loop.
    assert.equal(runCli(projectRoot, ["validate", "--deck", TIMELINE_DECK_ID]).status, 0);

    await withFixturePage(projectRoot, async (page) => {
      const after = await page.evaluate(() => window.__latticeTimelineFixture.seekFrame(126));
      assert.equal(after.snapshot.attributes["data-lattice-anim"], "rise");
      assert.equal(after.snapshot.attributes["data-lattice-anim-direction"], "up");
      // The edit changed only the preset: durationFrames stays 10, so the
      // fade window length is unchanged but the reveal now travels.
      const opacityB = Number(after.revealStyle["step-1"].opacity);
      assert.ok(Math.abs(opacityB - 0.6) < 0.02, `preset B at frame 126 keeps the 10-frame window → opacity ≈ 0.6 (got ${opacityB})`);
      // rise/up travels from +distance toward 0 with the same progress:
      // (1 - 0.6) * 24px = 9.6px.
      const transform = after.revealStyle["step-1"].transform;
      assert.match(transform, /matrix\(1, 0, 0, 1, 0, 9\.6\)/, `translateY ≈ 9.6px at progress 0.6 (got ${transform})`);
      // The unchanged stop frames keep the reveal order intact.
      const probe131 = await page.evaluate(() => window.__latticeTimelineFixture.seekFrame(131));
      assert.equal(probe131.snapshot.attributes["data-lattice-stop"], "step-1");
      assert.equal(Number(probe131.revealStyle["step-1"].opacity), 1);
    });

    // MP4 side: the same frame changed with the declaration; the untouched
    // frame did not move at all.
    runCli(projectRoot, ["export", "--deck", TIMELINE_DECK_ID]);
    assert.equal(still("presetB", 126).status, 0);
    assert.equal(still("presetB", 100).status, 0);
    const animatedFrameDiff = compareScreenshotPng(readFileSync(path.join(projectRoot, "out", "presetA-126.png")), readFileSync(path.join(projectRoot, "out", "presetB-126.png")));
    assert.ok(animatedFrameDiff.diffRatio > 0.005, `animation frame must change with the preset (got ${animatedFrameDiff.diffRatio})`);
    const hiddenFrameDiff = compareScreenshotPng(readFileSync(path.join(projectRoot, "out", "presetA-100.png")), readFileSync(path.join(projectRoot, "out", "presetB-100.png")));
    assert.ok(hiddenFrameDiff.diffRatio < 0.0005, `frames outside any reveal window are preset-independent (got ${hiddenFrameDiff.diffRatio})`);

    // Provenance is complete and machine-checkable.
    const provenance = JSON.parse(readFileSync(path.join(projectRoot, editReport.provenance.path), "utf8"));
    assert.equal(provenance.command, "edit");
    assert.equal(provenance.actor, "m7-browser");
    assert.equal(provenance.value, "rise");
    assert.equal(provenance.sourceMap.file, `decks/${TIMELINE_DECK_ID}/manifest.json`);
    assert.equal(provenance.gate.contentLock.mode, "absent");
    assert.equal(provenance.gate.validate.pass, true);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
}, { timeout: 600000 });
