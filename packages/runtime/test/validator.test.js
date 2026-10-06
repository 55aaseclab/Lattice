import assert from "node:assert/strict";
import { test } from "node:test";
import { defineGrid } from "../src/grid/index.js";
import {
  rectsOverlap,
  validateGridPlacements,
  validateGrids,
  validateRects,
  validateAssets,
} from "../src/validator/index.js";

test("rectsOverlap detects overlapping and non-overlapping rects", () => {
  assert.equal(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 }), true);
  assert.equal(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 20, y: 20, w: 10, h: 10 }), false);
});

test("validateGridPlacements reports out-of-bounds placements", () => {
  const grid = defineGrid({ name: "demo", columns: 2, rows: 2, areas: { big: { col: 2, row: 2, colSpan: 2, rowSpan: 2 } } });
  const report = validateGridPlacements(grid);
  assert.equal(report.ok, false);
  assert.equal(report.errors[0].type, "out-of-bounds");
});

test("validateGridPlacements reports overlapping placements", () => {
  const grid = defineGrid({ name: "demo", columns: 2, rows: 2, areas: { a: { col: 1, row: 1 }, b: { col: 1, row: 1 } } });
  const report = validateGridPlacements(grid);
  assert.equal(report.ok, false);
  assert.equal(report.errors[0].type, "overlap");
});

test("validateGridPlacements accepts legal placements", () => {
  const grid = defineGrid({ name: "demo", columns: 2, rows: 2, areas: { a: { col: 1, row: 1 }, b: { col: 2, row: 2 } } });
  assert.deepEqual(validateGridPlacements(grid), { ok: true, errors: [] });
});

test("validateGrids aggregates reports across grids", () => {
  const gridA = defineGrid({ name: "a", columns: 1, rows: 1, areas: { x: { col: 2, row: 1 } } });
  const gridB = defineGrid({ name: "b", columns: 1, rows: 1, areas: { y: { col: 1, row: 1 } } });
  const report = validateGrids([gridA, gridB]);
  assert.equal(report.ok, false);
  assert.equal(report.errors.length, 1);
});

test("validateRects reports canvas out-of-bounds rects", () => {
  const report = validateRects([
    { x: 0, y: 0, w: 100, h: 100, label: "ok" },
    { x: 950, y: 500, w: 100, h: 100, label: "outside" },
  ]);
  assert.equal(report.ok, false);
  assert.equal(report.errors[0].type, "out-of-bounds");
  assert.equal(report.errors[0].item, "outside");
});

test("validateAssets scans markup for referenced assets", () => {
  const markup = `<img src="./assets/a.png"><img src="/decks/demo/assets/b.png"><img src="./assets/c.png">`;
  const report = validateAssets([markup], {
    exists: (url) => url.endsWith("a.png") || url.endsWith("b.png"),
  });
  assert.equal(report.ok, false);
  assert.equal(report.errors[0].type, "missing-asset");
  assert.equal(report.assets.length, 3);
});
