import assert from "node:assert/strict";
import { test } from "node:test";
import {
  contrastRatio,
  inspectSlideDensity,
  inspectTextOverflow,
  inspectThemeContrast,
  inspectRenderedDeck,
  installRenderedInspection,
  parseCssColor,
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

test("inspectRenderedDeck measures Reveal-hidden slides and restores their inline style", () => {
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

  const report = inspectRenderedDeck(root, { contrast: false });

  assert.equal(report.ok, false);
  assert.equal(report.slides, 1);
  assert.equal(report.errors[0].slide, "2");
  assert.equal(report.errors[0].overflow.y, 17);
  assert.equal(styleAttribute, "color: rebeccapurple");
  assert.equal(display, "none");
  assert.equal(visibility, "hidden");
});

test("installRenderedInspection is opt-in and dispatches a stable report", () => {
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
  const report = installRenderedInspection(root, {
    location: { href: "https://slides.example.test/?inspect=1" },
    target,
    deck: "demo",
    options: { contrast: false },
  });
  assert.deepEqual(report, { deck: "demo", ok: true, errors: [], slides: 0 });
  assert.equal(target.__latticeInspection, report);
  assert.equal(events[0].type, "lattice:inspection");
  assert.equal(events[0].detail, report);
  assert.equal(installRenderedInspection(root, {
    location: { href: "https://slides.example.test/" },
    target,
  }), null);
});
