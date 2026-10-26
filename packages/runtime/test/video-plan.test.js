import assert from "node:assert/strict";
import { test } from "node:test";
import { createHash } from "node:crypto";
import {
  VIDEO_PLAN_SCHEMA,
  compileVideoPlan,
  validateVideoPlan,
  serializeVideoPlan,
  hashVideoPlan,
  validateRoute,
  bakeVideoPlanProvenance,
} from "../src/video-plan/index.js";

const sha256 = (label) => createHash("sha256").update(label).digest("hex");

// Deterministic, nonempty provenance for complete-plan fixtures in unit tests.
// The CLI derives these from real deck sources and real bundle identity; the
// unit tests only exercise the plan contract itself.
const validProvenance = () => ({
  deckHash: sha256("unit-fixture-deck"),
  bundleHash: sha256("unit-fixture-bundle"),
  inputPropsHash: sha256("unit-fixture-input-props"),
  toolchain: {},
});

const sampleSlides = [
  { id: "intro", title: "Intro", durationFrames: 60, inputProps: { opacity: 1.0 } },
  { id: "body", title: "Body", durationFrames: 90, inputProps: { zoom: 1 } },
  { id: "outro", title: "Outro", durationFrames: 30, inputProps: {} },
];

const sampleRoutes = {
  main: ["intro", "body", "outro"],
  short: ["intro", "outro"],
};

test("compileVideoPlan produces deterministic canonical plan", () => {
  const result1 = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: sampleRoutes,
    slides: sampleSlides,
  });
  const result2 = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: sampleRoutes,
    slides: sampleSlides,
  });

  assert.equal(result1.ok, true);
  assert.equal(result2.ok, true);
  assert.equal(serializeVideoPlan(result1.plan), serializeVideoPlan(result2.plan));
  assert.equal(hashVideoPlan(result1.plan), hashVideoPlan(result2.plan));
});

test("compileVideoPlan produces correct schema", () => {
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: sampleRoutes,
    slides: sampleSlides,
  });

  assert.equal(result.ok, true);
  assert.equal(result.plan.schema, VIDEO_PLAN_SCHEMA);
  assert.equal(result.plan.deckId, "test");
  assert.equal(result.plan.routeId, "main");
});

test("compileVideoPlan computes totalFrames correctly", () => {
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: sampleRoutes,
    slides: sampleSlides,
  });

  assert.equal(result.ok, true);
  assert.equal(result.plan.totalFrames, 180);
});

test("compileVideoPlan produces continuous non-overlapping clips", () => {
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: sampleRoutes,
    slides: sampleSlides,
  });

  assert.equal(result.ok, true);
  assert.equal(result.plan.clips.length, 3);

  assert.equal(result.plan.clips[0].slideId, "intro");
  assert.equal(result.plan.clips[0].startFrame, 0);
  assert.equal(result.plan.clips[0].durationFrames, 60);

  assert.equal(result.plan.clips[1].slideId, "body");
  assert.equal(result.plan.clips[1].startFrame, 60);
  assert.equal(result.plan.clips[1].durationFrames, 90);

  assert.equal(result.plan.clips[2].slideId, "outro");
  assert.equal(result.plan.clips[2].startFrame, 150);
  assert.equal(result.plan.clips[2].durationFrames, 30);

  assert.equal(result.plan.totalFrames, 150 + 30);
});

test("compileVideoPlan supports alternate routes", () => {
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "short",
    routes: sampleRoutes,
    slides: sampleSlides,
  });

  assert.equal(result.ok, true);
  assert.equal(result.plan.clips.length, 2);
  assert.equal(result.plan.totalFrames, 90);
  assert.equal(result.plan.routeId, "short");
});

test("compileVideoPlan fails for unknown route", () => {
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "nonexistent",
    routes: sampleRoutes,
    slides: sampleSlides,
  });

  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("unknown-or-empty-route"));
});

test("compileVideoPlan fails for empty route", () => {
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: { main: [] },
    slides: sampleSlides,
  });

  assert.equal(result.ok, false);
});

test("compileVideoPlan fails for slide not in deck", () => {
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: { main: ["intro", "ghost"] },
    slides: sampleSlides,
  });

  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("slide-not-found"));
});

test("compileVideoPlan fails for missing durationFrames", () => {
  const badSlides = [{ id: "a" }, { id: "b", durationFrames: 30 }];
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: { main: ["a", "b"] },
    slides: badSlides,
  });

  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("durationFrames"));
});

test("compileVideoPlan fails for zero durationFrames", () => {
  const badSlides = [{ id: "a", durationFrames: 0 }];
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: { main: ["a"] },
    slides: badSlides,
  });

  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("durationFrames"));
});

test("compileVideoPlan fails for negative durationFrames", () => {
  const badSlides = [{ id: "a", durationFrames: -10 }];
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: { main: ["a"] },
    slides: badSlides,
  });

  assert.equal(result.ok, false);
});

test("compileVideoPlan fails for float durationFrames", () => {
  const badSlides = [{ id: "a", durationFrames: 30.5 }];
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: { main: ["a"] },
    slides: badSlides,
  });

  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("integer"));
});

test("compileVideoPlan fails for duplicate slide definitions", () => {
  const badSlides = [
    { id: "a", durationFrames: 30 },
    { id: "a", durationFrames: 60 },
  ];
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: { main: ["a"] },
    slides: badSlides,
  });

  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("duplicate-slide-definition"));
});

test("compileVideoPlan fails for invalid slide id", () => {
  const badSlides = [{ id: "", durationFrames: 30 }];
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: { main: [""] },
    slides: badSlides,
  });

  assert.equal(result.ok, false);
});

test("compileVideoPlan fails for invalid width", () => {
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: sampleRoutes,
    slides: sampleSlides,
    width: 960.5,
  });
  assert.equal(result.ok, false);
});

test("compileVideoPlan fails for invalid fps", () => {
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: sampleRoutes,
    slides: sampleSlides,
    fps: 29.97,
  });
  assert.equal(result.ok, false);
});

test("compileVideoPlan fails for invalid deckId", () => {
  const result = compileVideoPlan({
    deckId: "",
    routeId: "main",
    routes: sampleRoutes,
    slides: sampleSlides,
  });
  assert.equal(result.ok, false);
});

test("compileVideoPlan rejects malformed route entries", () => {
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: { main: "not-an-array" },
    slides: sampleSlides,
  });
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("unknown-or-empty-route"));
});

test("compileVideoPlan fails for duplicate slideId in route", () => {
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: { main: ["intro", "intro", "body"] },
    slides: sampleSlides,
  });
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("duplicate-slideId-in-route"));
});

test("compileVideoPlan preserves clip inputProps", () => {
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: sampleRoutes,
    slides: sampleSlides,
    inputProps: { globalFade: true },
  });

  assert.equal(result.ok, true);
  assert.ok(result.plan.clips[0].inputProps);
  assert.equal(result.plan.clips[0].inputProps.globalFade, true);
  assert.ok(result.plan.clips[0].inputProps.opacity !== undefined);
});

test("compileVideoPlan fails for invalid audio tracks", () => {
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: sampleRoutes,
    slides: sampleSlides,
    audioTracks: [{ id: "", src: "test.mp3", startFrame: 0, durationFrames: 60 }],
  });
  assert.equal(result.ok, false);
});

test("compileVideoPlan rejects float audio frame values", () => {
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: sampleRoutes,
    slides: sampleSlides,
    audioTracks: [{ id: "track", src: "test.mp3", startFrame: 0, durationFrames: 60.5 }],
  });
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("integer"));
});

test("hashVideoPlan is stable for same plan", () => {
  const result1 = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: sampleRoutes,
    slides: sampleSlides,
  });
  const result2 = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: sampleRoutes,
    slides: sampleSlides,
  });

  assert.equal(hashVideoPlan(result1.plan), hashVideoPlan(result2.plan));
});

test("hashVideoPlan differs for different routes", () => {
  const result1 = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: sampleRoutes,
    slides: sampleSlides,
  });
  const result2 = compileVideoPlan({
    deckId: "test",
    routeId: "short",
    routes: sampleRoutes,
    slides: sampleSlides,
  });

  assert.notEqual(hashVideoPlan(result1.plan), hashVideoPlan(result2.plan));
});

test("hashVideoPlan differs when inputProps change", () => {
  const result1 = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: sampleRoutes,
    slides: sampleSlides,
    inputProps: { a: 1 },
  });
  const result2 = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: sampleRoutes,
    slides: sampleSlides,
    inputProps: { a: 2 },
  });

  assert.notEqual(hashVideoPlan(result1.plan), hashVideoPlan(result2.plan));
});

test("hashVideoPlan differs when provenance changes", () => {
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: sampleRoutes,
    slides: sampleSlides,
  });

  const plan1 = bakeVideoPlanProvenance(result.plan, {
    deckHash: sha256("deck-a"),
    bundleHash: sha256("bundle"),
    inputPropsHash: sha256("input-props"),
  });
  const plan2 = bakeVideoPlanProvenance(result.plan, {
    deckHash: sha256("deck-b"),
    bundleHash: sha256("bundle"),
    inputPropsHash: sha256("input-props"),
  });

  assert.notEqual(hashVideoPlan(plan1), hashVideoPlan(plan2));
});

test("bakeVideoPlanProvenance does not mutate original plan", () => {
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: sampleRoutes,
    slides: sampleSlides,
  });

  const originalHash = hashVideoPlan(result.plan);
  const originalDeckHash = result.plan.provenance.deckHash;
  bakeVideoPlanProvenance(result.plan, {
    deckHash: sha256("deck"),
    bundleHash: sha256("bundle"),
    inputPropsHash: sha256("input-props"),
  });
  assert.equal(result.plan.provenance.deckHash, originalDeckHash);
  assert.equal(hashVideoPlan(result.plan), originalHash);
});

test("bakeVideoPlanProvenance rejects empty provided values", () => {
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: sampleRoutes,
    slides: sampleSlides,
  });
  assert.throws(
    () => bakeVideoPlanProvenance(result.plan, { deckHash: "", bundleHash: sha256("b"), inputPropsHash: sha256("i") }),
    /deckHash must be a nonempty string/,
  );
  assert.throws(
    () => bakeVideoPlanProvenance(result.plan, { deckHash: sha256("d"), bundleHash: "", inputPropsHash: sha256("i") }),
    /bundleHash must be a nonempty string/,
  );
});

test("bakeVideoPlanProvenance rejects incomplete provenance", () => {
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: sampleRoutes,
    slides: sampleSlides,
  });
  assert.throws(
    () => bakeVideoPlanProvenance(result.plan, { deckHash: sha256("d") }),
    /provenance\.bundleHash must be a nonempty string/,
    "baking without a real bundle hash must fail instead of producing an invalid plan",
  );
});

test("baked plan round-trips through validateVideoPlan", () => {
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: sampleRoutes,
    slides: sampleSlides,
  });
  const baked = bakeVideoPlanProvenance(result.plan, {
    deckHash: sha256("d"),
    bundleHash: sha256("b"),
    inputPropsHash: sha256("i"),
  });
  assert.equal(validateVideoPlan(baked).ok, true);
});

test("validateVideoPlan accepts a complete plan (nonempty provenance)", () => {
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: sampleRoutes,
    slides: sampleSlides,
  });
  const completePlan = bakeVideoPlanProvenance(result.plan, {
    deckHash: sha256("deck-source"),
    bundleHash: sha256("bundle"),
    inputPropsHash: sha256("input-props"),
  });
  const validation = validateVideoPlan(completePlan);
  assert.equal(validation.ok, true, validation.errors ? validation.errors.join("; ") : "");
});

test("validateVideoPlan rejects unbaked (empty) provenance", () => {
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: sampleRoutes,
    slides: sampleSlides,
  });
  const validation = validateVideoPlan(result.plan);
  assert.equal(validation.ok, false, "a plan with empty provenance is incomplete and must be rejected");
  assert.ok(validation.errors.some((e) => e.includes("provenance.deckHash")));
  assert.ok(validation.errors.some((e) => e.includes("provenance.bundleHash")));
  assert.ok(validation.errors.some((e) => e.includes("provenance.inputPropsHash")));
});

for (const key of ["deckHash", "bundleHash", "inputPropsHash"]) {
  test(`validateVideoPlan rejects empty provenance.${key}`, () => {
    const plan = {
      schema: VIDEO_PLAN_SCHEMA,
      deckId: "test",
      routeId: "main",
      width: 960,
      height: 540,
      fps: 30,
      totalFrames: 30,
      clips: [{ slideId: "a", startFrame: 0, durationFrames: 30, source: "slide:a", inputProps: {} }],
      audioTracks: [],
      provenance: validProvenance(),
    };
    plan.provenance[key] = "";
    const v = validateVideoPlan(plan);
    assert.equal(v.ok, false, `empty provenance.${key} must be rejected`);
    assert.ok(v.errors.some((e) => e.includes(key)));
  });
}

test("validateVideoPlan rejects plan with gaps", () => {
  const badPlan = {
    schema: VIDEO_PLAN_SCHEMA,
    deckId: "test",
    routeId: "main",
    width: 960,
    height: 540,
    fps: 30,
    totalFrames: 100,
    clips: [
      { slideId: "a", startFrame: 0, durationFrames: 50, source: "slide:a", inputProps: {} },
      { slideId: "b", startFrame: 60, durationFrames: 40, source: "slide:b", inputProps: {} },
    ],
    audioTracks: [],
    provenance: validProvenance(),
  };
  const validation = validateVideoPlan(badPlan);
  assert.equal(validation.ok, false);
});

test("validateVideoPlan rejects non-integer totalFrames", () => {
  const plan = {
    schema: VIDEO_PLAN_SCHEMA,
    deckId: "test",
    routeId: "main",
    width: 960,
    height: 540,
    fps: 30,
    totalFrames: "100",
    clips: [],
    audioTracks: [],
    provenance: validProvenance(),
  };
  const validation = validateVideoPlan(plan);
  assert.equal(validation.ok, false);
});

test("validateVideoPlan rejects empty clips", () => {
  const plan = {
    schema: VIDEO_PLAN_SCHEMA,
    deckId: "test",
    routeId: "main",
    width: 960,
    height: 540,
    fps: 30,
    totalFrames: 0,
    clips: [],
    audioTracks: [],
    provenance: validProvenance(),
  };
  const validation = validateVideoPlan(plan);
  assert.equal(validation.ok, false);
});

test("validateVideoPlan rejects invalid clip fields", () => {
  const plan = {
    schema: VIDEO_PLAN_SCHEMA,
    deckId: "test",
    routeId: "main",
    width: 960,
    height: 540,
    fps: 30,
    totalFrames: 30,
    clips: [{ slideId: "", startFrame: 0, durationFrames: 30, source: "", inputProps: {} }],
    audioTracks: [],
    provenance: validProvenance(),
  };
  const validation = validateVideoPlan(plan);
  assert.equal(validation.ok, false);
});

test("validateVideoPlan rejects duplicate slideId in clips", () => {
  const plan = {
    schema: VIDEO_PLAN_SCHEMA,
    deckId: "test",
    routeId: "main",
    width: 960,
    height: 540,
    fps: 30,
    totalFrames: 60,
    clips: [
      { slideId: "a", startFrame: 0, durationFrames: 30, source: "slide:a", inputProps: {} },
      { slideId: "a", startFrame: 30, durationFrames: 30, source: "slide:a", inputProps: {} },
    ],
    audioTracks: [],
    provenance: validProvenance(),
  };
  const validation = validateVideoPlan(plan);
  assert.equal(validation.ok, false);
});

test("validateVideoPlan rejects missing provenance", () => {
  const plan = {
    schema: VIDEO_PLAN_SCHEMA,
    deckId: "test",
    routeId: "main",
    width: 960,
    height: 540,
    fps: 30,
    totalFrames: 30,
    clips: [{ slideId: "a", startFrame: 0, durationFrames: 30, source: "slide:a", inputProps: {} }],
    audioTracks: [],
  };
  const validation = validateVideoPlan(plan);
  assert.equal(validation.ok, false);
});

test("validateVideoPlan rejects invalid audio tracks", () => {
  const plan = {
    schema: VIDEO_PLAN_SCHEMA,
    deckId: "test",
    routeId: "main",
    width: 960,
    height: 540,
    fps: 30,
    totalFrames: 30,
    clips: [{ slideId: "a", startFrame: 0, durationFrames: 30, source: "slide:a", inputProps: {} }],
    audioTracks: [{ id: "", src: "", startFrame: -1, durationFrames: 0 }],
    provenance: validProvenance(),
  };
  const validation = validateVideoPlan(plan);
  assert.equal(validation.ok, false);
});

test("validateRoute rejects duplicate slide definitions", () => {
  const slides = [
    { id: "a" },
    { id: "b" },
    { id: "a" },
  ];
  const result = validateRoute(slides, ["a"]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "duplicate-slide-definition");
});

test("validateRoute rejects invalid slide id", () => {
  const slides = [{ id: "" }];
  const result = validateRoute(slides, [""]);
  assert.equal(result.ok, false);
});

test("serializeVideoPlan preserves all nested clip data in round-trip", () => {
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: sampleRoutes,
    slides: sampleSlides,
    inputProps: { globalKey: "value" },
  });
  assert.equal(result.ok, true);

  const json = serializeVideoPlan(result.plan);
  const parsed = JSON.parse(json);

  assert.equal(parsed.schema, VIDEO_PLAN_SCHEMA);
  assert.equal(parsed.deckId, "test");
  assert.equal(parsed.clips.length, 3);
  assert.ok(parsed.provenance);

  for (let i = 0; i < parsed.clips.length; i++) {
    const c = parsed.clips[i];
    assert.equal(typeof c.slideId, "string");
    assert.equal(typeof c.startFrame, "number");
    assert.ok(Number.isInteger(c.startFrame));
    assert.equal(typeof c.durationFrames, "number");
    assert.ok(Number.isInteger(c.durationFrames));
    assert.equal(typeof c.source, "string");
    assert.equal(typeof c.inputProps, "object");
    assert.ok(c.inputProps !== undefined);
  }

  assert.equal(typeof parsed.provenance.deckHash, "string");
  assert.equal(typeof parsed.provenance.bundleHash, "string");
  assert.equal(typeof parsed.provenance.inputPropsHash, "string");
  assert.equal(typeof parsed.provenance.toolchain, "object");
});

test("serializeVideoPlan produces diff when clip data changes", () => {
  const result1 = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: sampleRoutes,
    slides: sampleSlides,
  });
  const result2 = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: sampleRoutes,
    slides: sampleSlides,
    inputProps: { different: true },
  });

  assert.notEqual(serializeVideoPlan(result1.plan), serializeVideoPlan(result2.plan));
});

test("VideoPlan has no backend imports", () => {
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: sampleRoutes,
    slides: sampleSlides,
  });

  const json = serializeVideoPlan(result.plan);
  assert.ok(!json.includes("remotion"));
  assert.ok(!json.includes("hyperframes"));
});

test("VideoPlan clips have integer frame values", () => {
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: sampleRoutes,
    slides: sampleSlides,
  });

  for (const clip of result.plan.clips) {
    assert.ok(Number.isInteger(clip.startFrame));
    assert.ok(Number.isInteger(clip.durationFrames));
    assert.ok(clip.startFrame >= 0);
    assert.ok(clip.durationFrames > 0);
  }
  assert.ok(Number.isInteger(result.plan.totalFrames));
});

test("validateRoute accepts valid route", () => {
  const result = validateRoute(sampleSlides, ["intro", "body", "outro"]);
  assert.equal(result.ok, true);
});

test("validateRoute rejects empty route", () => {
  const result = validateRoute(sampleSlides, []);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "empty-or-invalid-route");
});

test("validateRoute rejects unknown slideId", () => {
  const result = validateRoute(sampleSlides, ["intro", "nonexistent"]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "unknown-slideId-in-route");
});

test("validateRoute rejects duplicate slideId", () => {
  const result = validateRoute(sampleSlides, ["intro", "intro"]);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "duplicate-slideId-in-route");
});

test("serializeVideoPlan rejects non-JSON-safe values (function)", () => {
  assert.throws(() => {
    const plan = {
      schema: VIDEO_PLAN_SCHEMA,
      deckId: "test",
      routeId: "main",
      width: 960,
      height: 540,
      fps: 30,
      totalFrames: 30,
      clips: [{ slideId: "a", startFrame: 0, durationFrames: 30, source: "slide:a", inputProps: {} }],
      audioTracks: [],
      provenance: { deckHash: "abc", bundleHash: "def", inputPropsHash: "ghi", toolchain: {} },
      fn: () => {},
    };
    serializeVideoPlan(plan);
  }, /non-JSON-safe|Cannot serialize/);
});

test("serializeVideoPlan rejects NaN value", () => {
  assert.throws(() => {
    const plan = {
      schema: VIDEO_PLAN_SCHEMA,
      deckId: "test",
      routeId: "main",
      width: NaN,
      height: 540,
      fps: 30,
      totalFrames: 30,
      clips: [{ slideId: "a", startFrame: 0, durationFrames: 30, source: "slide:a", inputProps: {} }],
      audioTracks: [],
      provenance: { deckHash: "abc", bundleHash: "def", inputPropsHash: "ghi", toolchain: {} },
    };
    serializeVideoPlan(plan);
  }, /Cannot serialize|non-finite/);
});

test("serializeVideoPlan rejects Infinity", () => {
  assert.throws(() => {
    const plan = {
      schema: VIDEO_PLAN_SCHEMA,
      deckId: "test",
      routeId: "main",
      width: Infinity,
      height: 540,
      fps: 30,
      totalFrames: 30,
      clips: [{ slideId: "a", startFrame: 0, durationFrames: 30, source: "slide:a", inputProps: {} }],
      audioTracks: [],
      provenance: { deckHash: "abc", bundleHash: "def", inputPropsHash: "ghi", toolchain: {} },
    };
    serializeVideoPlan(plan);
  }, /Cannot serialize|non-finite/);
});

test("serializeVideoPlan rejects cyclic reference", () => {
  assert.throws(() => {
    const plan = {
      schema: VIDEO_PLAN_SCHEMA,
      deckId: "test",
      routeId: "main",
      width: 960,
      height: 540,
      fps: 30,
      totalFrames: 30,
      clips: [{ slideId: "a", startFrame: 0, durationFrames: 30, source: "slide:a", inputProps: {} }],
      audioTracks: [],
      provenance: { deckHash: "abc", bundleHash: "def", inputPropsHash: "ghi", toolchain: {} },
    };
    plan.self = plan;
    serializeVideoPlan(plan);
  }, /Cannot serialize|non-plain/);
});

test("compileVideoPlan rejects non-JSON-safe global inputProps (symbol)", () => {
  const slides = [{ id: "a", durationFrames: 30 }];
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: { main: ["a"] },
    slides,
    inputProps: { s: Symbol("test") },
  });
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("symbol") || result.reason.includes("non-JSON-safe") || result.reason.includes("inputProps"));
});

test("compileVideoPlan rejects non-JSON-safe per-clip inputProps (bigint)", () => {
  const slides = [{ id: "a", durationFrames: 30, inputProps: { big: 123n } }];
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: { main: ["a"] },
    slides,
  });
  assert.equal(result.ok, false);
});

test("compileVideoPlan rejects non-finite volume", () => {
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: { main: ["a"] },
    slides: [{ id: "a", durationFrames: 30 }],
    audioTracks: [{ id: "t", src: "x.mp3", startFrame: 0, volume: Infinity }],
  });
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("volume"));
});

test("compileVideoPlan rejects negative volume", () => {
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: { main: ["a"] },
    slides: [{ id: "a", durationFrames: 30 }],
    audioTracks: [{ id: "t", src: "x.mp3", startFrame: 0, volume: -1 }],
  });
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("volume"));
});

test("compileVideoPlan audioTracks: durationFrames optional when absent", () => {
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: { main: ["a"] },
    slides: [{ id: "a", durationFrames: 30 }],
    audioTracks: [{ id: "t", src: "x.mp3", startFrame: 0 }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.audioTracks[0].durationFrames, undefined);
});

test("compileVideoPlan audioTracks: durationFrames present and valid", () => {
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: { main: ["a"] },
    slides: [{ id: "a", durationFrames: 30 }],
    audioTracks: [{ id: "t", src: "x.mp3", startFrame: 0, durationFrames: 60 }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.plan.audioTracks[0].durationFrames, 60);
});

test("validateVideoPlan accepts optional audio durationFrames absent", () => {
  const plan = {
    schema: VIDEO_PLAN_SCHEMA,
    deckId: "test",
    routeId: "main",
    width: 960,
    height: 540,
    fps: 30,
    totalFrames: 30,
    clips: [{ slideId: "a", startFrame: 0, durationFrames: 30, source: "slide:a", inputProps: {} }],
    audioTracks: [{ id: "t", src: "x.mp3", startFrame: 0 }],
    provenance: { deckHash: "abc", bundleHash: "def", inputPropsHash: "ghi", toolchain: {} },
  };
  const v = validateVideoPlan(plan);
  assert.equal(v.ok, true, v.errors ? v.errors.join("; ") : "");
});

test("serializeVideoPlan round-trips plan preserving all audio, provenance, and clip fields", () => {
  const slides = [{ id: "a", durationFrames: 60, inputProps: { custom: "value" } }];
  const result = compileVideoPlan({
    deckId: "full",
    routeId: "main",
    routes: { main: ["a"] },
    slides,
    audioTracks: [{ id: "bgm", src: "music.mp3", startFrame: 0, volume: 0.75 }],
    inputProps: { globalFade: true },
  });
  assert.equal(result.ok, true);

  const baked = bakeVideoPlanProvenance(result.plan, {
    deckHash: sha256("full-deck"),
    bundleHash: sha256("full-bundle"),
    inputPropsHash: sha256("full-input-props"),
  });
  const json = serializeVideoPlan(baked);
  const parsed = JSON.parse(json);

  assert.equal(parsed.deckId, "full");
  assert.equal(parsed.clips[0].inputProps.custom, "value");
  assert.equal(parsed.clips[0].inputProps.globalFade, true);
  assert.equal(parsed.audioTracks[0].id, "bgm");
  assert.equal(parsed.audioTracks[0].volume, 0.75);
  assert.equal(parsed.audioTracks[0].durationFrames, undefined);
  assert.equal(parsed.provenance.deckHash, sha256("full-deck"));
  assert.equal(typeof parsed.provenance.toolchain, "object");
});

test("serializeVideoPlan allows shared non-cyclic object references", () => {
  const shared = { fade: true, volume: 0.5 };
  const plan = {
    schema: VIDEO_PLAN_SCHEMA,
    deckId: "shared",
    routeId: "main",
    width: 960,
    height: 540,
    fps: 30,
    totalFrames: 30,
    clips: [{ slideId: "a", startFrame: 0, durationFrames: 30, source: "slide:a", inputProps: {} }],
    audioTracks: [],
    provenance: validProvenance(),
    inputProps: { first: shared, second: shared },
  };
  const json = serializeVideoPlan(plan);
  const parsed = JSON.parse(json);
  assert.deepEqual(parsed.inputProps.first, { fade: true, volume: 0.5 });
  assert.deepEqual(parsed.inputProps.second, { fade: true, volume: 0.5 });
});

test("compileVideoPlan allows shared non-cyclic inputProps references", () => {
  const shared = { tint: "blue" };
  const slides = [
    { id: "a", durationFrames: 30, inputProps: shared },
    { id: "b", durationFrames: 30, inputProps: shared },
  ];
  const result = compileVideoPlan({
    deckId: "shared",
    routeId: "main",
    routes: { main: ["a", "b"] },
    slides,
  });
  assert.equal(result.ok, true, `shared references must be allowed: ${result.reason || ""}`);
});

test("serializeVideoPlan rejects ancestor cycles even through arrays", () => {
  const nested = { items: [] };
  nested.items.push(nested);
  assert.throws(() => serializeVideoPlan({ a: nested }), /cyclic/);
});

test("compileVideoPlan rejects cyclic inputProps", () => {
  const cyclic = { self: null };
  cyclic.self = cyclic;
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: { main: ["a"] },
    slides: [{ id: "a", durationFrames: 30 }],
    inputProps: cyclic,
  });
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("cyclic"));
});

test("serializeVideoPlan rejects sparse arrays", () => {
  const sparse = [];
  sparse[2] = "x";
  assert.throws(() => serializeVideoPlan({ list: sparse }), /sparse/);
});

test("compileVideoPlan rejects sparse inputProps arrays", () => {
  const sparse = [];
  sparse[1] = "x";
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: { main: ["a"] },
    slides: [{ id: "a", durationFrames: 30 }],
    inputProps: { list: sparse },
  });
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("sparse"));
});

test("serializeVideoPlan allows the same empty array referenced twice", () => {
  const empty = [];
  const plan = {
    schema: VIDEO_PLAN_SCHEMA,
    deckId: "empty-shared",
    routeId: "main",
    width: 960,
    height: 540,
    fps: 30,
    totalFrames: 30,
    clips: [{ slideId: "a", startFrame: 0, durationFrames: 30, source: "slide:a", inputProps: {} }],
    audioTracks: empty,
    extras: empty,
    provenance: validProvenance(),
  };
  const json = serializeVideoPlan(plan);
  assert.ok(json.includes('"extras": []'));
});

test("serializeVideoPlan rejects symbol-keyed properties", () => {
  const plan = { a: 1 };
  plan[Symbol("hidden")] = "leak";
  assert.throws(() => serializeVideoPlan(plan), /symbol/);
});

test("serializeVideoPlan rejects symbol-keyed arrays", () => {
  const arr = [1, 2];
  arr[Symbol("hidden")] = "leak";
  assert.throws(() => serializeVideoPlan({ list: arr }), /symbol-keyed/);
});

test("serializeVideoPlan rejects custom-prototype arrays instead of throwing raw value.map errors", () => {
  assert.throws(
    () => serializeVideoPlan({ list: Object.setPrototypeOf([1], {}) }),
    /Cannot serialize non-plain array/,
  );
});


test("compileVideoPlan rejects unsupported prototypes in inputProps", () => {
  class Custom {}
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: { main: ["a"] },
    slides: [{ id: "a", durationFrames: 30 }],
    inputProps: { thing: new Custom() },
  });
  assert.equal(result.ok, false);
  assert.ok(result.reason.includes("prototype") || result.reason.includes("unsupported"));
});

function completePlanWithClips(clips) {
  return {
    schema: VIDEO_PLAN_SCHEMA,
    deckId: "test",
    routeId: "main",
    width: 960,
    height: 540,
    fps: 30,
    totalFrames: 30,
    clips,
    audioTracks: [],
    provenance: validProvenance(),
  };
}

const singleClipPlan = (inputProps) =>
  completePlanWithClips([
    { slideId: "a", startFrame: 0, durationFrames: 30, source: "slide:a", inputProps },
  ]);

test("validateVideoPlan accepts shared non-cyclic references across clip inputProps", () => {
  const shared = { tint: "blue", levels: [1, 2, 3] };
  const plan = completePlanWithClips([
    { slideId: "a", startFrame: 0, durationFrames: 15, source: "slide:a", inputProps: shared },
    { slideId: "b", startFrame: 15, durationFrames: 15, source: "slide:b", inputProps: { first: shared, second: shared } },
  ]);
  const v = validateVideoPlan(plan);
  assert.equal(v.ok, true, v.errors ? v.errors.join("; ") : "");
  assert.doesNotThrow(() => hashVideoPlan(plan), "a plan accepted by validateVideoPlan must serialize/hash safely");
});

test("validateVideoPlan accepts JSON-safe nested clip inputProps", () => {
  const plan = singleClipPlan({ outer: { inner: { deep: [1, "x", true, null] } }, flag: false });
  const v = validateVideoPlan(plan);
  assert.equal(v.ok, true, v.errors ? v.errors.join("; ") : "");
});

test("validateVideoPlan requires clip inputProps to be a JSON-safe object", () => {
  const missing = completePlanWithClips([{ slideId: "a", startFrame: 0, durationFrames: 30, source: "slide:a" }]);
  const missingV = validateVideoPlan(missing);
  assert.equal(missingV.ok, false);
  assert.ok(missingV.errors.some((e) => e.includes("clips[0].inputProps must be a JSON-safe object")));

  const nullProps = singleClipPlan(null);
  const nullV = validateVideoPlan(nullProps);
  assert.equal(nullV.ok, false);
  assert.ok(nullV.errors.some((e) => e.includes("clips[0].inputProps must be a JSON-safe object, got null")));

  const explicitUndefined = singleClipPlan(undefined);
  const undefV = validateVideoPlan(explicitUndefined);
  assert.equal(undefV.ok, false);
  assert.ok(undefV.errors.some((e) => e.includes("clips[0].inputProps must be a JSON-safe object")));
});

const unsafeClipInputPropsCases = [
  ["undefined", () => ({ bad: undefined }), /non-JSON-safe undefined/],
  ["function", () => ({ bad: () => {} }), /non-JSON-safe function/],
  ["symbol", () => ({ bad: Symbol("leak") }), /non-JSON-safe symbol/],
  ["bigint", () => ({ bad: 123n }), /non-JSON-safe bigint/],
  ["NaN", () => ({ bad: NaN }), /NaN/],
  ["Infinity", () => ({ bad: Infinity }), /Infinity/],
  ["-Infinity", () => ({ bad: -Infinity }), /-Infinity/],
  ["sparse array", () => { const arr = []; arr[2] = "x"; return { list: arr }; }, /sparse array/],
  ["ancestor cycle", () => { const c = { self: null }; c.self = c; return c; }, /cyclic/],
  ["symbol-keyed property", () => { const o = { a: 1 }; o[Symbol("hidden")] = "leak"; return o; }, /symbol-keyed/],
  ["unsupported prototype", () => ({ bad: new (class Custom {})() }), /unsupported prototype/],
  ["symbol-keyed array", () => { const arr = [1, 2]; arr[Symbol("hidden")] = "leak"; return { list: arr }; }, /symbol-keyed/],
  ["custom-prototype array", () => ({ list: Object.setPrototypeOf([1], {}) }), /unsupported prototype/],
];

for (const [label, makeProps, pattern] of unsafeClipInputPropsCases) {
  test(`validateVideoPlan rejects unsafe clip inputProps (${label})`, () => {
    const plan = singleClipPlan(makeProps());
    const v = validateVideoPlan(plan);
    assert.equal(v.ok, false, `${label} in clips[0].inputProps must be rejected`);
    const matched = v.errors.find((e) => e.startsWith("clips[0].inputProps"));
    assert.ok(matched, `error must name the clip inputProps location, got: ${v.errors.join("; ")}`);
    assert.match(matched, pattern);
  });
}

test("validateVideoPlan reports the precise path for unsafe clip inputProps", () => {
  const plan = singleClipPlan({ outer: { inner: NaN } });
  const v = validateVideoPlan(plan);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("$.clips[0].inputProps.outer.inner")), v.errors.join("; "));
});

test("validateVideoPlan rejects array clip inputProps as an invalid inputProps Record", () => {
  const plan = singleClipPlan([]);
  const v = validateVideoPlan(plan);
  assert.equal(v.ok, false, "array clip inputProps must be rejected; the contract is Record<string, unknown>");
  const matched = v.errors.find((e) => e.startsWith("clips[0].inputProps"));
  assert.ok(matched, `error must name the clip inputProps location, got: ${v.errors.join("; ")}`);
  assert.match(matched, /got array/);
});

test("validateVideoPlan accepts ordinary dense arrays and shared references and hashes safely", () => {
  const shared = { levels: [1, 2, 3], tags: ["a", "b"] };
  const plan = singleClipPlan({ list: [shared, [1, "x", true, null]], shared });
  plan.extras = { matrix: [[1, 2], [3, 4]], shared };
  const v = validateVideoPlan(plan);
  assert.equal(v.ok, true, v.errors ? v.errors.join("; ") : "");
  assert.doesNotThrow(() => hashVideoPlan(plan), "a plan accepted by validateVideoPlan must serialize/hash safely");
});

test("validateVideoPlan reports the precise clip index for unsafe clip inputProps", () => {
  const plan = completePlanWithClips([
    { slideId: "a", startFrame: 0, durationFrames: 15, source: "slide:a", inputProps: {} },
    { slideId: "b", startFrame: 15, durationFrames: 15, source: "slide:b", inputProps: { bad: () => {} } },
  ]);
  const v = validateVideoPlan(plan);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.startsWith("clips[1].inputProps")), v.errors.join("; "));
  assert.ok(!v.errors.some((e) => e.startsWith("clips[0].inputProps")), v.errors.join("; "));
});

test("validateVideoPlan rejects clip inputProps cycles that reach the enclosing clip", () => {
  const plan = singleClipPlan({});
  plan.clips[0].inputProps.self = plan.clips[0];
  const v = validateVideoPlan(plan);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => e.includes("cyclic")), v.errors.join("; "));
  assert.doesNotThrow(() => validateVideoPlan(plan), "cycle detection must terminate");
});

const unsafeNonClipPlanLocations = [
  ["provenance.toolchain function value", (plan) => { plan.provenance.toolchain.node = () => {}; }, /provenance\.toolchain/],
  ["provenance.toolchain non-string value", (plan) => { plan.provenance.toolchain.node = 42; }, /provenance\.toolchain\.node must be a string/],
  ["provenance.toolchain array", (plan) => { plan.provenance.toolchain = ["node-22"]; }, /provenance\.toolchain must be/],
  ["provenance array", (plan) => { plan.provenance = ["hash"]; }, /provenance/],
  ["extra plan property set to undefined", (plan) => { plan.extra = undefined; }, /\.extra/],
  ["extra plan property set to a function", (plan) => { plan.extra = () => {}; }, /\.extra/],
  ["bigint on a clip", (plan) => { plan.clips[0].weight = 10n; }, /clips\[0\]\.weight/],
  ["NaN on an audio track", (plan) => { plan.audioTracks.push({ id: "t", src: "x.mp3", startFrame: 0, meta: NaN }); }, /audioTracks\[0\]\.meta/],
  ["symbol value on an audio track", (plan) => { plan.audioTracks.push({ id: "t", src: "x.mp3", startFrame: 0, meta: Symbol("leak") }); }, /audioTracks\[0\]\.meta/],
  ["symbol-keyed property on the plan", (plan) => { plan[Symbol("hidden")] = "leak"; }, /symbol-keyed/],
  ["sparse array outside inputProps", (plan) => { const arr = []; arr[2] = "x"; plan.list = arr; }, /sparse array at \$\.list/],
  ["unsupported prototype outside inputProps", (plan) => { plan.thing = new (class Custom {})(); }, /unsupported prototype at \$\.thing/],
  ["symbol-keyed array outside inputProps", (plan) => { const arr = [1, 2]; arr[Symbol("hidden")] = "leak"; plan.list = arr; }, /symbol-keyed property at \$\.list/],
  ["custom-prototype array outside inputProps", (plan) => { plan.list = Object.setPrototypeOf([1], {}); }, /unsupported prototype at \$\.list/],
  ["ancestor cycle outside inputProps", (plan) => { plan.self = plan; }, /cyclic/],
  ["Infinity outside inputProps", (plan) => { plan.inf = Infinity; }, /Infinity at \$\.inf/],
];

for (const [label, mutate, pattern] of unsafeNonClipPlanLocations) {
  test(`validateVideoPlan rejects unsafe non-clip plan values (${label})`, () => {
    const plan = singleClipPlan({});
    mutate(plan);
    const v = validateVideoPlan(plan);
    assert.equal(v.ok, false, `${label} anywhere in the plan must be rejected`);
    assert.ok(
      v.errors.some((e) => pattern.test(e)),
      `error must name the unsafe value location (${label}), got: ${v.errors.join("; ")}`,
    );
    assert.doesNotThrow(() => validateVideoPlan(plan), "validation must terminate");
  });
}

test("validateVideoPlan rejects plans whose non-clip values serializeVideoPlan cannot handle", () => {
  const plan = singleClipPlan({});
  plan.provenance.toolchain.node = () => {};
  assert.throws(() => serializeVideoPlan(plan), /non-JSON-safe function/);
  const v = validateVideoPlan(plan);
  assert.equal(v.ok, false, "validation must reject before serialization is ever attempted");
});

test("validateVideoPlan accepts shared non-cyclic references outside clip inputProps", () => {
  const shared = { tint: "blue", levels: [1, 2] };
  const plan = singleClipPlan({});
  plan.extras = { a: shared, b: shared, list: [shared, shared] };
  const v = validateVideoPlan(plan);
  assert.equal(v.ok, true, v.errors ? v.errors.join("; ") : "");
  assert.doesNotThrow(() => hashVideoPlan(plan));
});

test("validateVideoPlan accepts a JSON-safe toolchain record", () => {
  const plan = singleClipPlan({});
  plan.provenance.toolchain = { node: "v22.0.0", "lattice-runtime": "0.2.0" };
  const v = validateVideoPlan(plan);
  assert.equal(v.ok, true, v.errors ? v.errors.join("; ") : "");
});

const malformedContainerCases = [
  ["routes: null", { routes: null }, /routes/],
  ["routes: array", { routes: [] }, /routes/],
  ["routes: string", { routes: "main" }, /routes/],
  ["slides: null", { slides: null }, /slides/],
  ["slides: object", { slides: { id: "a" } }, /slides/],
  ["slides: string", { slides: "a" }, /slides/],
  ["audioTracks: null", { audioTracks: null }, /audioTracks/],
  ["audioTracks: plain object", { audioTracks: { id: "t" } }, /audioTracks/],
  ["audioTracks: string", { audioTracks: "t" }, /audioTracks/],
  ["inputProps: null", { inputProps: null }, /inputProps/],
  ["inputProps: number", { inputProps: 5 }, /inputProps/],
  ["inputProps: string", { inputProps: "fade" }, /inputProps/],
  ["inputProps: array", { inputProps: [1, 2] }, /inputProps/],
];

for (const [label, overrides, pattern] of malformedContainerCases) {
  test(`compileVideoPlan rejects malformed container (${label}) without throwing`, () => {
    let result;
    assert.doesNotThrow(() => {
      result = compileVideoPlan({
        deckId: "test",
        routeId: "main",
        routes: { main: ["a"] },
        slides: [{ id: "a", durationFrames: 30 }],
        ...overrides,
      });
    }, `${label} must produce {ok:false}, never a raw TypeError`);
    assert.equal(result.ok, false, `${label} must be rejected, not silently coerced`);
    assert.ok(pattern.test(result.reason), `reason must name the container (${label}), got: ${result.reason}`);
  });
}

const malformedSlideInputPropsCases = [
  ["null", null],
  ["number", 5],
  ["string", "fade"],
  ["boolean", true],
  ["array", [1]],
];

for (const [label, bad] of malformedSlideInputPropsCases) {
  test(`compileVideoPlan rejects non-object slide inputProps container (${label})`, () => {
    let result;
    assert.doesNotThrow(() => {
      result = compileVideoPlan({
        deckId: "test",
        routeId: "main",
        routes: { main: ["a"] },
        slides: [{ id: "a", durationFrames: 30, inputProps: bad }],
      });
    }, `slide inputProps ${label} must produce {ok:false}, never a raw TypeError`);
    assert.equal(result.ok, false, `slide inputProps ${label} must be rejected, not silently spread`);
    assert.ok(result.reason.includes("inputProps"), `reason must name inputProps, got: ${result.reason}`);
  });
}

test("compileVideoPlan preserves defaults for omitted fields and undefined containers", () => {
  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: { main: ["a"] },
    slides: [{ id: "a", durationFrames: 30, inputProps: undefined }],
    audioTracks: undefined,
    inputProps: undefined,
  });
  assert.equal(result.ok, true, result.reason || "omitted containers must keep their defaults");
  assert.deepEqual(result.plan.clips[0].inputProps, {});
  assert.deepEqual(result.plan.audioTracks, []);
});
