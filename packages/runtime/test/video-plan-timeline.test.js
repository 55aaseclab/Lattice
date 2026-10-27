import assert from "node:assert/strict";
import { test } from "node:test";
import {
  VIDEO_PLAN_SCHEMA,
  VIDEO_PLAN_SCHEMA_V2,
  bakeVideoPlanProvenance,
  compileVideoPlan,
  hashVideoPlan,
  serializeVideoPlan,
  validateVideoPlan,
} from "../src/video-plan/index.js";

const sha = (label) => "p".repeat(0) + label;

test("static plans keep the v1 schema and byte layout (no timeline data)", () => {
  const result = compileVideoPlan({
    deckId: "demo",
    routeId: "main",
    routes: { main: ["a", "b"] },
    slides: [
      { id: "a", durationFrames: 30 },
      { id: "b", durationFrames: 45, inputProps: {} },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.schema, VIDEO_PLAN_SCHEMA);
  for (const clip of result.plan.clips) {
    assert.equal("stops" in clip, false);
    assert.equal("animation" in clip, false);
  }
  const canonical = serializeVideoPlan(result.plan);
  // Byte-level snapshot of the exact pre-M7 plan shape.
  assert.equal(canonical, `{
  "audioTracks": [],
  "clips": [
    {
      "durationFrames": 30,
      "inputProps": {},
      "slideId": "a",
      "source": "slide:a",
      "startFrame": 0
    },
    {
      "durationFrames": 45,
      "inputProps": {},
      "slideId": "b",
      "source": "slide:b",
      "startFrame": 30
    }
  ],
  "deckId": "demo",
  "fps": 30,
  "height": 540,
  "provenance": {
    "bundleHash": "",
    "deckHash": "",
    "inputPropsHash": "",
    "toolchain": {}
  },
  "routeId": "main",
  "schema": "lattice.video-plan.v1",
  "totalFrames": 75,
  "width": 960
}`);
});

test("timeline plans compile to lattice.video-plan.v2 with stop schedules and animation", () => {
  const result = compileVideoPlan({
    deckId: "demo",
    routeId: "main",
    routes: { main: ["a"] },
    slides: [
      {
        id: "a",
        durationFrames: 90,
        stops: [{ id: "open", frame: 0 }, { id: "point", frame: 40 }],
        animation: { preset: "rise", direction: "up", durationFrames: 12, stagger: 2, distancePx: 24 },
      },
    ],
  });
  assert.equal(result.ok, true, result.reason);
  assert.equal(result.plan.schema, VIDEO_PLAN_SCHEMA_V2);
  assert.deepEqual(result.plan.clips[0].stops, [{ id: "open", frame: 0 }, { id: "point", frame: 40 }]);
  assert.deepEqual(result.plan.clips[0].animation, { preset: "rise", direction: "up", durationFrames: 12, stagger: 2, distancePx: 24 });
  const baked = bakeVideoPlanProvenance(result.plan, { deckHash: sha("d"), bundleHash: sha("b"), inputPropsHash: sha("i") });
  assert.equal(validateVideoPlan(baked).ok, true);
});

test("a single timeline-carrying clip versions the whole plan (v2), static clips stay untouched", () => {
  const result = compileVideoPlan({
    deckId: "demo",
    routeId: "main",
    routes: { main: ["a", "b"] },
    slides: [
      { id: "a", durationFrames: 30 },
      { id: "b", durationFrames: 45, stops: [{ id: "static", frame: 0 }] },
    ],
  });
  assert.equal(result.plan.schema, VIDEO_PLAN_SCHEMA_V2);
  assert.equal("stops" in result.plan.clips[0], false);
  assert.deepEqual(result.plan.clips[1].stops, [{ id: "static", frame: 0 }]);
});

test("stop schedule validation: order, range, duplicates, and shape fail fast", () => {
  const cases = [
    { stops: [], reason: "non-empty array" },
    { stops: [{ id: "a", frame: 5 }, { id: "b", frame: 5 }], reason: "strictly increasing" },
    { stops: [{ id: "a", frame: 0 }, { id: "a", frame: 10 }], reason: "duplicate id" },
    { stops: [{ id: "a", frame: 0 }, { id: "b", frame: 30 }], reason: "frame range" },
    { stops: [{ id: "Bad Id", frame: 0 }], reason: "stable slug" },
    { stops: [{ id: "a", frame: 1.5 }], reason: "integer frame" },
  ];
  for (const testCase of cases) {
    const result = compileVideoPlan({
      deckId: "demo",
      routeId: "main",
      routes: { main: ["a"] },
      slides: [{ id: "a", durationFrames: 20, ...testCase }],
    });
    assert.equal(result.ok, false, JSON.stringify(testCase.stops));
  }
});

test("animation validation is structural; preset names are the catalog's business", () => {
  const bad = compileVideoPlan({
    deckId: "demo",
    routeId: "main",
    routes: { main: ["a"] },
    slides: [{ id: "a", durationFrames: 20, animation: { preset: "" } }],
  });
  assert.equal(bad.ok, false);
  const badParam = compileVideoPlan({
    deckId: "demo",
    routeId: "main",
    routes: { main: ["a"] },
    slides: [{ id: "a", durationFrames: 20, animation: { preset: "rise", durationFrames: -1 } }],
  });
  assert.equal(badParam.ok, false);
  // Unknown preset names pass structural validation — the deck compile step
  // validates them against the theme catalog.
  const structuralOnly = compileVideoPlan({
    deckId: "demo",
    routeId: "main",
    routes: { main: ["a"] },
    slides: [{ id: "a", durationFrames: 20, animation: { preset: "not-a-real-preset" } }],
  });
  assert.equal(structuralOnly.ok, true);
});

test("validateVideoPlan rejects timeline data on a v1 plan and accepts it on v2", () => {
  const base = compileVideoPlan({
    deckId: "demo",
    routeId: "main",
    routes: { main: ["a"] },
    slides: [{ id: "a", durationFrames: 20 }],
  });
  const v1WithStops = {
    ...structuredClone(base.plan),
    clips: [{ ...base.plan.clips[0], stops: [{ id: "a", frame: 0 }] }],
  };
  const report = validateVideoPlan(v1WithStops);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.includes("expected lattice.video-plan.v2")));

  const v2 = compileVideoPlan({
    deckId: "demo",
    routeId: "main",
    routes: { main: ["a"] },
    slides: [{ id: "a", durationFrames: 20, stops: [{ id: "a", frame: 0 }] }],
  });
  const bakedV2 = bakeVideoPlanProvenance(v2.plan, { deckHash: sha("d"), bundleHash: sha("b"), inputPropsHash: sha("i") });
  assert.equal(validateVideoPlan(bakedV2).ok, true);
});

test("plan hashes change with the stop schedule (same static plan hashes identically)", () => {
  const baked = (plan) => bakeVideoPlanProvenance(plan, { deckHash: sha("d"), bundleHash: sha("b"), inputPropsHash: sha("i") });
  const staticPlan = compileVideoPlan({ deckId: "demo", routeId: "main", routes: { main: ["a"] }, slides: [{ id: "a", durationFrames: 20 }] });
  const staticAgain = compileVideoPlan({ deckId: "demo", routeId: "main", routes: { main: ["a"] }, slides: [{ id: "a", durationFrames: 20 }] });
  assert.equal(hashVideoPlan(baked(staticPlan.plan)), hashVideoPlan(baked(staticAgain.plan)));

  const timed = compileVideoPlan({ deckId: "demo", routeId: "main", routes: { main: ["a"] }, slides: [{ id: "a", durationFrames: 20, stops: [{ id: "a", frame: 0 }] }] });
  assert.notEqual(hashVideoPlan(baked(staticPlan.plan)), hashVideoPlan(baked(timed.plan)));
  const retimed = compileVideoPlan({ deckId: "demo", routeId: "main", routes: { main: ["a"] }, slides: [{ id: "a", durationFrames: 20, stops: [{ id: "a", frame: 5 }] }] });
  assert.notEqual(hashVideoPlan(baked(timed.plan)), hashVideoPlan(baked(retimed.plan)));
});
