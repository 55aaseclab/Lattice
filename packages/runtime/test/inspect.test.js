import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RenderReadinessError,
  contrastRatio,
  inspectSlideDensity,
  inspectTextOverflow,
  inspectThemeContrast,
  inspectRenderedDeck,
  installRenderedInspection,
  parseCssColor,
  waitForRenderReadiness,
} from "../src/inspect/index.js";

test("parseCssColor supports opaque and alpha CSS colors", () => {
  assert.deepEqual(parseCssColor("#fff"), { r: 255, g: 255, b: 255, a: 1 });
  assert.deepEqual(parseCssColor("#11223380"), {
    r: 17,
    g: 34,
    b: 51,
    a: 128 / 255,
  });
  assert.deepEqual(parseCssColor("rgba(10, 20, 30, 0.5)"), { r: 10, g: 20, b: 30, a: 0.5 });
});

test("contrastRatio follows WCAG relative luminance", () => {
  assert.equal(contrastRatio("#000", "#fff"), 21);
  assert.ok(Math.abs(contrastRatio("#777", "#fff") - 4.478) < 0.01);
});

test("inspectThemeContrast reports a stable contrast issue", () => {
  const values = new Map([
    ["--title-color", "#777777"],
    ["--slide-bg", "#ffffff"],
  ]);
  const report = inspectThemeContrast({}, {
    slide: "theme",
    pairs: [{ foreground: "--title-color", background: "--slide-bg", token: "title" }],
    getStyle: () => ({ getPropertyValue: (property) => values.get(property) || "" }),
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.errors[0], {
    type: "contrast",
    slide: "theme",
    area: null,
    element: null,
    token: "title",
    ratio: 4.48,
    minimum: 4.5,
    colors: { foreground: "#777777", background: "#ffffff" },
    message: "title contrast is 4.48:1; minimum is 4.5:1",
  });
});

const collection = (entries) => {
  const values = [...entries];
  values.item = (index) => values[index] ?? null;
  return values;
};

function fakeElement({
  name = "body copy",
  area = "body",
  clientWidth = 100,
  clientHeight = 40,
  scrollWidth = clientWidth,
  scrollHeight = clientHeight,
  textContent = "",
} = {}) {
  return {
    clientWidth,
    clientHeight,
    scrollWidth,
    scrollHeight,
    textContent,
    id: "",
    tagName: "DIV",
    classList: collection([]),
    getClientRects: () => collection([{}]),
    getAttribute: (attribute) => ({
      "data-inspector-name": name,
      "aria-label": "",
      "data-area": area,
    })[attribute] || "",
    closest: () => ({
      classList: collection(["sl-grid-cell"]),
      getAttribute: (attribute) => attribute === "data-area" ? area : "",
      style: {},
    }),
  };
}

test("inspectTextOverflow returns an addressable browser-layout issue", () => {
  const overflowing = fakeElement({ scrollHeight: 57 });
  const slide = {
    dataset: { slideId: "results" },
    querySelectorAll: () => collection([overflowing]),
  };
  const report = inspectTextOverflow(slide, {
    getStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
  });
  assert.equal(report.ok, false);
  assert.deepEqual(report.errors[0], {
    type: "text-overflow",
    slide: "results",
    area: "body",
    element: "body copy",
    overflow: { x: 0, y: 17 },
    message: 'body copy overflows area "body" by 0px horizontally and 17px vertically',
  });
});

test("inspectSlideDensity reports element and word thresholds", () => {
  const elements = collection([
    fakeElement({ name: "one" }),
    fakeElement({ name: "two" }),
    fakeElement({ name: "three" }),
  ]);
  const slide = {
    dataset: { slideNumber: "4" },
    textContent: "one two three four five",
    querySelectorAll: () => elements,
    cloneNode: () => ({
      textContent: "one two three four five",
      querySelectorAll: () => collection([]),
    }),
  };
  const report = inspectSlideDensity(slide, { maxElements: 2, maxWords: 4 });
  assert.equal(report.ok, false);
  assert.deepEqual(report.errors[0].counts, { elements: 3, words: 5 });
  assert.deepEqual(report.errors[0].limits, { elements: 2, words: 4 });
  assert.equal(report.errors[0].slide, "4");
});

test("inspectRenderedDeck measures Reveal-hidden slides and restores their inline style", async () => {
  const overflowing = fakeElement({ scrollHeight: 57 });
  let styleAttribute = "color: rebeccapurple";
  let display = "none";
  let visibility = "hidden";
  const slide = {
    dataset: { slideNumber: "2" },
    clientWidth: 960,
    clientHeight: 540,
    textContent: "hidden slide copy",
    style: {
      setProperty: (property, value) => {
        if (property === "display") display = value;
        if (property === "visibility") visibility = value;
      },
    },
    getClientRects: () => collection(display === "none" ? [] : [{}]),
    getAttribute: (attribute) => attribute === "style" ? styleAttribute : "",
    setAttribute: (attribute, value) => {
      if (attribute === "style") {
        styleAttribute = value;
        display = "none";
        visibility = "hidden";
      }
    },
    removeAttribute: (attribute) => {
      if (attribute === "style") styleAttribute = null;
    },
    querySelectorAll: () => collection([overflowing]),
    cloneNode: () => ({
      textContent: "hidden slide copy",
      querySelectorAll: () => collection([]),
    }),
  };
  slide.ownerDocument = {
    defaultView: {
      getComputedStyle: (element) => element === slide
        ? { display, visibility, opacity: "1" }
        : { display: "block", visibility: "visible", opacity: "1" },
    },
  };
  const root = {
    querySelectorAll: () => collection([slide]),
    documentElement: null,
  };

  const report = await inspectRenderedDeck(root, { contrast: false });

  assert.equal(report.ok, false);
  assert.equal(report.slides, 1);
  assert.equal(report.errors[0].slide, "2");
  assert.equal(report.errors[0].overflow.y, 17);
  assert.equal(styleAttribute, "color: rebeccapurple");
  assert.equal(display, "none");
  assert.equal(visibility, "hidden");
});

test("inspectRenderedDeck waits for fonts triggered by exposing hidden slides before measuring", async () => {
  // A hidden slide's webfont starts loading only when the inspector exposes
  // it; measuring before the face settles reports fallback-font overflow that
  // does not exist in the rendered deck.
  let measuredWhileLoading = false;
  let fontSettled = false;
  const face = {
    family: "Fixture Font",
    weight: "600",
    style: "normal",
    status: "loading",
    loaded: Promise.resolve().then(() => {
      face.status = "loaded";
      fontSettled = true;
    }),
  };
  const fonts = {
    ready: Promise.resolve(),
    *[Symbol.iterator]() {
      yield face;
    },
  };
  const sliding = fakeElement({ scrollHeight: 57 });
  const slide = {
    dataset: { slideNumber: "3" },
    clientWidth: 960,
    clientHeight: 540,
    textContent: "copy",
    getClientRects: () => collection([]),
    getAttribute: () => "",
    setAttribute: () => {},
    style: { setProperty: () => {}, removeAttribute: () => {} },
    querySelectorAll: () => collection({
      // scrollHeight only becomes clean after the font settles.
      *[Symbol.iterator]() {
        yield {
          clientWidth: 100, clientHeight: 40,
          scrollWidth: 100, scrollHeight: fontSettled ? 40 : 97,
          textContent: "copy", id: "", tagName: "DIV",
          classList: collection([]),
          getClientRects: () => collection([{}]),
          getAttribute: (attribute) => ({
            "data-inspector-name": "copy block",
            "aria-label": "",
            "data-area": "body",
          })[attribute] || "",
          closest: () => ({
            classList: collection(["sl-grid-cell"]),
            getAttribute: (attribute) => attribute === "data-area" ? "body" : "",
            style: {},
          }),
        };
      },
    }),
    cloneNode: () => ({ textContent: "copy", querySelectorAll: () => collection([]) }),
  };
  slide.ownerDocument = {
    fonts,
    defaultView: {
      requestAnimationFrame: (resolve) => setTimeout(resolve, 0),
      getComputedStyle: () => ({ display: "block", visibility: "visible", opacity: "1" }),
    },
  };
  const root = {
    querySelectorAll: () => collection([slide]),
    documentElement: null,
    ownerDocument: slide.ownerDocument,
  };

  const report = await inspectRenderedDeck(root, { contrast: false });

  assert.equal(fontSettled, true);
  assert.equal(measuredWhileLoading, false);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  void sliding;
});

const noopSleep = () => Promise.resolve();

const fakeFontSet = (faces, ready = Promise.resolve()) => ({
  ready,
  *[Symbol.iterator]() {
    yield* faces;
  },
});

test("waitForRenderReadiness resolves once fonts settle and reports failed images", async () => {
  let fontSettled = false;
  const fonts = { ready: Promise.resolve().then(() => { fontSettled = true; }) };
  const brokenImage = { complete: true, naturalWidth: 0, currentSrc: "assets/broken.png", getAttribute: () => "assets/broken.png" };
  const decodedImage = { complete: true, naturalWidth: 640, currentSrc: "assets/ok.png", getAttribute: () => "assets/ok.png" };
  const root = { querySelectorAll: () => collection([brokenImage, decodedImage]) };

  const readiness = await waitForRenderReadiness(root, { fonts, sleep: noopSleep });

  assert.equal(fontSettled, true);
  assert.deepEqual(readiness, {
    fonts: "ready",
    fontsFailed: [],
    images: { total: 2, failed: ["assets/broken.png"] },
    durationMs: readiness.durationMs,
  });
});

test("waitForRenderReadiness waits for images that are still loading", async () => {
  const loadingImage = { complete: false, naturalWidth: 0, currentSrc: "assets/late.png", getAttribute: () => "assets/late.png" };
  const root = { querySelectorAll: () => collection([loadingImage]) };
  const wait = waitForRenderReadiness(root, { timeout: 5000, fonts: null });
  setTimeout(() => {
    loadingImage.complete = true;
    loadingImage.naturalWidth = 10;
  }, 20);
  const readiness = await wait;
  assert.deepEqual(readiness.images, { total: 1, failed: [] });
});

test("waitForRenderReadiness throws with blocking resources on timeout", async () => {
  const fonts = { ready: new Promise(() => {}) };
  const root = { querySelectorAll: () => collection([]) };
  await assert.rejects(
    waitForRenderReadiness(root, { fonts, timeout: 20, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }),
    (error) => {
      assert.ok(error instanceof RenderReadinessError);
      assert.deepEqual(error.blocking, ["document.fonts.ready"]);
      assert.match(error.message, /document\.fonts\.ready/);
      return true;
    },
  );
});

test("waitForRenderReadiness times out when an image never completes", async () => {
  const stuckImage = { complete: false, naturalWidth: 0, currentSrc: "assets/stuck.png", getAttribute: () => "assets/stuck.png" };
  const root = { querySelectorAll: () => collection([stuckImage]) };
  await assert.rejects(
    waitForRenderReadiness(root, { fonts: null, timeout: 20, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }),
    (error) => {
      assert.ok(error instanceof RenderReadinessError);
      assert.match(error.message, /assets\/stuck\.png/);
      return true;
    },
  );
});

test("waitForRenderReadiness ignores images without a source", async () => {
  const emptyImage = { complete: true, naturalWidth: 0, currentSrc: "", getAttribute: () => null };
  const readiness = await waitForRenderReadiness(
    { querySelectorAll: () => collection([emptyImage]) },
    { fonts: null, sleep: noopSleep },
  );
  assert.deepEqual(readiness.images, { total: 1, failed: [] });
});

test("waitForRenderReadiness awaits HTMLImageElement.decode before reporting ready", async () => {
  let decodeSettled = false;
  const undecodedImage = {
    complete: false,
    naturalWidth: 0,
    currentSrc: "assets/decoding.png",
    getAttribute: () => "assets/decoding.png",
    decode: () => Promise.resolve().then(() => { decodeSettled = true; }),
  };
  const readiness = await waitForRenderReadiness(
    { querySelectorAll: () => collection([undecodedImage]) },
    { fonts: null, sleep: noopSleep },
  );
  assert.equal(decodeSettled, true);
  assert.deepEqual(readiness.images, { total: 1, failed: [] });
});

test("waitForRenderReadiness reports decode rejection as a failed image", async () => {
  const rejectedImage = {
    complete: false,
    naturalWidth: 0,
    currentSrc: "assets/corrupt.png",
    getAttribute: () => "assets/corrupt.png",
    decode: () => Promise.reject(new Error("EncodingError")),
  };
  const readiness = await waitForRenderReadiness(
    { querySelectorAll: () => collection([rejectedImage]) },
    { fonts: null, sleep: noopSleep },
  );
  assert.deepEqual(readiness.images, { total: 1, failed: ["assets/corrupt.png"] });
});

test("waitForRenderReadiness times out naming an image whose decode never settles", async () => {
  const hungImage = {
    complete: false,
    naturalWidth: 0,
    currentSrc: "assets/hung.png",
    getAttribute: () => "assets/hung.png",
    decode: () => new Promise(() => {}),
  };
  await assert.rejects(
    waitForRenderReadiness(
      { querySelectorAll: () => collection([hungImage]) },
      { fonts: null, timeout: 20, sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)) },
    ),
    (error) => {
      assert.ok(error instanceof RenderReadinessError);
      assert.match(error.message, /assets\/hung\.png/);
      return true;
    },
  );
});

test("waitForRenderReadiness treats a synchronous decode throw as a failed image", async () => {
  const throwingImage = {
    complete: false,
    naturalWidth: 0,
    currentSrc: "assets/throws.png",
    getAttribute: () => "assets/throws.png",
    decode: () => {
      throw new Error("InvalidStateError");
    },
  };
  const readiness = await waitForRenderReadiness(
    { querySelectorAll: () => collection([throwingImage]) },
    { fonts: null, sleep: noopSleep },
  );
  assert.deepEqual(readiness.images, { total: 1, failed: ["assets/throws.png"] });
});

test("waitForRenderReadiness reports FontFaceSet status error entries as failed fonts", async () => {
  const fonts = fakeFontSet([
    { family: "Broken Font", status: "error" },
    { family: "Broken Font", status: "error" },
    { family: "Good Font", status: "loaded" },
    { family: "Idle Font", status: "unloaded" },
  ]);
  const readiness = await waitForRenderReadiness(
    { querySelectorAll: () => collection([]) },
    { fonts, sleep: noopSleep },
  );
  assert.equal(readiness.fonts, "ready");
  assert.deepEqual(readiness.fontsFailed, ["Broken Font"]);
});

test("waitForRenderReadiness reports no failed fonts without a usable FontFaceSet", async () => {
  const readiness = await waitForRenderReadiness(
    { querySelectorAll: () => collection([]) },
    { fonts: { ready: Promise.resolve() }, sleep: noopSleep },
  );
  assert.equal(readiness.fonts, "ready");
  assert.deepEqual(readiness.fontsFailed, []);
});

test("installRenderedInspection reports failed fonts as missing-font findings", async () => {
  const events = [];
  const target = {
    CustomEvent: class {
      constructor(type, options) {
        this.type = type;
        this.detail = options.detail;
      }
    },
    dispatchEvent: (event) => events.push(event),
  };
  const root = {
    querySelectorAll: () => collection([]),
    documentElement: null,
    ownerDocument: {
      fonts: fakeFontSet([{ family: "Lattice Fixture Missing", status: "error" }]),
    },
  };
  const report = await installRenderedInspection(root, {
    location: { href: "https://slides.example.test/?inspect=1" },
    target,
    deck: "missing-font",
    options: { contrast: false },
  });
  assert.equal(report.ok, false);
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].type, "missing-font");
  assert.equal(report.errors[0].slide, "missing-font");
  assert.equal(report.errors[0].area, null);
  assert.equal(report.errors[0].element, "Lattice Fixture Missing");
  assert.equal(report.errors[0].family, "Lattice Fixture Missing");
  assert.match(report.errors[0].message, /webfont failed to load/);
  assert.deepEqual(report.readiness.fontsFailed, ["Lattice Fixture Missing"]);
  assert.equal(target.__latticeInspection, report);
});

test("installRenderedInspection stamps theme contrast findings with the deck id", async () => {
  const events = [];
  const target = {
    CustomEvent: class {
      constructor(type, options) {
        this.type = type;
        this.detail = options.detail;
      }
    },
    dispatchEvent: (event) => events.push(event),
  };
  const tokenValues = {
    "--title-color": "#777777",
    "--body-color": "#000000",
    "--slide-bg": "#ffffff",
  };
  const view = { getComputedStyle: () => ({ getPropertyValue: (property) => tokenValues[property] ?? "" }) };
  const root = {
    querySelectorAll: () => collection([]),
    documentElement: { ownerDocument: { defaultView: view } },
  };
  const report = await installRenderedInspection(root, {
    location: { href: "https://slides.example.test/?inspect=1" },
    target,
    deck: "contrast-fixture",
  });
  assert.equal(report.ok, false);
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].type, "contrast");
  assert.equal(report.errors[0].slide, "contrast-fixture");
  assert.equal(report.errors[0].token, "title-color/slide-bg");
  assert.equal(report.errors[0].ratio, 4.48);
  assert.ok(report.errors[0].ratio < report.errors[0].minimum);
});

test("installRenderedInspection is opt-in and dispatches a stable report", async () => {
  const events = [];
  class InspectionEvent {
    constructor(type, options) {
      this.type = type;
      this.detail = options.detail;
    }
  }
  const target = {
    CustomEvent: InspectionEvent,
    dispatchEvent: (event) => events.push(event),
  };
  const root = {
    querySelectorAll: () => collection([]),
    documentElement: null,
  };
  const report = await installRenderedInspection(root, {
    location: { href: "https://slides.example.test/?inspect=1" },
    target,
    deck: "demo",
    options: { contrast: false },
  });
  assert.equal(report.ok, true);
  assert.deepEqual(report.errors, []);
  assert.equal(report.deck, "demo");
  assert.equal(report.slides, 0);
  assert.deepEqual(report.readiness, { fonts: "unavailable", fontsFailed: [], images: { total: 0, failed: [] }, durationMs: report.readiness.durationMs });
  assert.equal(target.__latticeInspection, report);
  assert.equal(events[0].type, "lattice:inspection");
  assert.equal(events[0].detail, report);
  assert.equal(await installRenderedInspection(root, {
    location: { href: "https://slides.example.test/" },
    target,
  }), null);
});

test("installRenderedInspection reports failed images as missing-asset findings", async () => {
  const events = [];
  const target = {
    CustomEvent: class {
      constructor(type, options) {
        this.type = type;
        this.detail = options.detail;
      }
    },
    dispatchEvent: (event) => events.push(event),
  };
  const brokenImage = { complete: true, naturalWidth: 0, currentSrc: "assets/broken.png", getAttribute: () => "assets/broken.png" };
  const root = {
    querySelectorAll: () => collection([brokenImage]),
    documentElement: null,
  };
  const report = await installRenderedInspection(root, {
    location: { href: "https://slides.example.test/?inspect=1" },
    target,
    deck: "broken-deck",
    options: { contrast: false },
  });
  assert.equal(report.ok, false);
  assert.equal(report.errors[0].type, "missing-asset");
  assert.equal(report.errors[0].url, "assets/broken.png");
  assert.match(report.errors[0].message, /failed to load or decode/);
  assert.equal(target.__latticeInspection, report);
});

test("installRenderedInspection reports a ready-timeout as a blocking finding", async () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args);
  try {
    const events = [];
    const target = {
      CustomEvent: class {
        constructor(type, options) {
          this.type = type;
          this.detail = options.detail;
        }
      },
      dispatchEvent: (event) => events.push(event),
    };
    const root = {
      querySelectorAll: () => collection([]),
      documentElement: null,
      ownerDocument: { fonts: { ready: new Promise(() => {}) } },
    };
    const report = await installRenderedInspection(root, {
      location: { href: "https://slides.example.test/?inspect=1" },
      target,
      deck: "stalled-deck",
      readyTimeout: 20,
      options: { contrast: false },
    });
    assert.equal(report.ok, false);
    assert.equal(report.slides, 0);
    assert.equal(report.errors[0].type, "ready-timeout");
    assert.match(report.errors[0].message, /stalled-deck/);
    assert.equal(events[0].detail, report);
    assert.equal(target.__latticeInspection, report);
  } finally {
    console.warn = originalWarn;
  }
});
