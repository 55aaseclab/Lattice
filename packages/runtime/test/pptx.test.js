import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSvgPaint, parseSvgPathData, parseViewBox } from "../src/renderer/pptx.js";

test("parseViewBox accepts a positive SVG coordinate space", () => {
  assert.deepEqual(parseViewBox({ getAttribute: () => "0 0 100 50" }), {
    x: 0,
    y: 0,
    width: 100,
    height: 50,
  });
  assert.equal(parseViewBox({ getAttribute: () => "0 0 0 50" }), null);
});

test("parseSvgPathData handles straight and curved native paths", () => {
  const points = parseSvgPathData("M0 0 L10 0 Q15 5 10 10 Z");
  assert.equal(points[0].moveTo, true);
  assert.deepEqual(points[1], { x: 10, y: 0 });
  assert.equal(points[2].curve.type, "quadratic");
  assert.equal(points.at(-1).close, true);
  assert.equal(parseSvgPathData("M0 0 A10 10 0 0 0 20 20"), null);
});

test("normalizeSvgPaint converts alpha colors into Office-compatible paint attributes", () => {
  const attributes = new Map([
    ["fill", "rgba(0,102,204,0.12)"],
    ["stroke", "rgba(196,107,0,0.8)"],
    ["stroke-opacity", "0.5"],
  ]);
  const painted = {
    getAttribute: (name) => attributes.get(name) ?? null,
    setAttribute: (name, value) => attributes.set(name, value),
    querySelectorAll: () => [],
  };

  assert.equal(normalizeSvgPaint(painted), painted);
  assert.equal(attributes.get("fill"), "rgb(0, 102, 204)");
  assert.equal(attributes.get("fill-opacity"), "0.12");
  assert.equal(attributes.get("stroke"), "rgb(196, 107, 0)");
  assert.equal(attributes.get("stroke-opacity"), "0.4");
});
