/*
 * Explicit lattice.deck.v1 → lattice.deck.v2 migration core (M1 A08).
 *
 * The migration is a pure, deterministic transform: the same v1 manifest,
 * slide-id order, and timing defaults always produce the same v2 manifest and
 * the same report bytes. There is no compatibility guessing anywhere else:
 * loaders only accept the schema they are named for, so the only path from v1
 * to v2 is this explicit migration.
 */

import { createHash } from "node:crypto";

import { DECK_SCHEMA_V2, validateDeckManifestV2, validateSlideDefinitions } from "../deck-v2/index.js";
import { validateManifest as validateManifestV1 } from "../deck/index.js";

export const V2_TIMING_STATIC = Object.freeze({
  durationFrames: 1,
  stops: Object.freeze([{ id: "static", frame: 0, navigation: "jump" }]),
});

function migrateFailure(reason, errors = []) {
  return { ok: false, reason, errors };
}

/**
 * Deterministically derive the v2 manifest from a validated v1 manifest.
 *
 * @param {object} input
 * @param {object} input.manifest        raw v1 manifest (validated first)
 * @param {string[]} input.slideIds      slide ids in presentation (buildSlides) order
 * @param {object} [input.timing]        per-deck timing defaults; defaults to the static single-frame shape
 * @param {number} [input.canvas]        { width, height }; defaults to the 960×540 theme canvas
 * @param {number} [input.fps]           canonical frame rate; defaults to 30
 */
export function migrateDeckV1ToV2({ manifest, slideIds, timing, canvas = { width: 960, height: 540 }, fps = 30 } = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return migrateFailure("manifest must be a JSON object");
  }
  if (manifest.schema !== "lattice.deck.v1") {
    return migrateFailure(
      manifest.schema === DECK_SCHEMA_V2
        ? "deck is already lattice.deck.v2; migration is a no-op"
        : `unsupported source schema ${JSON.stringify(manifest.schema ?? null)}; only lattice.deck.v1 is migrated`,
    );
  }
  const v1Report = validateManifestV1(manifest);
  if (!v1Report.ok) {
    return migrateFailure("source v1 manifest is invalid; fix it before migrating", v1Report.errors);
  }
  if (!Array.isArray(slideIds) || slideIds.length === 0) {
    return migrateFailure("slideIds must be a non-empty array in presentation (buildSlides) order");
  }
  const seenIds = new Set();
  for (const id of slideIds) {
    if (typeof id !== "string" || id === "") {
      return migrateFailure(`slideIds entries must be non-empty strings, got ${JSON.stringify(id ?? null)}`);
    }
    if (seenIds.has(id)) {
      return migrateFailure(`duplicate slide id "${id}" in slideIds`);
    }
    seenIds.add(id);
  }

  const resolvedTiming = timing ?? {
    durationFrames: V2_TIMING_STATIC.durationFrames,
    stops: V2_TIMING_STATIC.stops.map((stop) => ({ ...stop })),
  };

  // Validate the timing shape that will be embedded in the generated slide
  // entry so migration can never emit structurally invalid v2 slides.
  const timingProbe = slideIds.map((id) => ({
    id,
    html: "",
    durationFrames: resolvedTiming.durationFrames,
    stops: resolvedTiming.stops.map((stop) => ({ ...stop })),
  }));
  const timingReport = validateSlideDefinitions(timingProbe);
  if (!timingReport.ok) {
    return migrateFailure("timing defaults do not satisfy the lattice.deck.v2 slide contract", timingReport.errors);
  }

  const manifestV2 = {
    schema: DECK_SCHEMA_V2,
    id: manifest.id,
    title: manifest.title,
    ...(manifest.owner !== undefined ? { owner: manifest.owner } : {}),
    ...(manifest.presenter !== undefined ? { presenter: manifest.presenter } : {}),
    ...(manifest.runtime !== undefined ? { runtime: manifest.runtime } : {}),
    theme: manifest.theme,
    canvas: { width: canvas.width, height: canvas.height },
    fps,
    entry: {
      slides: "./slides.v2.js",
      ...(manifest.entry?.content !== undefined ? { content: manifest.entry.content } : {}),
      ...(manifest.entry?.layout !== undefined ? { layout: manifest.entry.layout } : {}),
      ...(manifest.entry?.notes !== undefined ? { notes: manifest.entry.notes } : {}),
      ...(manifest.entry?.sources !== undefined ? { sources: manifest.entry.sources } : {}),
      ...(manifest.entry?.references !== undefined ? { references: manifest.entry.references } : {}),
    },
    // Conservative deterministic publication mapping: preserve v1 publication
    // metadata verbatim when the v1 deck had any; otherwise the v2 deck starts
    // at exactly { audience: "private" }. Migration must never widen or
    // overwrite an explicit publication decision.
    publication: manifest.publication !== undefined
      ? JSON.parse(JSON.stringify(manifest.publication))
      : { audience: "private" },
    routes: { main: [...slideIds] },
    ...(manifest.assets !== undefined ? { assets: manifest.assets } : {}),
    ...(manifest.description !== undefined ? { description: manifest.description } : {}),
    ...(manifest.sources !== undefined ? { sources: manifest.sources } : {}),
    ...(manifest.references !== undefined ? { references: manifest.references } : {}),
  };

  const validation = validateDeckManifestV2(manifestV2, { expectedId: manifest.id, slideIds });
  if (!validation.ok) {
    return migrateFailure("generated v2 manifest failed validation", validation.errors);
  }

  return { ok: true, manifestV2, timing: resolvedTiming };
}

function stableJson(value) {
  return JSON.stringify(value, null, 2);
}

const CHANGE_REASONS = {
  "slides.v2.js":
    "canonical v2 slide entry: wraps the deck's existing buildSlides() output with stable slide ids and integer-frame timing",
};

function manifestChangeReason(manifestV2) {
  return manifestV2.publication !== undefined && manifestV2.publication.audience !== undefined && JSON.stringify(manifestV2.publication) !== JSON.stringify({ audience: "private" })
    ? "schema lattice.deck.v1 → lattice.deck.v2; added canvas, fps, entry.slides, routes.main; preserved publication from v1"
    : "schema lattice.deck.v1 → lattice.deck.v2; added canvas, fps, entry.slides, publication (private), routes.main";
}

/**
 * Build the deterministic, reviewable migration report.
 *
 * The report contains the frozen pre-migration semantic manifest
 * (contentIdentityManifest) — the exact object the Content Lock v4 records
 * were computed from — plus the full change list and slide-output digests so
 * reviewers (and the lock harness) can prove byte-for-byte content
 * preservation after migration. The report contains no wall-clock values.
 *
 * @param {object} input
 * @param {object} input.v1Manifest        raw pre-migration manifest
 * @param {object} input.manifestV2        generated v2 manifest
 * @param {string[]} input.slideIds        slide ids in presentation order
 * @param {string[]} input.changedFiles    deck-relative paths, sorted
 * @param {Array<{index: number, id: string, title: string, sha256: string}>} [input.slideDigests]
 */
export function buildMigrationReport({ v1Manifest, manifestV2, slideIds, changedFiles, slideDigests = [] }) {
  if (!v1Manifest || typeof v1Manifest !== "object") throw new TypeError("v1Manifest is required");
  if (!manifestV2 || typeof manifestV2 !== "object") throw new TypeError("manifestV2 is required");
  if (!Array.isArray(slideIds) || slideIds.length === 0) throw new TypeError("slideIds is required");
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) throw new TypeError("changedFiles is required");
  const sortedFiles = [...changedFiles].sort();
  return {
    reportSchema: "lattice.migration-report.v1",
    deckId: manifestV2.id,
    fromSchema: v1Manifest.schema,
    toSchema: manifestV2.schema,
    changedFiles: sortedFiles,
    changes: sortedFiles.map((path) => ({
      path,
      action: path.endsWith("manifest.json") ? "modified" : "added",
      reason: path.endsWith("manifest.json")
        ? manifestChangeReason(manifestV2)
        : CHANGE_REASONS[path] ?? "deterministic migration record (this report)",
    })),
    timing: { durationFrames: V2_TIMING_STATIC.durationFrames, stops: V2_TIMING_STATIC.stops },
    defaults: {
      canvas: manifestV2.canvas,
      fps: manifestV2.fps,
      publication: manifestV2.publication,
      reviewNote: v1Manifest.publication !== undefined
        ? "publication metadata was preserved from lattice.deck.v1; change it only after explicit review"
        : "publication defaults to audience private; widen deliberately after review",
    },
    routes: manifestV2.routes,
    slideIds: [...slideIds],
    slideDigests,
    contentIdentityManifest: JSON.parse(JSON.stringify(v1Manifest)),
  };
}

export function serializeMigrationReport(report) {
  return stableJson(report);
}

export function hashMigrationReport(report) {
  return createHash("sha256").update(serializeMigrationReport(report), "utf8").digest("hex");
}
