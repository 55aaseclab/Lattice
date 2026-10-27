import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import {
  TIMELINE_DEFAULT_RHYTHM,
  TIMELINE_SCHEMA,
  collectRevealMarkerIds,
  deriveStopFrames,
  resolveTimeline,
  validateTimelineDeclaration,
} from "../src/timeline/index.js";
import { validateDeckManifestV2 } from "../src/deck-v2/index.js";
import {
  STOP_REVEAL_PRESET_CATALOG,
  validateStopRevealAnimation,
} from "../themes/simple-light/presets.js";

const TIMELINE = {
  schema: TIMELINE_SCHEMA,
  rhythm: { first: 6, dwell: 20 },
  defaults: { animation: { preset: "fade", durationFrames: 8 } },
  slides: {
    intro: {
      durationFrames: 90,
      stops: { open: { frame: 0 }, point: { frame: 46 } },
      animation: { preset: "rise", direction: "up", durationFrames: 12, stagger: 3, distancePx: 24 },
    },
  },
  audioTracks: [{ id: "bgm", src: "./assets/audio/tone.wav", startFrame: 0, volume: 0.8 }],
};

function deckSlides() {
  return [
    {
      id: "intro",
      html: '<section><h1 data-lattice-reveal="open">A</h1><p data-lattice-reveal="point">B</p></section>',
      durationFrames: 90,
      stops: [{ id: "open", frame: 0 }, { id: "point", frame: 1 }],
    },
    {
      id: "outro",
      html: "<section>static</section>",
      durationFrames: 1,
      stops: [{ id: "static", frame: 0 }],
    },
  ];
}

function resolve(overrides = {}, { manifest, slides } = {}) {
  return resolveTimeline({
    manifest: manifest ?? { timeline: { ...structuredClone(TIMELINE), ...overrides } },
    slides: slides ?? deckSlides(),
    validateAnimation: (animation, options) => validateStopRevealAnimation(animation, options),
  });
}

test("timeline contract: explicit versioning requires lattice.timeline.v1", () => {
  assert.equal(validateTimelineDeclaration({ schema: "lattice.timeline.v2" }).ok, false);
  assert.equal(validateTimelineDeclaration({}).ok, false);
  assert.equal(validateTimelineDeclaration(TIMELINE).ok, true);
  const report = validateDeckManifestV2({
    schema: "lattice.deck.v2",
    id: "deck",
    title: "Deck",
    theme: "simple-light",
    canvas: { width: 960, height: 540 },
    fps: 30,
    entry: { slides: "./slides.js" },
    publication: { audience: "private" },
    routes: { main: ["a"] },
    timeline: TIMELINE,
  });
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  const rejected = validateDeckManifestV2({
    schema: "lattice.deck.v2",
    id: "deck",
    title: "Deck",
    theme: "simple-light",
    canvas: { width: 960, height: 540 },
    fps: 30,
    entry: { slides: "./slides.js" },
    publication: { audience: "private" },
    routes: { main: ["a"] },
    timeline: { schema: "lattice.timeline.v1", nonsense: true },
  });
  assert.equal(rejected.ok, false);
  assert.ok(rejected.errors.some((error) => error.type === "unknown-timeline-field"));
});

test("timeline contract: backward compatibility — decks without a timeline resolve to null everywhere", () => {
  const resolution = resolveTimeline({ manifest: {}, slides: deckSlides() });
  assert.deepEqual(resolution, { ok: true, errors: [], timeline: null });
  // A pre-M7 manifest stays valid unchanged (no unknown-field rejection).
  const report = validateDeckManifestV2({
    schema: "lattice.deck.v2",
    id: "deck",
    title: "Deck",
    theme: "simple-light",
    canvas: { width: 960, height: 540 },
    fps: 30,
    entry: { slides: "./slides.js" },
    publication: { audience: "private" },
    routes: { main: ["a"] },
  });
  assert.equal(report.ok, true);
});

test("timeline contract: default rhythm is derivable (fixed dwell per stop, deck override)", () => {
  assert.deepEqual(deriveStopFrames(1, TIMELINE_DEFAULT_RHYTHM), [0]);
  assert.deepEqual(deriveStopFrames(3, TIMELINE_DEFAULT_RHYTHM), [0, 12, 57]);
  assert.deepEqual(deriveStopFrames(3, { first: 6, dwell: 20 }), [0, 6, 26]);

  // Slides not mentioned in timeline.slides derive everything from the rhythm:
  // stop 0 on frame 0, one reveal per dwell, and a final dwell tail.
  const resolution = resolve();
  assert.equal(resolution.ok, true, JSON.stringify(resolution.errors));
  const outro = resolution.timeline.slides.find((entry) => entry.slideId === "outro");
  assert.deepEqual(outro.stops, [{ id: "static", frame: 0 }]);
  assert.equal(outro.durationFrames, TIMELINE.rhythm.dwell);
  assert.deepEqual(outro.animation, { preset: "fade", durationFrames: 8, stagger: 0 });
});

test("timeline contract: declared segment durations and stop frames win over derivation", () => {
  const resolution = resolve();
  const intro = resolution.timeline.slides.find((entry) => entry.slideId === "intro");
  assert.equal(intro.durationFrames, 90);
  assert.deepEqual(intro.stops, [{ id: "open", frame: 0 }, { id: "point", frame: 46 }]);
  assert.deepEqual(intro.animation, { preset: "rise", direction: "up", durationFrames: 12, stagger: 3, distancePx: 24 });
  assert.deepEqual(resolution.timeline.audioTracks, [{ id: "bgm", src: "./assets/audio/tone.wav", startFrame: 0, volume: 0.8 }]);
});

test("timeline contract: fail-fast on unknown slide ids, stop ids, and partial stop maps", () => {
  const unknownSlide = resolve({}, { manifest: { timeline: { ...TIMELINE, slides: { ghost: { durationFrames: 10 } } } } });
  assert.equal(unknownSlide.ok, false);
  assert.ok(unknownSlide.errors.some((error) => error.type === "unknown-timeline-slide"));

  const unknownStop = resolve({
    slides: { ...TIMELINE.slides, intro: { ...TIMELINE.slides.intro, stops: { open: { frame: 0 }, ghost: { frame: 10 } } } },
  });
  assert.equal(unknownStop.ok, false);
  assert.ok(unknownStop.errors.some((error) => error.type === "unknown-timeline-stop"));

  const partial = resolve({
    slides: { ...TIMELINE.slides, intro: { ...TIMELINE.slides.intro, stops: { open: { frame: 0 } } } },
  });
  assert.equal(partial.ok, false);
  assert.ok(partial.errors.some((error) => error.type === "missing-timeline-stop"));
});

test("timeline contract: fail-fast on frames outside the segment, non-increasing frames, and non-zero first stop", () => {
  const outOfRange = resolve({
    slides: { ...TIMELINE.slides, intro: { ...TIMELINE.slides.intro, durationFrames: 30 } },
  });
  assert.equal(outOfRange.ok, false);
  assert.ok(outOfRange.errors.some((error) => error.type === "invalid-timeline-stop"));

  const unordered = resolve({
    slides: { ...TIMELINE.slides, intro: { ...TIMELINE.slides.intro, stops: { open: { frame: 10 }, point: { frame: 5 } } } },
  });
  assert.equal(unordered.ok, false);
  assert.ok(unordered.errors.some((error) => error.type === "invalid-timeline-stop"));

  const nonzeroFirst = resolve({
    slides: { ...TIMELINE.slides, intro: { ...TIMELINE.slides.intro, stops: { open: { frame: 4 }, point: { frame: 46 } } } },
  });
  assert.equal(nonzeroFirst.ok, false);
  assert.ok(nonzeroFirst.errors.some((error) => error.message.includes("first stop must land on frame 0")));
});

test("timeline contract: animation values are validated against the theme preset catalog", () => {
  const illegalPreset = resolve({
    defaults: { animation: { preset: "spin" } },
  });
  assert.equal(illegalPreset.ok, false);
  assert.ok(JSON.stringify(illegalPreset.errors).includes("spin"));

  const illegalParam = resolve({
    slides: {
      ...TIMELINE.slides,
      intro: { ...TIMELINE.slides.intro, animation: { preset: "rise", direction: "diagonal" } },
    },
  });
  assert.equal(illegalParam.ok, false);
  assert.ok(JSON.stringify(illegalParam.errors).includes("direction"));

  // The catalog itself stays machine-readable and every preset validates.
  assert.equal(STOP_REVEAL_PRESET_CATALOG.schema, "lattice.stop-reveal-presets.v1");
  for (const preset of STOP_REVEAL_PRESET_CATALOG.presets) {
    assert.equal(validateStopRevealAnimation({ preset: preset.name }).ok, true, preset.name);
  }
});

test("timeline contract: data-lattice-reveal markers must reference real stops of the same slide", () => {
  assert.deepEqual(collectRevealMarkerIds(deckSlides()[0]), ["open", "point"]);
  const resolution = resolveTimeline({
    manifest: { timeline: structuredClone(TIMELINE) },
    slides: [
      {
        id: "intro",
        html: '<section><p data-lattice-reveal="ghost">X</p></section>',
        durationFrames: 90,
        stops: [{ id: "open", frame: 0 }],
      },
    ],
    validateAnimation: (animation, options) => validateStopRevealAnimation(animation, options),
  });
  assert.equal(resolution.ok, false);
  assert.ok(resolution.errors.some((error) => error.type === "unknown-reveal-marker"));
});

test("timeline contract: audio tracks validate shape and frames", () => {
  const bad = resolve({ audioTracks: [{ id: "bgm", src: "./assets/tone.wav", startFrame: -1 }] });
  assert.equal(bad.ok, false);
  assert.ok(JSON.stringify(bad.errors).includes("startFrame"));
  const badVolume = resolve({ audioTracks: [{ id: "bgm", src: "./assets/tone.wav", startFrame: 0, volume: -1 }] });
  assert.equal(badVolume.ok, false);
});

test("theme preset stylesheet: every catalog preset exists in presets.css and styles.css stays preset-free", async () => {
  const presetCss = await readFile(new URL("../themes/simple-light/presets.css", import.meta.url), "utf8");
  const stylesCss = await readFile(new URL("../themes/simple-light/styles.css", import.meta.url), "utf8");
  for (const preset of STOP_REVEAL_PRESET_CATALOG.presets) {
    assert.match(presetCss, new RegExp(`\\[data-lattice-anim="${preset.name}"\\]`), `preset ${preset.name} must have CSS`);
  }
  // Reduced motion: no travel, no clip movement.
  assert.match(presetCss, /prefers-reduced-motion: reduce/);
  // The base theme stylesheet must never carry the animation surface: static
  // decks (and their exported bundles) stay byte-identical to pre-M7.
  assert.doesNotMatch(stylesCss, /data-lattice-anim/);
});
