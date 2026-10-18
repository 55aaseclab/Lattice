import assert from "node:assert/strict";
import { test } from "node:test";
import { defineGrid } from "../src/grid/index.js";
import {
  collectMarkupAssets,
  createValidationIssue,
  formatValidationIssue,
  rectsOverlap,
  validateGridPlacements,
  validateGrids,
  validateRects,
  validateAssets,
} from "../src/validator/index.js";

test("createValidationIssue always returns the stable agent address envelope", () => {
  assert.deepEqual(createValidationIssue({ type: "density", message: "busy" }), {
    type: "density",
    slide: null,
    area: null,
    element: null,
    message: "busy",
  });
});

test("formatValidationIssue prints the agent address before the explanation", () => {
  assert.equal(
    formatValidationIssue(createValidationIssue({
      type: "text-overflow",
      slide: 3,
      area: "body",
      element: "results table",
      message: "content overflows",
    })),
    "[text-overflow] slide=3 area=body element=results table content overflows",
  );
});

test("rectsOverlap detects overlapping and non-overlapping rects", () => {
  assert.equal(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }), true);
  assert.equal(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 10, h: 10 }), false);
});

test("validateGridPlacements reports an addressable out-of-bounds placement", () => {
  const grid = defineGrid({
    name: "demo",
    columns: 2,
    rows: 2,
    areas: { big: { col: 2, row: 2, colSpan: 2, rowSpan: 2 } },
  });
  const report = validateGridPlacements(grid, [...grid.areas.values()], { slide: "results" });
  assert.deepEqual(report.errors[0], {
    type: "out-of-bounds",
    slide: "results",
    area: "big",
    element: "big",
    message: "demo: placement big exceeds grid bounds (2x2)",
  });
});

test("validateGridPlacements reports both sides of an overlap", () => {
  const grid = defineGrid({
    name: "demo",
    columns: 2,
    rows: 2,
    areas: { a: { col: 1, row: 1 }, b: { col: 1, row: 1 } },
  });
  const report = validateGridPlacements(grid, [
    { ...grid.areas.get("a"), element: "headline" },
    { ...grid.areas.get("b"), element: "hero figure" },
  ], { slide: 2 });
  assert.deepEqual(report.errors[0], {
    type: "overlap",
    slide: 2,
    area: null,
    element: null,
    areas: ["a", "b"],
    elements: ["headline", "hero figure"],
    message: "demo: placements a and b overlap",
  });
});

test("validateGridPlacements accepts legal placements", () => {
  const grid = defineGrid({
    name: "demo",
    columns: 2,
    rows: 2,
    areas: { a: { col: 1, row: 1 }, b: { col: 2, row: 2 } },
  });
  assert.deepEqual(validateGridPlacements(grid), { ok: true, errors: [] });
});

test("validateGrids accepts grid entries with per-grid slide addresses", () => {
  const gridA = defineGrid({ name: "a", columns: 1, rows: 1, areas: { x: { col: 2, row: 1 } } });
  const gridB = defineGrid({ name: "b", columns: 1, rows: 1, areas: { y: { col: 1, row: 1 } } });
  const report = validateGrids([{ grid: gridA, slide: "intro" }, { grid: gridB, slide: "end" }]);
  assert.equal(report.ok, false);
  assert.equal(report.errors.length, 1);
  assert.equal(report.errors[0].slide, "intro");
});

test("validateRects reports canvas out-of-bounds rects with the unified address", () => {
  const report = validateRects([
    { x: 0, y: 0, w: 100, h: 100, element: "ok" },
    { x: 950, y: 500, w: 100, h: 100, element: "outside", area: "hero" },
  ], { slide: 4 });
  assert.equal(report.ok, false);
  assert.equal(report.errors[0].type, "out-of-bounds");
  assert.equal(report.errors[0].slide, 4);
  assert.equal(report.errors[0].area, "hero");
  assert.equal(report.errors[0].element, "outside");
});

test("collectMarkupAssets inherits the nearest authored inspector name", () => {
  const assets = collectMarkupAssets(`
    <section data-slide-number="3">
      <figure class="slide-figure" data-inspector-name="results figure">
        <img src="./assets/a.png" alt="">
      </figure>
      <a aria-label="dataset" href="/decks/demo/assets/data.json">Data</a>
    </section>
  `);
  assert.deepEqual(assets, [
    { url: "./assets/a.png", element: "results figure", tag: "img", attribute: "src" },
    { url: "/decks/demo/assets/data.json", element: "dataset", tag: "a", attribute: "href" },
  ]);
});

test("validateAssets reports each missing asset at its slide and element", () => {
  const slides = [
    `<section data-slide-number="1"><figure data-inspector-name="hero"><img src="./assets/a.png"></figure></section>`,
    `<section data-slide-number="2"><img src="/decks/demo/assets/b.png"><img src="./assets/a.png"></section>`,
  ];
  const report = validateAssets(slides, {
    exists: (url) => url.endsWith("b.png"),
  });
  assert.equal(report.ok, false);
  assert.equal(report.errors.length, 2);
  assert.deepEqual(report.errors[0], {
    type: "missing-asset",
    slide: "1",
    area: null,
    element: "hero",
    url: "./assets/a.png",
    message: "asset not found: ./assets/a.png",
  });
  assert.equal(report.errors[1].slide, "2");
  assert.equal(report.errors[1].element, "img");
  assert.deepEqual(report.assets, ["./assets/a.png", "/decks/demo/assets/b.png"]);
});
