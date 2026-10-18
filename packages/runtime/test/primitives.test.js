import assert from "node:assert/strict";
import { test } from "node:test";
import { createPrimitives } from "../src/primitives/index.js";

const blocks = createPrimitives({});

test("table renders thead/tbody with compact variant", () => {
  const markup = blocks.table({
    head: ["A", "B"],
    rows: [
      ["1", "2"],
      ["3", "4"],
    ],
    caption: "Results",
    compact: true,
  });
  assert.ok(markup.includes('<caption>Results</caption>'));
  assert.ok(markup.includes("<thead>"));
  assert.ok(markup.includes("<th>A</th>"));
  assert.ok(markup.includes("<td>1</td>"));
  assert.ok(markup.includes('class="slide-table slide-table-compact"'));
});

test("table without head or caption omits them", () => {
  const markup = blocks.table({ rows: [["x"]] });
  assert.ok(!markup.includes("<thead>"));
  assert.ok(!markup.includes("<caption>"));
  assert.ok(markup.includes('class="slide-table"'));
});

test("table escapes inspector name", () => {
  const markup = blocks.table({ rows: [["x"]], name: 'title "quoted"' });
  assert.ok(markup.includes('data-inspector-name="title &quot;quoted&quot;"'));
});

test("table rejects non-array tabular data", () => {
  assert.throws(() => blocks.table({ head: "A", rows: [] }), /table\.head must be an array/);
  assert.throws(() => blocks.table({ rows: ["not a row"] }), /table\.rows\[0\] must be an array/);
});

test("table supports explicit cell spans without handwritten table markup", () => {
  const markup = blocks.table({
    head: [{ value: "Results", colspan: 2, scope: "colgroup" }],
    rows: [[{ value: "Pass", rowspan: 2 }, "1"], ["2"]],
  });

  assert.ok(markup.includes('<th colspan="2" scope="colgroup">Results</th>'));
  assert.ok(markup.includes('<td rowspan="2">Pass</td>'));
});

test("table rejects unsupported cell values", () => {
  assert.throws(
    () => blocks.table({ rows: [[{ unexpected: true }]] }),
    /table cell value must be a string, number, or boolean/,
  );
});

test("image renders figure with standard fit as class", () => {
  const markup = blocks.image({
    src: "/decks/m1-test/assets/lattice-grid.svg",
    alt: "grid",
    fit: "contain",
    ratio: "16 / 9",
    caption: "Figure 1",
  });
  assert.ok(markup.includes('<img src="/decks/m1-test/assets/lattice-grid.svg" alt="grid"'));
  assert.ok(markup.includes('class="slide-figure slide-fit-contain"'));
  assert.ok(!markup.includes("object-fit:"));
  assert.ok(markup.includes("aspect-ratio: 16 / 9"));
  assert.ok(markup.includes("<figcaption>Figure 1</figcaption>"));
});

test("image rejects unsupported fit values", () => {
  assert.throws(
    () => blocks.image({ src: "/a.png", fit: "none" }),
    /image\.fit must be contain, cover, or stretch/,
  );
});

test("image without optional style options renders plain img", () => {
  const markup = blocks.image({ src: "/a.png" });
  assert.ok(markup.includes('<img src="/a.png" alt="">'));
  assert.ok(!markup.includes("style="));
  assert.ok(!markup.includes("<figcaption>"));
});

test("image requires a source", () => {
  assert.throws(() => blocks.image({}), /image\.src must be a non-empty string/);
});

test("grid cells share the standard slide-fit class contract", () => {
  const cell = blocks.gridCell({ col: 1, row: 1, fit: "cover", content: '<img src="/a.png" alt="">' });
  assert.ok(cell.includes('class="sl-grid-cell slide-fit-cover"'));

  const grid = blocks.grid({
    columns: [100],
    rows: [100],
    overlay: false,
    cells: [{ col: 1, row: 1, fit: "stretch", content: "<table></table>" }],
  });
  assert.ok(grid.includes('class="sl-grid-cell slide-fit-stretch"'));
  assert.ok(!grid.includes("sl-fit-stretch"));
});

test("grid cells reject unsupported fit values", () => {
  assert.throws(
    () => blocks.gridCell({ col: 1, row: 1, fit: "unknown", content: "x" }),
    /grid cell\.fit must be contain, cover, or stretch/,
  );
});

test("textbox injects data-inspector-name when named", () => {
  assert.ok(blocks.textbox({ body: "hi", name: "intro title" }).includes('data-inspector-name="intro title"'));
  assert.ok(!blocks.textbox({ body: "hi" }).includes("data-inspector-name"));
});

test("positioned injects data-inspector-name when named", () => {
  const markup = blocks.positioned({ body: "hi", name: "positioned callout" });
  assert.ok(markup.includes('data-inspector-name="positioned callout"'));
});
