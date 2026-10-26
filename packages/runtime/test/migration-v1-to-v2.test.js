import assert from "node:assert/strict";
import { test } from "node:test";
import {
  V2_TIMING_STATIC,
  buildMigrationReport,
  hashMigrationReport,
  migrateDeckV1ToV2,
  serializeMigrationReport,
} from "../src/migration/v1-to-v2.js";

const v1Manifest = () => ({
  schema: "lattice.deck.v1",
  id: "fixture-deck",
  title: "Fixture Deck",
  owner: "qiang",
  presenter: "Qiang Liu",
  runtime: "^0.2.0",
  theme: "simple-light",
  entry: { content: "./content.js", layout: "./layout.js", notes: "./notes.js" },
  assets: "./assets/",
});

const slideIds = () => ["intro", "chart", "closing"];

test("migrateDeckV1ToV2 produces a valid deterministic v2 manifest", () => {
  const first = migrateDeckV1ToV2({ manifest: v1Manifest(), slideIds: slideIds() });
  const second = migrateDeckV1ToV2({ manifest: v1Manifest(), slideIds: slideIds() });
  assert.equal(first.ok, true, JSON.stringify(first.errors));
  assert.deepEqual(first.manifestV2, second.manifestV2);

  const { manifestV2 } = first;
  assert.equal(manifestV2.schema, "lattice.deck.v2");
  assert.equal(manifestV2.id, "fixture-deck");
  assert.equal(manifestV2.title, "Fixture Deck");
  assert.deepEqual(manifestV2.canvas, { width: 960, height: 540 });
  assert.equal(manifestV2.fps, 30);
  assert.equal(manifestV2.entry.slides, "./slides.v2.js");
  assert.equal(manifestV2.entry.content, "./content.js");
  assert.deepEqual(manifestV2.routes, { main: ["intro", "chart", "closing"] });
  assert.deepEqual(manifestV2.publication, { audience: "private" });
  assert.equal(manifestV2.theme, "simple-light");
  assert.equal(manifestV2.runtime, "^0.2.0");
  assert.equal(manifestV2.assets, "./assets/");
});

test("migration timing defaults are integer-frame static shapes", () => {
  assert.deepEqual(V2_TIMING_STATIC, {
    durationFrames: 1,
    stops: [{ id: "static", frame: 0, navigation: "jump" }],
  });
  const { manifestV2 } = migrateDeckV1ToV2({ manifest: v1Manifest(), slideIds: slideIds() });
  assert.equal(manifestV2.fps, 30);
  assert.ok(Number.isInteger(manifestV2.fps));
  assert.ok(Number.isInteger(manifestV2.canvas.width));
  assert.ok(Number.isInteger(manifestV2.canvas.height));
});

test("migrateDeckV1ToV2 fail-fast on non-v1 sources (no silent guessing)", () => {
  const v2 = migrateDeckV1ToV2({ manifest: { ...v1Manifest(), schema: "lattice.deck.v2" }, slideIds: slideIds() });
  assert.equal(v2.ok, false);
  assert.match(v2.reason, /already lattice\.deck\.v2/);

  const v9 = migrateDeckV1ToV2({ manifest: { ...v1Manifest(), schema: "lattice.deck.v9" }, slideIds: slideIds() });
  assert.equal(v9.ok, false);
  assert.match(v9.reason, /only lattice\.deck\.v1 is migrated/);
});

test("migrateDeckV1ToV2 fail-fast on invalid v1 manifests with the v1 issues", () => {
  const broken = { ...v1Manifest() };
  delete broken.presenter;
  const result = migrateDeckV1ToV2({ manifest: broken, slideIds: slideIds() });
  assert.equal(result.ok, false);
  assert.match(result.reason, /source v1 manifest is invalid/);
  assert.ok(result.errors.some((error) => error.element === "manifest.presenter"));
});

test("migrateDeckV1ToV2 fail-fast on duplicate or empty slide ids", () => {
  const duplicate = migrateDeckV1ToV2({ manifest: v1Manifest(), slideIds: ["intro", "intro"] });
  assert.equal(duplicate.ok, false);
  assert.match(duplicate.reason, /duplicate slide id/);

  const empty = migrateDeckV1ToV2({ manifest: v1Manifest(), slideIds: [] });
  assert.equal(empty.ok, false);
  assert.match(empty.reason, /non-empty array/);

  const bad = migrateDeckV1ToV2({ manifest: v1Manifest(), slideIds: ["intro", ""] });
  assert.equal(bad.ok, false);
  assert.match(bad.reason, /non-empty strings/);
});

test("migrateDeckV1ToV2 validates provided timing against the v2 slide contract", () => {
  const badTiming = migrateDeckV1ToV2({
    manifest: v1Manifest(),
    slideIds: slideIds(),
    timing: { durationFrames: 10, stops: [{ id: "late", frame: 10 }] },
  });
  assert.equal(badTiming.ok, false);
  assert.match(badTiming.reason, /slide contract/);

  const goodTiming = migrateDeckV1ToV2({
    manifest: v1Manifest(),
    slideIds: slideIds(),
    timing: { durationFrames: 90, stops: [{ id: "hold", frame: 0 }, { id: "end", frame: 89 }] },
  });
  assert.equal(goodTiming.ok, true);
  assert.deepEqual(goodTiming.timing, { durationFrames: 90, stops: [{ id: "hold", frame: 0 }, { id: "end", frame: 89 }] });
});

test("migration report is deterministic, reviewable, and freezes the content identity", () => {
  const { manifestV2 } = migrateDeckV1ToV2({ manifest: v1Manifest(), slideIds: slideIds() });
  const v1 = v1Manifest();
  const digests = [
    { index: 0, id: "intro", title: "Intro", sha256: "a".repeat(64) },
    { index: 1, id: "chart", title: "Chart", sha256: "b".repeat(64) },
  ];
  const reportA = buildMigrationReport({
    v1Manifest: v1,
    manifestV2,
    slideIds: slideIds(),
    changedFiles: ["slides.v2.js", "manifest.json", ".lattice/migration/fixture-deck.json"],
    slideDigests: digests,
  });
  const reportB = buildMigrationReport({
    v1Manifest: v1,
    manifestV2,
    slideIds: slideIds(),
    changedFiles: ["slides.v2.js", "manifest.json", ".lattice/migration/fixture-deck.json"],
    slideDigests: digests,
  });

  assert.equal(serializeMigrationReport(reportA), serializeMigrationReport(reportB));
  assert.equal(hashMigrationReport(reportA), hashMigrationReport(reportB));

  assert.equal(reportA.reportSchema, "lattice.migration-report.v1");
  assert.equal(reportA.fromSchema, "lattice.deck.v1");
  assert.equal(reportA.toSchema, "lattice.deck.v2");
  assert.deepEqual(reportA.changedFiles, [".lattice/migration/fixture-deck.json", "manifest.json", "slides.v2.js"]);
  assert.deepEqual(reportA.slideIds, slideIds());
  assert.deepEqual(reportA.contentIdentityManifest, v1);
  assert.equal(reportA.defaults.publication.audience, "private");
  assert.ok(reportA.changes.length >= 2);
  assert.ok(!serializeMigrationReport(reportA).includes(new Date().toISOString().slice(0, 4)), "report must not embed wall-clock dates");
});

test("buildMigrationReport validates its inputs fail-fast", () => {
  const { manifestV2 } = migrateDeckV1ToV2({ manifest: v1Manifest(), slideIds: slideIds() });
  assert.throws(() => buildMigrationReport({ v1Manifest: null, manifestV2, slideIds: slideIds(), changedFiles: ["manifest.json"] }));
  assert.throws(() => buildMigrationReport({ v1Manifest: v1Manifest(), manifestV2, slideIds: [], changedFiles: ["manifest.json"] }));
  assert.throws(() => buildMigrationReport({ v1Manifest: v1Manifest(), manifestV2, slideIds: slideIds(), changedFiles: [] }));
});

// ---- Frozen publication mapping (A07) ----

test("migrateDeckV1ToV2 preserves v1 publication metadata instead of overwriting it", () => {
  const withPublication = {
    ...v1Manifest(),
    publication: { audience: "internal", rights: "internal-only" },
  };
  const result = migrateDeckV1ToV2({ manifest: withPublication, slideIds: slideIds() });
  assert.equal(result.ok, true, JSON.stringify(result.errors, null, 2));
  assert.deepEqual(result.manifestV2.publication, { audience: "internal", rights: "internal-only" });
});

test("migrateDeckV1ToV2 keeps the conservative { audience: 'private' } default when v1 had no publication", () => {
  const result = migrateDeckV1ToV2({ manifest: v1Manifest(), slideIds: slideIds() });
  assert.equal(result.ok, true);
  assert.deepEqual(result.manifestV2.publication, { audience: "private" });
});

test("migrateDeckV1ToV2 fails explicitly when preserved v1 publication violates the v2 contract", () => {
  const badPublication = { ...v1Manifest(), publication: { audience: "public" } };
  const result = migrateDeckV1ToV2({ manifest: badPublication, slideIds: slideIds() });
  assert.equal(result.ok, false);
  assert.match(result.reason, /failed validation/);
  assert.ok(result.errors.some((error) => error.element?.startsWith("manifest.publication")));
});

test("buildMigrationReport names publication preservation only when v1 publication was preserved", () => {
  const { manifestV2: privateManifest } = migrateDeckV1ToV2({ manifest: v1Manifest(), slideIds: slideIds() });
  const privateReport = buildMigrationReport({
    v1Manifest: v1Manifest(),
    manifestV2: privateManifest,
    slideIds: slideIds(),
    changedFiles: ["manifest.json"],
  });
  assert.match(privateReport.changes[0].reason, /publication \(private\)/);

  const v1WithPublication = { ...v1Manifest(), publication: { audience: "internal", rights: "internal-only" } };
  const { manifestV2: preservedManifest } = migrateDeckV1ToV2({ manifest: v1WithPublication, slideIds: slideIds() });
  const preservedReport = buildMigrationReport({
    v1Manifest: v1WithPublication,
    manifestV2: preservedManifest,
    slideIds: slideIds(),
    changedFiles: ["manifest.json"],
  });
  assert.match(preservedReport.changes[0].reason, /preserved publication from v1/);
  assert.deepEqual(preservedReport.defaults.publication, { audience: "internal", rights: "internal-only" });
  assert.match(preservedReport.defaults.reviewNote, /preserved from lattice\.deck\.v1/);
  assert.match(privateReport.defaults.reviewNote, /defaults to audience private/);
});
