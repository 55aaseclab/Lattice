import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DECK_SCHEMA_V2,
  assertFrameAddress,
  createFrameAddress,
  formatFrameAddress,
  isFrameAddress,
  loadDeckV2,
  validateDeckManifestV2,
  validateSlideDefinition,
  validateSlideDefinitions,
} from "../src/deck-v2/index.js";
import { DECK_SCHEMA } from "../src/deck/index.js";

const validManifest = () => ({
  schema: DECK_SCHEMA_V2,
  id: "fixture-deck",
  title: "Fixture Deck",
  theme: "simple-light",
  canvas: { width: 960, height: 540 },
  fps: 30,
  entry: {
    slides: "./slides.v2.js",
    content: "./content.js",
    layout: "./layout.js",
    notes: "./notes.js",
  },
  publication: { audience: "private" },
  routes: { main: ["intro", "chart"] },
});

const validSlides = () => [
  {
    id: "intro",
    html: '<section class="slide-canvas"><h1 data-lattice-id="intro-title">Hello</h1></section>',
    durationFrames: 30,
    stops: [{ id: "opening", frame: 0 }, { id: "revealed", frame: 10, navigation: "play" }],
  },
  {
    id: "chart",
    html: '<section class="slide-canvas" data-lattice-id="chart"><svg viewBox="0 0 10 10"></svg></section>',
    durationFrames: 1,
    stops: [{ id: "static", frame: 0 }],
  },
];

// ---- FrameAddress (A09) ----

test("createFrameAddress builds a frozen integer-frame address", () => {
  const address = createFrameAddress("intro", 7);
  assert.deepEqual(address, { slideId: "intro", localFrame: 7 });
  assert.equal(Object.isFrozen(address), true);
});

test("FrameAddress rejects fractional, non-finite, negative, and non-integer frames", () => {
  for (const bad of [1.5, 0.1, NaN, Infinity, -Infinity, -1, "3", null, undefined]) {
    assert.throws(() => createFrameAddress("intro", bad), /localFrame/, `localFrame ${String(bad)} must be rejected`);
  }
  assert.throws(() => createFrameAddress("", 0), /slideId/);
  assert.throws(() => createFrameAddress(42, 0), /slideId/);
});

test("isFrameAddress and formatFrameAddress describe addresses precisely", () => {
  assert.equal(isFrameAddress({ slideId: "a", localFrame: 0 }), true);
  assert.equal(isFrameAddress({ slideId: "a", localFrame: 1.5 }), false);
  assert.equal(isFrameAddress({ slideId: "a", localFrame: NaN }), false);
  assert.equal(formatFrameAddress({ slideId: "intro", localFrame: 12 }), "intro#12");
  assert.throws(() => assertFrameAddress({ slideId: "intro", localFrame: 2.5 }), /fractional/);
});

// ---- SlideDefinition + stops (A09) ----

test("validateSlideDefinition accepts the canonical integer-frame shape", () => {
  const { errors, stopIds } = validateSlideDefinition(validSlides()[0], { index: 0 });
  assert.deepEqual(errors, []);
  assert.deepEqual(stopIds, ["opening", "revealed"]);
});

test("validateSlideDefinition rejects seconds-family fields (no backend time units)", () => {
  const report = validateSlideDefinition({
    id: "intro",
    html: "<section></section>",
    durationFrames: 30,
    durationSeconds: 1,
    stops: [{ id: "opening", frame: 0, seconds: 0.5 }],
  }, { index: 0 });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.type === "backend-time-unit" && error.element.endsWith("durationSeconds")));
  assert.ok(report.errors.some((error) => error.type === "backend-time-unit" && error.element.includes("seconds")));
});

test("validateSlideDefinition rejects unknown and backend-shaped fields (type leakage)", () => {
  const report = validateSlideDefinition({
    id: "intro",
    html: "<section></section>",
    durationFrames: 30,
    stops: [{ id: "opening", frame: 0 }],
    compositionId: "RemotionRoot",
    useCurrentFrame: true,
  }, { index: 0 });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.type === "unknown-slide-field" && error.element.endsWith("compositionId")));
  assert.ok(report.errors.some((error) => error.type === "unknown-slide-field" && error.element.endsWith("useCurrentFrame")));
});

test("validateSlideDefinition rejects fractional, non-finite, and out-of-range stop frames", () => {
  const fractional = validateSlideDefinition({
    id: "s", html: "", durationFrames: 30,
    stops: [{ id: "a", frame: 1.5 }],
  }, { index: 0 });
  assert.ok(fractional.errors.some((error) => error.type === "invalid-frame" && error.message.includes("fractional")));

  const infinite = validateSlideDefinition({
    id: "s", html: "", durationFrames: 30,
    stops: [{ id: "a", frame: Infinity }],
  }, { index: 0 });
  assert.ok(infinite.errors.some((error) => error.type === "invalid-frame"));

  const outOfRange = validateSlideDefinition({
    id: "s", html: "", durationFrames: 30,
    stops: [{ id: "a", frame: 30 }],
  }, { index: 0 });
  assert.ok(outOfRange.errors.some((error) => error.type === "invalid-frame" && error.message.includes("outside [0, durationFrames - 1]")));

  const negative = validateSlideDefinition({
    id: "s", html: "", durationFrames: 30,
    stops: [{ id: "a", frame: -1 }],
  }, { index: 0 });
  assert.ok(negative.errors.some((error) => error.type === "invalid-frame" && error.message.includes(">= 0")));
});

test("validateSlideDefinition rejects non-positive and fractional durationFrames", () => {
  for (const durationFrames of [0, -10, 2.5, NaN, Infinity, "30"]) {
    const report = validateSlideDefinition({
      id: "s", html: "", durationFrames,
      stops: [{ id: "a", frame: 0 }],
    }, { index: 0 });
    assert.ok(report.errors.some((error) => error.type === "invalid-frame" && error.element.endsWith("durationFrames")), `durationFrames ${String(durationFrames)} must be rejected`);
  }
});

test("validateSlideDefinition enforces unique, strictly increasing stops and navigation values", () => {
  const duplicates = validateSlideDefinition({
    id: "s", html: "", durationFrames: 30,
    stops: [{ id: "same", frame: 0 }, { id: "same", frame: 5 }],
  }, { index: 0 });
  assert.ok(duplicates.errors.some((error) => error.type === "duplicate-stop-id"));

  const nonIncreasing = validateSlideDefinition({
    id: "s", html: "", durationFrames: 30,
    stops: [{ id: "b", frame: 10 }, { id: "a", frame: 10 }],
  }, { index: 0 });
  assert.ok(nonIncreasing.errors.some((error) => error.message.includes("strictly increasing")));

  const badNavigation = validateSlideDefinition({
    id: "s", html: "", durationFrames: 30,
    stops: [{ id: "a", frame: 0, navigation: "loop" }],
  }, { index: 0 });
  assert.ok(badNavigation.errors.some((error) => error.message.includes("navigation")));
});

test("validateSlideDefinitions rejects duplicate slide ids across the deck", () => {
  const report = validateSlideDefinitions([
    { id: "a", html: "", durationFrames: 1, stops: [{ id: "s", frame: 0 }] },
    { id: "a", html: "", durationFrames: 1, stops: [{ id: "s", frame: 0 }] },
  ]);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.type === "duplicate-slide-id"));
});

// ---- Manifest validation (A07) ----

test("validateDeckManifestV2 accepts a canonical manifest", () => {
  const report = validateDeckManifestV2(validManifest(), { expectedId: "fixture-deck", slideIds: ["intro", "chart"] });
  assert.deepEqual(report, { ok: true, errors: [] });
});

test("validateDeckManifestV2 fails fast on unknown schemas, including v1, with migration guidance", () => {
  const v1 = validateDeckManifestV2({ ...validManifest(), schema: "lattice.deck.v1" });
  assert.equal(v1.ok, false);
  assert.equal(v1.errors[0].type, "schema-mismatch");
  assert.match(v1.errors[0].message, /lattice migrate/);

  const unknown = validateDeckManifestV2({ ...validManifest(), schema: "lattice.deck.v9" });
  assert.equal(unknown.ok, false);
  assert.match(unknown.errors[0].message, /unsupported deck schema/);

  const missing = validateDeckManifestV2({ ...validManifest(), schema: undefined });
  assert.equal(missing.ok, false);
});

test("validateDeckManifestV2 rejects illegal frame values in fps and canvas", () => {
  for (const fps of [0, -30, 29.97, NaN, Infinity, "30"]) {
    const report = validateDeckManifestV2({ ...validManifest(), fps });
    assert.equal(report.ok, false, `fps ${String(fps)} must be rejected`);
    assert.ok(report.errors.some((error) => error.element === "manifest.fps"));
  }
  const fractionalCanvas = validateDeckManifestV2({ ...validManifest(), canvas: { width: 960.5, height: 540 } });
  assert.ok(fractionalCanvas.errors.some((error) => error.element === "manifest.canvas.width" && error.message.includes("fractional")));
});

test("validateDeckManifestV2 rejects malformed routes: empty, unknown slide, duplicates, missing main", () => {
  const empty = validateDeckManifestV2({ ...validManifest(), routes: { main: [] } });
  assert.ok(empty.errors.some((error) => error.element === "manifest.routes.main"));

  const unknown = validateDeckManifestV2({ ...validManifest(), routes: { main: ["intro", "ghost"] } }, { slideIds: ["intro", "chart"] });
  assert.ok(unknown.errors.some((error) => error.type === "unknown-route-slide" && error.slide === "ghost"));

  const duplicate = validateDeckManifestV2({ ...validManifest(), routes: { main: ["intro", "intro"] } }, { slideIds: ["intro", "chart"] });
  assert.ok(duplicate.errors.some((error) => error.type === "duplicate-route-entry"));

  const noMain = validateDeckManifestV2({ ...validManifest(), routes: { secondary: ["intro"] } });
  assert.ok(noMain.errors.some((error) => error.message.includes('at least the "main" route')));

  const notArray = validateDeckManifestV2({ ...validManifest(), routes: { main: "intro" } });
  assert.ok(notArray.errors.some((error) => error.element === "manifest.routes.main"));
});

test("validateDeckManifestV2 requires publication with a valid audience", () => {
  const missing = validateDeckManifestV2({ ...validManifest(), publication: undefined });
  assert.ok(missing.errors.some((error) => error.element === "manifest.publication"));

  const badAudience = validateDeckManifestV2({ ...validManifest(), publication: { audience: "unlisted" } });
  assert.ok(badAudience.errors.some((error) => error.element === "manifest.publication.audience"));

  const publicIncomplete = validateDeckManifestV2({ ...validManifest(), publication: { audience: "public" } });
  for (const key of ["presenter", "organization", "date", "rights"]) {
    assert.ok(publicIncomplete.errors.some((error) => error.element === `manifest.publication.${key}`));
  }

  const publicComplete = validateDeckManifestV2({
    ...validManifest(),
    publication: { audience: "public", presenter: "Q", organization: "GBU", date: "2026-10-26", rights: "CC-BY-4.0" },
  });
  assert.equal(publicComplete.ok, true);
});

test("validateDeckManifestV2 fails fast on unknown manifest fields with locations", () => {
  const report = validateDeckManifestV2({ ...validManifest(), videoPlan: { routes: {} } });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.type === "unknown-manifest-field" && error.element === "manifest.videoPlan"));
});

// ---- videoProfiles stays engine-neutral (A09) ----

test("validateDeckManifestV2 accepts engine-neutral videoProfiles policy", () => {
  const report = validateDeckManifestV2({
    ...validManifest(),
    videoProfiles: {
      main: {
        route: "main",
        codec: "h264",
        width: 1920,
        height: 1080,
        fps: 30,
        audio: { codec: "aac", channels: 2, language: "en" },
      },
    },
  }, { slideIds: ["intro", "chart"] });
  assert.deepEqual(report, { ok: true, errors: [] });
});

test("validateDeckManifestV2 rejects backend seconds/milliseconds and Remotion/HyperFrames keys in videoProfiles (A09)", () => {
  // The exact leak shape that must never validate: backend time units plus a
  // backend-specific composition id, both structural keys inside the profile.
  const report = validateDeckManifestV2({
    ...validManifest(),
    videoProfiles: {
      main: { route: "main", durationSeconds: 3, remotionCompositionId: "x" },
    },
  }, { slideIds: ["intro", "chart"] });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.type === "backend-time-unit" && error.element === "manifest.videoProfiles.main.durationSeconds"));
  assert.ok(report.errors.some((error) => error.type === "backend-specific-video-profile-field" && error.element === "manifest.videoProfiles.main.remotionCompositionId"));
});

test("validateDeckManifestV2 rejects backend keys nested anywhere in videoProfiles (A09)", () => {
  const nested = validateDeckManifestV2({
    ...validManifest(),
    videoProfiles: {
      main: {
        route: "main",
        audio: { codec: "aac", durationMillis: 3000 },
        render: [{ hyperframesCompositionId: "hf-root" }],
      },
    },
  }, { slideIds: ["intro", "chart"] });
  assert.equal(nested.ok, false);
  assert.ok(nested.errors.some((error) => error.type === "backend-time-unit" && error.element === "manifest.videoProfiles.main.audio.durationMillis"));
  assert.ok(nested.errors.some((error) => error.type === "backend-specific-video-profile-field" && error.element === "manifest.videoProfiles.main.render[0].hyperframesCompositionId"));

  const profileName = validateDeckManifestV2({
    ...validManifest(),
    videoProfiles: { "remotion-hd": { route: "main" } },
  }, { slideIds: ["intro", "chart"] });
  assert.equal(profileName.ok, false);
  assert.ok(profileName.errors.some((error) => error.type === "backend-specific-video-profile-field" && error.element === "manifest.videoProfiles.remotion-hd"));
});

test("validateDeckManifestV2 rejects camelCase ms/us time units nested in videoProfiles (A09)", () => {
  for (const [key, value] of [["durationMs", 3000], ["timeMs", 3000], ["delayMs", 25], ["timeUs", 1000]]) {
    const report = validateDeckManifestV2({
      ...validManifest(),
      videoProfiles: {
        main: {
          route: "main",
          audio: { codec: "aac", [key]: value },
        },
      },
    }, { slideIds: ["intro", "chart"] });
    assert.equal(report.ok, false, `${key} must not leak backend time units through a nested profile`);
    assert.ok(
      report.errors.some((error) => error.type === "backend-time-unit" && error.element === `manifest.videoProfiles.main.audio.${key}`),
      JSON.stringify(report.errors, null, 2),
    );
  }
});

test("validateDeckManifestV2 still rejects unknown engine-neutral-unrelated videoProfiles fields (A09)", () => {
  const report = validateDeckManifestV2({
    ...validManifest(),
    videoProfiles: { main: { route: "main", layoutPreset: "wide" } },
  }, { slideIds: ["intro", "chart"] });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.type === "unknown-video-profile-field" && error.element === "manifest.videoProfiles.main.layoutPreset"));
});

test("validateDeckManifestV2 never scans business HTML or inputProps strings for backend words (A09)", () => {
  const report = validateDeckManifestV2({
    ...validManifest(),
    videoProfiles: { main: { route: "main", codec: "h264" } },
  }, { slideIds: ["intro", "chart"] });
  assert.deepEqual(report, { ok: true, errors: [] });

  const talkySlides = [
    {
      id: "intro",
      html: '<section><p>rendered by remotion over 3 seconds, powered by hyperframes</p></section>',
      durationFrames: 30,
      stops: [{ id: "opening", frame: 0 }],
      inputProps: { note: "remotionCompositionId=dmT in 1200ms", source: "hyperframes export" },
    },
    validSlides()[1],
  ];
  const definitions = validateSlideDefinitions(talkySlides);
  assert.equal(definitions.ok, true, JSON.stringify(definitions.errors, null, 2));
});

test("validateDeckManifestV2 validates the expected deck directory id", () => {
  const report = validateDeckManifestV2(validManifest(), { expectedId: "other-deck" });
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.element === "manifest.id" && error.message.includes("does not match")));
});

// ---- Loader (A07/A08: no silent compatibility guessing) ----

function writeDeckFixture({ manifest, slidesSource }) {
  const parent = mkdtempSync(join(tmpdir(), "lattice-deck-v2-"));
  const dir = join(parent, manifest.id ?? "fixture-deck");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  writeFileSync(join(dir, "slides.v2.js"), slidesSource, "utf8");
  return dir;
}

test("loadDeckV2 loads a valid v2 deck with routes and slide definitions", async () => {
  const dir = writeDeckFixture({
    manifest: validManifest(),
    slidesSource: `export const slideDefinitions = ${JSON.stringify(validSlides())};\n`,
  });
  try {
    const result = await loadDeckV2(dir);
    assert.equal(result.ok, true, JSON.stringify(result.errors));
    assert.equal(result.manifest.schema, DECK_SCHEMA_V2);
    assert.equal(result.slides.length, 2);
    assert.deepEqual(result.routes.main, ["intro", "chart"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadDeckV2 refuses v1 sources explicitly instead of silently upgrading them", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lattice-deck-v1-"));
  writeFileSync(join(dir, "manifest.json"), JSON.stringify({
    schema: DECK_SCHEMA,
    id: "legacy-deck",
    title: "Legacy",
    owner: "qiang",
    presenter: "Qiang Liu",
    runtime: "^0.2.0",
    theme: "simple-light",
    entry: { content: "./content.js", layout: "./layout.js", notes: "./notes.js" },
    assets: "./assets/",
  }, null, 2), "utf8");
  try {
    const result = await loadDeckV2(dir);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].type, "schema-mismatch");
    assert.match(result.errors[0].message, /does not silently upgrade|lattice migrate/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadDeckV2 fail-fast on a slide entry without the slideDefinitions export", async () => {
  const dir = writeDeckFixture({
    manifest: validManifest(),
    slidesSource: `export default [];\n`,
  });
  try {
    const result = await loadDeckV2(dir);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].type, "invalid-slide-entry");
    assert.match(result.errors[0].message, /slideDefinitions/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadDeckV2 fail-fast when routes reference slides missing from the entry module", async () => {
  const dir = writeDeckFixture({
    manifest: validManifest(),
    slidesSource: `export const slideDefinitions = [${JSON.stringify(validSlides()[0])}];\n`,
  });
  try {
    const result = await loadDeckV2(dir);
    assert.equal(result.ok, false);
    assert.ok(result.errors.some((error) => error.type === "unknown-route-slide" && error.slide === "chart"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadDeckV2 fail-fast on unreadable manifest", async () => {
  const dir = mkdtempSync(join(tmpdir(), "lattice-deck-empty-"));
  try {
    const result = await loadDeckV2(dir);
    assert.equal(result.ok, false);
    assert.equal(result.errors[0].type, "missing-manifest");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
