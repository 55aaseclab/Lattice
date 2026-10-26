import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeSlideFrameState,
  createSlideRuntime,
  snapshotSlideFrameState,
  waitForSlideResources,
} from "../src/slide-runtime/index.js";

// Minimal deterministic DOM stub: the runtime only mutates the slide root via
// innerHTML, attributes, and CSS custom properties.
function makeContainer() {
  const attributes = new Map();
  const styleStore = new Map();
  return {
    innerHTML: "",
    style: {
      setProperty: (name, value) => styleStore.set(name, value),
      removeProperty: (name) => styleStore.delete(name),
      getPropertyValue: (name) => styleStore.get(name) ?? "",
    },
    setAttribute: (name, value) => attributes.set(name, String(value)),
    getAttribute: (name) => (attributes.has(name) ? attributes.get(name) : null),
    removeAttribute: (name) => attributes.delete(name),
  };
}

const slide = () => ({
  id: "intro",
  html: '<section class="slide-canvas" data-lattice-id="intro"><h1>Hello</h1><div data-lattice-stop-id="revealed"></div></section>',
  durationFrames: 30,
  stops: [
    { id: "opening", frame: 0 },
    { id: "revealed", frame: 10, navigation: "play" },
    { id: "closing", frame: 20 },
  ],
});

// ---- Frame reducer (A11 core) ----

test("computeSlideFrameState is a pure function of (slide, localFrame)", () => {
  const definition = slide();
  assert.deepEqual(computeSlideFrameState(definition, 5), computeSlideFrameState(definition, 5));
});

test("computeSlideFrameState resolves the active stop and revealed set from the frame alone", () => {
  const definition = slide();
  const atOpen = computeSlideFrameState(definition, 0);
  assert.equal(atOpen.stopId, "opening");
  assert.equal(atOpen.stopIndex, 0);
  assert.equal(atOpen.navigation, "jump");
  assert.deepEqual(atOpen.revealedStopIds, ["opening"]);
  assert.deepEqual(atOpen.variables["--lattice-local-frame"], "0");
  assert.deepEqual(atOpen.variables["--lattice-stop-span"], "10");

  const atRevealed = computeSlideFrameState(definition, 12);
  assert.equal(atRevealed.stopId, "revealed");
  assert.equal(atRevealed.navigation, "play");
  assert.deepEqual(atRevealed.revealedStopIds, ["opening", "revealed"]);
  assert.deepEqual(atRevealed.variables["--lattice-stop-frame-offset"], "2");
  assert.deepEqual(atRevealed.variables["--lattice-stop-span"], "10");

  const atLast = computeSlideFrameState(definition, 29);
  assert.equal(atLast.stopId, "closing");
  assert.deepEqual(atLast.variables["--lattice-stop-span"], "10");
});

test("computeSlideFrameState fail-fast on fractional, non-finite, negative, and out-of-range frames", () => {
  const definition = slide();
  for (const bad of [1.5, NaN, Infinity, -Infinity, -1, 30, 31, "5", null, undefined]) {
    assert.throws(() => computeSlideFrameState(definition, bad), /localFrame|outside/, `frame ${String(bad)} must be rejected`);
  }
});

test("computeSlideFrameState exposes only integer-valued CSS variables (no seconds)", () => {
  const { variables } = computeSlideFrameState(slide(), 17);
  for (const [name, value] of Object.entries(variables)) {
    assert.match(name, /^--lattice-/);
    assert.match(value, /^\d+$/, `${name} must be an integer string, got ${value}`);
    assert.ok(!/second|sec\b|ms\b/i.test(name));
  }
});

// ---- Runtime contract (A10) ----

test("runtime contract implements ready/seek/painted/destroy", async () => {
  const container = makeContainer();
  const runtime = createSlideRuntime({ slide: slide(), container });
  for (const key of ["ready", "seek", "painted", "destroy"]) {
    assert.equal(typeof runtime[key], "function", `handle.${key} must be a function`);
  }
  await runtime.ready();
  assert.match(container.innerHTML, /slide-canvas/);
  assert.equal(container.getAttribute("data-lattice-slide-id"), "intro");

  await runtime.seek(10);
  assert.equal(container.getAttribute("data-lattice-frame"), "10");
  assert.equal(container.getAttribute("data-lattice-stop"), "revealed");

  const snapshot = await runtime.painted(10);
  assert.equal(snapshot.attributes["data-lattice-frame"], "10");

  runtime.destroy();
  assert.equal(container.innerHTML, "");
  assert.equal(container.getAttribute("data-lattice-frame"), null);
  await assert.rejects(() => runtime.seek(0), /destroyed/);
  await assert.rejects(() => runtime.painted(0), /destroyed/);
  await assert.rejects(() => runtime.ready(), /destroyed/);
});

test("painted() before seek() of that frame is an explicit error, never a silent pass", async () => {
  const container = makeContainer();
  const runtime = createSlideRuntime({ slide: slide(), container });
  await runtime.ready();
  await runtime.seek(3);
  await assert.rejects(() => runtime.painted(7), /painted\(7\) requested before seek\(7\)/);
  await assert.rejects(() => runtime.painted(3.5), /localFrame/);
  await assert.rejects(() => runtime.seek(99), /outside/);
});

test("seek() fails fast before ready() and ready() is idempotent", async () => {
  const container = makeContainer();
  const runtime = createSlideRuntime({ slide: slide(), container });
  await assert.rejects(() => runtime.seek(0), /not ready/);
  await assert.rejects(() => runtime.painted(0), /not ready/);
  await runtime.ready();
  await runtime.ready();
  assert.match(container.innerHTML, /slide-canvas/);
});

test("destroy() is idempotent and clears runtime-owned state", async () => {
  const container = makeContainer();
  const runtime = createSlideRuntime({ slide: slide(), container });
  await runtime.ready();
  await runtime.seek(4);
  runtime.destroy();
  runtime.destroy();
  assert.equal(container.getAttribute("data-lattice-stop"), null);
  assert.equal(container.style.getPropertyValue("--lattice-local-frame"), "");
});

test("ready() supports an injected resource probe (fonts/images/SVG) before resolving", async () => {
  const container = makeContainer();
  let resourcesWaited = false;
  const runtime = createSlideRuntime({
    slide: slide(),
    container,
    waitForResources: async () => {
      resourcesWaited = true;
    },
  });
  await runtime.ready();
  assert.equal(resourcesWaited, true);
});

// ---- Default resource readiness barrier (A10) ----

// Deterministic resource element stub: exposes just the surface the barrier
// reads (attribute state, complete/readyState/networkState, event listeners).
function makeResourceElement({
  tag = "img",
  src = "asset.png",
  href = null,
  complete = undefined,
  naturalWidth = 0,
  naturalHeight = 0,
  readyState = 0,
  networkState = 0,
  withLoad = false,
  querySelector = null,
} = {}) {
  const listeners = new Map();
  const element = {
    tagName: tag.toUpperCase(),
    complete,
    naturalWidth,
    naturalHeight,
    readyState,
    networkState,
    error: null,
    getAttribute: (name) => (name === "src" ? src : name === "href" ? href : null),
    addEventListener: (type, handler) => {
      const list = listeners.get(type) ?? [];
      list.push(handler);
      listeners.set(type, list);
    },
    removeEventListener: (type, handler) => {
      const list = listeners.get(type) ?? [];
      const index = list.indexOf(handler);
      if (index >= 0) list.splice(index, 1);
    },
    dispatch(type) {
      for (const handler of listeners.get(type) ?? []) handler();
    },
    listenerCount(type) {
      return (listeners.get(type) ?? []).length;
    },
  };
  if (withLoad) element.load = () => {};
  if (querySelector) element.querySelector = querySelector;
  return element;
}

function makeContainerWithResources(elements) {
  const container = makeContainer();
  container.querySelectorAll = () => elements;
  return container;
}

function makeDocument({ ready = Promise.resolve(), faces = [] } = {}) {
  return { fonts: { ready, status: "loaded", forEach: (callback) => faces.forEach(callback) } };
}

function flushMacrotasks(times = 3) {
  let chained = Promise.resolve();
  for (let i = 0; i < times; i += 1) {
    chained = chained.then(() => new Promise((resolve) => setTimeout(resolve, 0)));
  }
  return chained;
}

test("ready() by default waits for a pending image inside the mounted container (A10)", async () => {
  const image = makeResourceElement({ complete: false });
  const container = makeContainerWithResources([image]);
  const runtime = createSlideRuntime({ slide: slide(), container });
  let settled = false;
  const readiness = runtime.ready().then(() => { settled = true; });
  await flushMacrotasks();
  assert.equal(settled, false, "ready() must not resolve while a declared image is still loading");
  image.dispatch("load");
  await readiness;
  assert.equal(settled, true);
  await assert.rejects(() => runtime.seek(99), /outside/); // runtime became usable
});

test("ready() by default rejects when a declared image has verifiably failed (A10)", async () => {
  const broken = makeResourceElement({ complete: true, naturalWidth: 0, naturalHeight: 0 });
  const container = makeContainerWithResources([broken]);
  const runtime = createSlideRuntime({ slide: slide(), container });
  await assert.rejects(() => runtime.ready(), /slide resources failed to load: image failed to load: img\[asset\.png\]/);
  // Listeners must be cleaned up even on the failure path.
  assert.equal(broken.listenerCount("load"), 0);
  assert.equal(broken.listenerCount("error"), 0);
});

test("ready() by default treats an already-decoded image as loaded (A10)", async () => {
  const loaded = makeResourceElement({ complete: true, naturalWidth: 640, naturalHeight: 360 });
  const container = makeContainerWithResources([loaded]);
  const runtime = createSlideRuntime({ slide: slide(), container });
  await runtime.ready();
});

test("ready() ignores elements that declare no resource at all (A10)", async () => {
  const empty = makeResourceElement({ src: "", complete: true, naturalWidth: 0, naturalHeight: 0 });
  const container = makeContainerWithResources([empty]);
  const runtime = createSlideRuntime({ slide: slide(), container });
  await runtime.ready();
});

test("ready() waits for document fonts and rejects faces that failed (A10)", async () => {
  let resolveFonts;
  const fonts = makeDocument({ ready: new Promise((resolve) => { resolveFonts = resolve; }) });
  const container = makeContainer();
  const runtime = createSlideRuntime({ slide: slide(), container, document: fonts });
  let settled = false;
  const readiness = runtime.ready().then(() => { settled = true; });
  await flushMacrotasks();
  assert.equal(settled, false, "ready() must not resolve while document.fonts.ready is pending");
  resolveFonts();
  await readiness;
  assert.equal(settled, true);
  await runtime.seek(0);

  const failedFace = { family: "Lattice Display", status: "error" };
  const failedFonts = makeDocument({ faces: [failedFace] });
  const brokenRuntime = createSlideRuntime({ slide: slide(), container: makeContainer(), document: failedFonts });
  await assert.rejects(() => brokenRuntime.ready(), /font "Lattice Display" failed to load/);
});

test("ready() waits for video/audio loadeddata, nudges preload=none sources, and rejects media errors (A10)", async () => {
  const pendingVideo = makeResourceElement({ tag: "video", src: "clip.mp4", readyState: 0, networkState: 0, withLoad: true });
  const container = makeContainerWithResources([pendingVideo]);
  const runtime = createSlideRuntime({ slide: slide(), container });
  let settled = false;
  const readiness = runtime.ready().then(() => { settled = true; });
  await flushMacrotasks();
  assert.equal(settled, false, "ready() must not resolve while declared media is pending");
  pendingVideo.dispatch("loadeddata");
  await readiness;
  assert.equal(pendingVideo.listenerCount("loadeddata"), 0, "listeners must be cleaned up after settle");

  const failedAudio = makeResourceElement({ tag: "audio", src: "tone.mp3" });
  failedAudio.error = new Error("MEDIA_ERR");
  const failedRuntime = createSlideRuntime({ slide: slide(), container: makeContainerWithResources([failedAudio]) });
  await assert.rejects(() => failedRuntime.ready(), /media failed to load: audio\[tone\.mp3\]/);

  const errorEventAudio = makeResourceElement({ tag: "audio", src: "tone.mp3", readyState: 0, networkState: 2 });
  const eventRuntime = createSlideRuntime({ slide: slide(), container: makeContainerWithResources([errorEventAudio]) });
  const eventReadiness = eventRuntime.ready();
  await flushMacrotasks();
  errorEventAudio.dispatch("error");
  await assert.rejects(() => eventReadiness, /media failed to load: audio\[tone\.mp3\]/);

  const lazyVideo = makeResourceElement({ tag: "video", src: "hold.mp4", readyState: 0, networkState: 0, withLoad: true });
  let loadCalls = 0;
  lazyVideo.load = () => { loadCalls += 1; };
  const lazyRuntime = createSlideRuntime({ slide: slide(), container: makeContainerWithResources([lazyVideo]) });
  const lazyReady = lazyRuntime.ready();
  await flushMacrotasks();
  assert.equal(loadCalls, 1, "preload=none media (NETWORK_EMPTY) must have its declared source started");
  lazyVideo.dispatch("loadeddata");
  await lazyReady;
});

test("ready() rejects when every <source> child of a media element fails (A10)", async () => {
  const firstSource = makeResourceElement({ tag: "source", src: "a.webm" });
  const secondSource = makeResourceElement({ tag: "source", src: "b.mp4" });
  const media = makeResourceElement({ tag: "video", src: "", readyState: 0, networkState: 0, withLoad: true });
  media.querySelectorAll = () => [firstSource, secondSource];
  const runtime = createSlideRuntime({ slide: slide(), container: makeContainerWithResources([media]) });
  const readiness = runtime.ready();
  await flushMacrotasks();
  assert.equal(media.listenerCount("loadeddata"), 1);
  // A partial failure must NOT settle the wait; only the last failing source is terminal.
  firstSource.dispatch("error");
  await flushMacrotasks();
  secondSource.dispatch("error");
  await assert.rejects(() => readiness, /media has no usable source: video/);
  assert.equal(media.listenerCount("error"), 0, "listeners must be cleaned up after settle");
});

test("ready() skips media that declares no source at all (A10)", async () => {
  const empty = makeResourceElement({ tag: "video", src: "", readyState: 0, networkState: 3 });
  empty.querySelectorAll = () => [];
  const runtime = createSlideRuntime({ slide: slide(), container: makeContainerWithResources([empty]) });
  await runtime.ready();
});

test("waitForSlideResources cleans up listeners after settling (A10)", async () => {
  const image = makeResourceElement({ complete: false });
  const summaryPromise = waitForSlideResources({ container: makeContainerWithResources([image]) });
  image.dispatch("load");
  const summary = await summaryPromise;
  assert.deepEqual(summary, { fonts: false, resources: 1, failures: [] });
  assert.equal(image.listenerCount("load"), 0);
  assert.equal(image.listenerCount("error"), 0);
});

test("waitForResources hook extends the default barrier instead of replacing it (A10)", async () => {
  const image = makeResourceElement({ complete: false });
  const container = makeContainerWithResources([image]);
  let hookCalled = false;
  const runtime = createSlideRuntime({
    slide: slide(),
    container,
    waitForResources: async () => {
      hookCalled = true;
    },
  });
  let settled = false;
  const readiness = runtime.ready().then(() => { settled = true; });
  await flushMacrotasks();
  assert.equal(hookCalled, true, "the caller hook must run");
  assert.equal(settled, false, "the hook must not disable the default resource barrier");
  image.dispatch("load");
  await readiness;
  assert.equal(settled, true);
});

test("a rejecting waitForResources hook rejects ready() (A10)", async () => {
  const container = makeContainer();
  const runtime = createSlideRuntime({
    slide: slide(),
    container,
    waitForResources: async () => {
      throw new Error("custom readiness probe failed");
    },
  });
  await assert.rejects(() => runtime.ready(), /custom readiness probe failed/);
});

test("ready() sets the runtime-owned stable data-lattice-id from slide.id; destroy() clears it (A10)", async () => {
  const container = makeContainer();
  const runtime = createSlideRuntime({ slide: slide(), container });
  await runtime.ready();
  assert.equal(container.getAttribute("data-lattice-id"), "intro");
  assert.equal(container.getAttribute("data-lattice-slide-id"), "intro");
  await runtime.seek(5);
  runtime.destroy();
  assert.equal(container.getAttribute("data-lattice-id"), null);
  assert.equal(container.getAttribute("data-lattice-slide-id"), null);
  assert.equal(container.getAttribute("data-lattice-frame"), null);
});

test("destroy() while resources are pending rejects ready() and cleans up listeners (A10)", async () => {
  const image = makeResourceElement({ complete: false });
  const container = makeContainerWithResources([image]);
  const runtime = createSlideRuntime({ slide: slide(), container });
  const readiness = runtime.ready();
  await flushMacrotasks();
  runtime.destroy();
  await assert.rejects(() => readiness, /destroyed while waiting for resources/);
  assert.equal(image.listenerCount("load"), 0);
  assert.equal(image.listenerCount("error"), 0);
});

test("html may be supplied as a function; it is evaluated on ready()", async () => {
  const container = makeContainer();
  let calls = 0;
  const runtime = createSlideRuntime({
    slide: { id: "fn", html: () => `<section data-calls="${++calls}"></section>`, durationFrames: 1, stops: [{ id: "static", frame: 0 }] },
    container,
  });
  await runtime.ready();
  await runtime.seek(0);
  assert.equal(calls, 1);
});

// ---- Seek equivalence (A11) ----

function assertSameSnapshot(a, b, label) {
  assert.deepEqual(snapshotSlideFrameState(a), snapshotSlideFrameState(b), label);
}

test("fresh direct seek equals forward, backward, repeated, and random seek to the same frame", async () => {
  for (const target of [0, 1, 7, 10, 15, 20, 25, 29]) {
    const fresh = makeContainer();
    const freshRuntime = createSlideRuntime({ slide: slide(), container: fresh });
    await freshRuntime.ready();
    await freshRuntime.seek(target);

    const forward = makeContainer();
    const forwardRuntime = createSlideRuntime({ slide: slide(), container: forward });
    await forwardRuntime.ready();
    for (let frame = 0; frame <= target; frame += 1) await forwardRuntime.seek(frame);

    const backward = makeContainer();
    const backwardRuntime = createSlideRuntime({ slide: slide(), container: backward });
    await backwardRuntime.ready();
    for (let frame = slide().durationFrames - 1; frame >= target; frame -= 1) await backwardRuntime.seek(frame);

    const repeated = makeContainer();
    const repeatedRuntime = createSlideRuntime({ slide: slide(), container: repeated });
    await repeatedRuntime.ready();
    for (let i = 0; i < 5; i += 1) await repeatedRuntime.seek(target);

    assertSameSnapshot(fresh, forward, `forward seek to ${target}`);
    assertSameSnapshot(fresh, backward, `backward seek to ${target}`);
    assertSameSnapshot(fresh, repeated, `repeated seek to ${target}`);
  }
});

test("random seek sequences converge to the identical normalized state per frame", async () => {
  // Deterministic PRNG (mulberry32) so the test itself never depends on
  // Math.random's default seeding.
  function mulberry32(seed) {
    let a = seed >>> 0;
    return () => {
      a |= 0;
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const durationFrames = slide().durationFrames;
  for (let seed = 1; seed <= 25; seed += 1) {
    const random = mulberry32(seed);
    const container = makeContainer();
    const runtime = createSlideRuntime({ slide: slide(), container });
    await runtime.ready();
    for (let step = 0; step < 40; step += 1) {
      const frame = Math.floor(random() * durationFrames);
      await runtime.seek(frame);
      const fresh = makeContainer();
      const freshRuntime = createSlideRuntime({ slide: slide(), container: fresh });
      await freshRuntime.ready();
      await freshRuntime.seek(frame);
      assertSameSnapshot(fresh, container, `seed ${seed} step ${step} frame ${frame}`);
    }
  }
});

test("seek() after destroy() or on a new slide never leaks prior frame state", async () => {
  const container = makeContainer();
  const runtime = createSlideRuntime({ slide: slide(), container });
  await runtime.ready();
  await runtime.seek(15);
  runtime.destroy();
  const runtime2 = createSlideRuntime({ slide: slide(), container });
  await runtime2.ready();
  await runtime2.seek(0);
  assert.equal(container.getAttribute("data-lattice-frame"), "0");
  assert.equal(container.getAttribute("data-lattice-stop"), "opening");
  assert.equal(container.getAttribute("data-lattice-revealed-stops"), "opening");
});
