import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SLIDE_CANVAS,
  gridSpacingTokens,
  defineGrid,
  gridContentBox,
  gridColumnSizes,
  gridRowSizes,
  gridTrackOffsets,
  gridPlacementRect,
  gridAreaRect,
  gridTemplateAreasValue,
  gridAreaStyle,
  gridPlacementStyle,
  gridContainerStyle,
  rectToGridPlacement,
  renderGridOverlay,
} from "../src/grid/index.js";

test("canvas defaults to 960x540 and can be overridden", () => {
  assert.deepEqual(SLIDE_CANVAS, { width: 960, height: 540 });
  const grid = defineGrid({ name: "custom", columns: 2, rows: 2, canvas: { width: 1280, height: 720 } });
  assert.deepEqual(grid.canvas, { width: 1280, height: 720 });
});

test("spacing tokens expose a frozen scale", () => {
  assert.equal(gridSpacingTokens.scale.md, 16);
  assert.equal(Object.isFrozen(gridSpacingTokens), true);
});

test("numeric track counts expand to equal fr tracks", () => {
  const grid = defineGrid({ name: "g", columns: 3, rows: 2 });
  assert.deepEqual(grid.columns, [{ fr: 1 }, { fr: 1 }, { fr: 1 }]);
  assert.deepEqual(grid.rows, [{ fr: 1 }, { fr: 1 }]);
});

test("content box subtracts margin from canvas", () => {
  const grid = defineGrid({ name: "g", columns: 2, rows: 2, margin: { x: 33, y: 47 } });
  assert.deepEqual(gridContentBox(grid), { width: 960 - 66, height: 540 - 94 });
});

test("track sizes split the content box deterministically", () => {
  const grid = defineGrid({ name: "g", columns: [420, 420], rows: [60, 359], gap: { x: 55, y: 14 }, margin: { top: 47, left: 33, right: 32, bottom: 60 } });
  assert.deepEqual(gridColumnSizes(grid), [420, 420]);
  assert.deepEqual(gridRowSizes(grid), [60, 359]);
});

test("track offsets include gaps between tracks", () => {
  const grid = defineGrid({ name: "g", columns: [420, 420], rows: 1, gap: { x: 55 } });
  assert.deepEqual(gridTrackOffsets(grid, "columns"), [0, 475]);
});

test("placement rects resolve to pixels within the canvas", () => {
  const grid = defineGrid({
    name: "g",
    columns: [420, 420],
    rows: [60, 359],
    gap: { x: 55, y: 14 },
    margin: { top: 47, left: 33, right: 32, bottom: 60 },
  });
  const rect = gridPlacementRect(grid, { name: "body-right", col: 2, row: 2, colSpan: 1, rowSpan: 1 });
  assert.deepEqual(rect, { left: 33 + 420 + 55, top: 47 + 60 + 14, width: 420, height: 359 });
});

test("named areas resolve via gridAreaRect", () => {
  const grid = defineGrid({ name: "g", columns: [895], rows: [215, 83], areas: { title: { col: 1, row: 1 }, subtitle: { col: 1, row: 2 } } });
  assert.deepEqual(gridAreaRect(grid, "title"), { left: 0, top: 0, width: 895, height: 215 });
  assert.throws(() => gridAreaRect(grid, "missing"), /unknown grid area/);
});

test("unsupported track specs are rejected", () => {
  assert.throws(() => defineGrid({ name: "g", columns: ["50%"], rows: 1 }), /unsupported track spec/);
});

test("css style helpers emit grid placement declarations", () => {
  const grid = defineGrid({ name: "g", columns: [420, 420], rows: [60, 359], gap: { x: 55 }, areas: { "body-left": { col: 1, row: 2 } } });
  assert.equal(gridAreaStyle("body-left"), "grid-area: body-left");
  assert.equal(gridPlacementStyle({ col: 2, row: 2, colSpan: 1, rowSpan: 1 }), "grid-column: 2 ; grid-row: 2;");
  assert.equal(gridPlacementStyle({ col: 1, row: 1, colSpan: 2, rowSpan: 2 }), "grid-column: 1 span 2; grid-row: 1 span 2;");
  assert.match(gridContainerStyle(grid), /grid-template-columns: 420px 420px/);
  assert.match(gridContainerStyle(grid), /column-gap: 55px/);
});

test("grid-template-areas value covers named placements", () => {
  const grid = defineGrid({
    name: "g",
    columns: 2,
    rows: 2,
    areas: { a: { col: 1, row: 1 }, b: { col: 2, row: 2 } },
  });
  assert.equal(gridTemplateAreasValue(grid), "'a .' '. b'");
});

test("rectToGridPlacement maps pixel rects back to grid coordinates", () => {
  const grid = defineGrid({ name: "g", columns: [420, 420], rows: [60, 359], gap: { x: 55, y: 14 }, margin: { top: 47, left: 33, right: 32, bottom: 60 } });
  const placement = rectToGridPlacement(grid, { x: 508, y: 121, w: 420, h: 359 });
  assert.deepEqual(placement, { col: 2, row: 2, colSpan: 1, rowSpan: 1 });
});

test("grid overlay renders debug markup", () => {
  const grid = defineGrid({ name: "g", columns: 2, rows: 2, areas: { a: { col: 1, row: 1 } } });
  const markup = renderGridOverlay(grid);
  assert.match(markup, /sl-grid-overlay/);
  assert.match(markup, /data-area="a"/);
  assert.match(markup, /data-track="1"/);
});
