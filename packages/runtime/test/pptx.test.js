import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSvgPathData, parseViewBox } from "../src/renderer/pptx.js";

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
