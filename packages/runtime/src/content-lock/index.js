import { createHash } from "node:crypto";

export const CONTENT_LOCK_VERSION = 4;

export const CONTENT_LOCK_SCHEMA = "lattice.content-lock.v4";

// Only attributes reachable by the data-* parser are meaningful here. Every
// entry must be a full `data-*` attribute name; non-prefixed names such as
// "slide-number" can never match and would silently drop semantic identity.
const SEMANTIC_DATA_ATTRS = new Set([
  "data-lattice-id",
  "data-lattice-deck",
  "data-id",
  "data-group",
  "data-semantic-id",
  "data-semantic-group",
  "data-content-id",
  "data-slide-number",
  "data-backup-slide",
  "data-motion-group",
  "data-motion-label",
  "data-annotation-id",
  "data-annotation-surface",
  "data-interactive-trend-chart",
  "data-trend-aria-label",
]);

const PRESENTATION_ATTRS = new Set([
  "class",
  "style",
  "data-layout",
  "data-sizes",
  "width",
  "height",
  "viewBox",
  "preserveAspectRatio",
  "fill",
  "stroke",
  "stroke-width",
  "stroke-dasharray",
  "font-family",
  "font-size",
  "font-weight",
  "text-anchor",
  "dominant-baseline",
  "opacity",
  "transform",
  "d",
  "cx",
  "cy",
  "rx",
  "ry",
  "x",
  "y",
  "dx",
  "dy",
  "r",
  "points",
  "markerWidth",
  "markerHeight",
  "refX",
  "refY",
  "orient",
  "markerUnits",
  "strokeLinecap",
  "textLength",
  "lengthAdjust",
  "xmlns",
  "version",
  "encoding",
]);

function stableStringify(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Object.is(value, -0)) return "-0";
    if (Number.isNaN(value)) return "NaN";
    if (!Number.isFinite(value)) return value > 0 ? "Infinity" : "-Infinity";
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).sort();
    return "{" + keys.map((k) => stableStringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
  }
  return JSON.stringify(String(value));
}

function hashContent(content) {
  return createHash("sha256").update(stableStringify(content), "utf8").digest("hex");
}

function extractVisibleText(htmlString) {
  if (typeof htmlString !== "string") return [];
  const texts = [];
  const clean = htmlString
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "");
  const regex = />([^<]+)</g;
  let match;
  while ((match = regex.exec(clean)) !== null) {
    const text = match[1].replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();
    if (text) texts.push(text);
  }
  return texts;
}

function extractAriaLabels(htmlString) {
  if (typeof htmlString !== "string") return [];
  const labels = [];
  // Negative lookbehind keeps compound names like `data-trend-aria-label`
  // out of the standalone aria-label channel; those are locked intentionally
  // through the semantic data-attribute channel instead.
  const ariaRegex = /(?<![\w-])aria-label\s*=\s*"([^"]*)"/gi;
  let match;
  while ((match = ariaRegex.exec(htmlString)) !== null) {
    labels.push(match[1]);
  }
  return labels;
}

function extractStableIds(htmlString) {
  if (typeof htmlString !== "string") return [];
  const ids = [];
  // Negative lookbehind so data-id= / aria-labelledby ids are not captured;
  // only ordinary stable `id` attributes count.
  const idRegex = /(?<![\w-])id\s*=\s*"([^"]*)"/gi;
  let match;
  while ((match = idRegex.exec(htmlString)) !== null) {
    if (match[1]) ids.push(match[1]);
  }
  return ids;
}

function filterSemanticAttrs(attrName) {
  return SEMANTIC_DATA_ATTRS.has(attrName);
}

function extractSemanticDataAttrs(htmlString) {
  if (typeof htmlString !== "string") return {};
  const attrs = {};
  const dataRegex = /data-([^=\s]+)\s*=\s*"([^"]*)"/gi;
  let match;
  while ((match = dataRegex.exec(htmlString)) !== null) {
    const attrName = `data-${match[1]}`;
    if (!filterSemanticAttrs(attrName)) continue;
    if (!attrs[match[1]]) attrs[match[1]] = [];
    attrs[match[1]].push(match[2]);
  }
  return attrs;
}

function extractStructuralTokens(htmlString) {
  if (typeof htmlString !== "string") return [];
  const tokens = [];
  const combinedRegex = /<\/?(\w+)(\s[^>]*)?>|(<\/\w+>)/g;
  let match;
  while ((match = combinedRegex.exec(htmlString)) !== null) {
    if (match[1]) {
      const tagName = match[1].toLowerCase();
      const isClosing = htmlString[match.index + 1] === "/";
      tokens.push(isClosing ? `/${tagName}` : tagName);
    }
  }
  return tokens;
}

function extractAltText(htmlString) {
  if (typeof htmlString !== "string") return [];
  const alts = [];
  const altRegex = /\balt\s*=\s*"([^"]*)"/gi;
  let match;
  while ((match = altRegex.exec(htmlString)) !== null) {
    alts.push(match[1]);
  }
  return alts;
}

// Presentation-only markers must never turn an inert data script into a
// content fingerprint input, mirroring the attribute-level contract.
const PRESENTATION_DATA_MARKERS = new Set(["data-layout", "data-sizes"]);

// Fingerprint ordered embedded JSON data carried by inert
// `<script type="application/json" data-*>` elements. Each entry keeps the
// semantic marker identity, document occurrence order, and a deterministic
// payload representation (parsed + canonically stringified when the payload
// is valid JSON, raw bytes otherwise). Executable script bodies are never
// included: only `type="application/json"` scripts with a data marker count.
function extractEmbeddedJsonPayloads(htmlString) {
  if (typeof htmlString !== "string") return [];
  const entries = [];
  const scriptRegex = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = scriptRegex.exec(htmlString)) !== null) {
    const attrs = match[1];
    if (!/\btype\s*=\s*["']application\/json["']/i.test(attrs)) continue;
    // Markers may be valueless boolean attributes (data-trend-series) or
    // carry a value; the marker NAME is the semantic identity.
    const markerRegex = /\b(data-[^\s=\/>"']+)(\s*=\s*["'][^"']*["'])?/gi;
    let marker;
    const seen = new Set();
    while ((marker = markerRegex.exec(attrs)) !== null) {
      const markerName = marker[1];
      if (PRESENTATION_DATA_MARKERS.has(markerName) || seen.has(markerName)) continue;
      seen.add(markerName);
      const raw = match[2];
      let payload;
      try {
        payload = stableStringify(JSON.parse(raw));
      } catch {
        payload = raw;
      }
      entries.push({ marker: markerName, payload });
    }
  }
  return entries;
}

function normalizeSlideContent(htmlString) {
  if (typeof htmlString !== "string") return null;
  return {
    visibleText: extractVisibleText(htmlString),
    ariaLabels: extractAriaLabels(htmlString),
    altText: extractAltText(htmlString),
    semanticDataAttrs: extractSemanticDataAttrs(htmlString),
    stableIds: extractStableIds(htmlString),
    structuralTokens: extractStructuralTokens(htmlString),
    embeddedJson: extractEmbeddedJsonPayloads(htmlString),
  };
}

export function computeDeckSemanticPayload({
  slideOutputs,
  content,
  notes,
  manifest,
}) {
  const slidesPayload = [];
  if (Array.isArray(slideOutputs)) {
    for (let i = 0; i < slideOutputs.length; i++) {
      const html = slideOutputs[i];
      const normalized = normalizeSlideContent(html);
      slidesPayload.push({
        slideIndex: i,
        ...normalized,
      });
    }
  }

  const contentPayload = content
    ? JSON.parse(JSON.stringify(content))
    : null;

  const notesPayload = notes ? { ...notes } : {};

  // Semantic manifest identity only. Pure theme/runtime selection is
  // presentation state, not content: swapping theme or bumping the runtime
  // range must never alter the content fingerprint. The M7 deck timeline
  // (lattice.timeline.v1) IS frozen identity when declared: timing changes
  // must pass the Content Lock gate with explicit authorization. The key is
  // added only when present so every pre-M7 deck hashes byte-identically to
  // its stored lock.
  let manifestPayload = {};
  if (manifest) {
    const { schema, id, title, owner, presenter, publication, sources, references } = manifest;
    manifestPayload = {
      schema,
      id,
      title,
      owner,
      presenter,
      publication: publication || undefined,
      sources: sources || undefined,
      references: references || undefined,
    };
    if (manifest.timeline) manifestPayload.timeline = manifest.timeline;
  }

  return {
    slideCount: slidesPayload.length,
    slides: slidesPayload,
    content: contentPayload,
    notes: notesPayload,
    manifest: manifestPayload,
  };
}

function hashDeckSemanticPayload(payload) {
  const canonical = {
    slideCount: payload.slideCount,
    slides: payload.slides.map((s) => ({
      i: s.slideIndex,
      v: hashContent(s.visibleText || []),
      a: hashContent(s.ariaLabels || []),
      t: hashContent(s.altText || []),
      s: hashContent(s.structuralTokens || []),
      d: hashContent(s.semanticDataAttrs || {}),
      n: hashContent(s.stableIds || []),
      j: hashContent(s.embeddedJson || []),
    })),
    contentHash: hashContent(payload.content),
    notesHash: hashContent(payload.notes),
    manifestHash: hashContent(payload.manifest),
  };
  return {
    version: CONTENT_LOCK_VERSION,
    slideCount: canonical.slideCount,
    slideHashes: canonical.slides,
    contentHash: canonical.contentHash,
    notesHash: canonical.notesHash,
    manifestHash: canonical.manifestHash,
    compositeHash: hashContent(canonical),
  };
}

export function computeContentFingerprint(content, manifest, notes, slideOutputs) {
  const payload = computeDeckSemanticPayload({
    slideOutputs,
    content,
    notes,
    manifest,
  });
  return hashDeckSemanticPayload(payload);
}

export function verifyContentLock(fingerprint, stored) {
  if (!stored || !fingerprint) {
    return { ok: false, reason: "missing-fingerprint-or-stored-lock" };
  }
  if (fingerprint.version !== stored.version) {
    return {
      ok: false,
      reason: "version-mismatch",
      expected: stored.version,
      actual: fingerprint.version,
    };
  }
  if (fingerprint.slideCount !== stored.slideCount) {
    return {
      ok: false,
      reason: "slide-count-changed",
      expected: stored.slideCount,
      actual: fingerprint.slideCount,
    };
  }
  if (fingerprint.compositeHash !== stored.compositeHash) {
    const diffs = [];
    if (fingerprint.contentHash !== stored.contentHash) diffs.push("contentHash");
    if (fingerprint.notesHash !== stored.notesHash) diffs.push("notesHash");
    if (fingerprint.manifestHash !== stored.manifestHash) diffs.push("manifestHash");
    if (JSON.stringify(fingerprint.slideHashes) !== JSON.stringify(stored.slideHashes)) {
      diffs.push("slideHashes");
    }
    return {
      ok: false,
      reason: "content-changed",
      diffs: diffs.length ? diffs : ["compositeHash"],
    };
  }
  return { ok: true };
}

// ---- Frozen content-identity continuity (v1 identity vs live v2) ----
// Content Lock v4 fingerprints were computed from the v1 manifest's semantic
// fields. The explicit v1→v2 migration rewrites manifest.json structurally, so
// migrated decks verify against the frozen contentIdentityManifest recorded in
// the deterministic migration report. For that verification to actually govern
// the live deck, the live v2 manifest must agree with the frozen v1 identity on
// every content-bearing field. This module is the single source of that
// continuity rule: lock-update, the migrate command, and tests all call it so
// they cannot drift.

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export const CONTENT_IDENTITY_LIVE_SCHEMA = "lattice.deck.v2";

export const CONTENT_IDENTITY_IDENTITY_SCHEMA = "lattice.deck.v1";

// Semantic, content-bearing manifest fields shared between v1 and v2. Theme is
// presentation state for the fingerprint itself, but it is still frozen deck
// identity: a migrated deck must not silently retheme. Runtime/assets/entry/
// canvas/fps/routes are structural or explicitly non-semantic and are excluded.
export const CONTENT_IDENTITY_FIELDS = Object.freeze([
  "id",
  "title",
  "owner",
  "presenter",
  "theme",
  "description",
  "sources",
  "references",
]);

function fieldDiffs(identity, liveManifest) {
  const diffs = [];
  for (const field of CONTENT_IDENTITY_FIELDS) {
    const identityValue = identity[field];
    const liveValue = liveManifest[field];
    if (identityValue === undefined && liveValue === undefined) continue;
    if (identityValue === undefined || liveValue === undefined) {
      diffs.push(field);
      continue;
    }
    if (stableStringify(identityValue) !== stableStringify(liveValue)) diffs.push(field);
  }
  return diffs;
}

// Conservative deterministic publication mapping. A v1 deck without
// publication metadata must land on exactly { audience: "private" } — never a
// widened variant, never extra keys. A v1 deck WITH publication metadata must
// keep it byte-for-byte (semantically): migration may not overwrite it.
export function publicationContinuityDiff(identity, liveManifest) {
  const identityPublication = identity.publication;
  const livePublication = liveManifest.publication;
  if (identityPublication === undefined) {
    const expected = stableStringify({ audience: "private" });
    if (livePublication === undefined || stableStringify(livePublication) !== expected) {
      return "publication (v1 had none; v2 must be exactly { audience: \"private\" })";
    }
    return null;
  }
  if (livePublication === undefined || stableStringify(identityPublication) !== stableStringify(livePublication)) {
    return "publication (v1 publication metadata must be preserved, not overwritten)";
  }
  return null;
}

/**
 * Full frozen semantic continuity check between the frozen v1 identity and the
 * live v2 manifest. Returns the list of continuity violations (empty = ok).
 */
export function contentIdentityContinuityDiffs(identity, liveManifest) {
  if (!isPlainObject(identity) || !isPlainObject(liveManifest)) {
    return ["identity and live manifest must be JSON objects"];
  }
  const diffs = fieldDiffs(identity, liveManifest);
  const publicationDiff = publicationContinuityDiff(identity, liveManifest);
  if (publicationDiff) diffs.push(publicationDiff);
  return diffs;
}

/**
 * Resolve the manifest a Content Lock must be verified against.
 *
 * - No migration report (or none for this deck) → verify against the live
 *   manifest, exactly like decks that were never migrated.
 * - A migration report that is present but not a valid v1 report for this
 *   deck, or whose frozen identity disagrees with the live v2 manifest on any
 *   content-bearing field → ok:false. Verification must never silently
 *   proceed against a drifted identity.
 */
export function resolveContentIdentityManifest({ liveManifest, migrationReport, deckId = "" } = {}) {
  if (!isPlainObject(liveManifest)) {
    return { ok: false, reason: "invalid-live-manifest", diffs: [], manifest: null };
  }
  if (migrationReport === undefined || migrationReport === null) {
    return { ok: true, manifest: liveManifest, diffs: [], identityUsed: false };
  }
  if (!isPlainObject(migrationReport)) {
    return { ok: false, reason: "invalid-migration-report", diffs: [], manifest: null };
  }
  if (
    migrationReport.reportSchema !== "lattice.migration-report.v1" ||
    migrationReport.fromSchema !== CONTENT_IDENTITY_IDENTITY_SCHEMA ||
    migrationReport.toSchema !== CONTENT_IDENTITY_LIVE_SCHEMA ||
    !isPlainObject(migrationReport.contentIdentityManifest)
  ) {
    return { ok: false, reason: "invalid-migration-report", diffs: [], manifest: null };
  }
  if (deckId && migrationReport.deckId !== deckId) {
    return { ok: false, reason: "migration-report-deck-mismatch", diffs: [], manifest: null };
  }
  const identity = migrationReport.contentIdentityManifest;
  if (identity.schema !== CONTENT_IDENTITY_IDENTITY_SCHEMA) {
    return { ok: false, reason: "migration-report-identity-not-v1", diffs: [], manifest: null };
  }
  if (liveManifest.schema !== CONTENT_IDENTITY_LIVE_SCHEMA) {
    return { ok: false, reason: "live-manifest-not-v2", diffs: [], manifest: null };
  }
  const diffs = contentIdentityContinuityDiffs(identity, liveManifest);
  if (diffs.length > 0) {
    return { ok: false, reason: "content-identity-continuity-failed", diffs, manifest: null };
  }
  return { ok: true, manifest: identity, diffs: [], identityUsed: true };
}

export function createContentLockRecord(content, manifest, notes, slideOutputs, meta = {}) {
  const fingerprint = computeContentFingerprint(content, manifest, notes, slideOutputs);
  return {
    schema: CONTENT_LOCK_SCHEMA,
    deckId: (manifest && manifest.id) || meta.deckId || "unknown",
    createdAt: new Date().toISOString(),
    ...meta,
    fingerprint,
  };
}

export function formatContentLockDiff(fingerprint, stored) {
  if (!stored) return { added: [], removed: [], changed: [], note: "no stored lock to compare" };
  const lines = [];
  if (fingerprint.contentHash !== stored.contentHash) lines.push("contentHash");
  if (fingerprint.notesHash !== stored.notesHash) lines.push("notesHash");
  if (fingerprint.manifestHash !== stored.manifestHash) lines.push("manifestHash");
  if (JSON.stringify(fingerprint.slideHashes) !== JSON.stringify(stored.slideHashes)) lines.push("slideHashes");
  return {
    added: [],
    removed: [],
    changed: lines,
    note: lines.length ? "content fingerprints differ" : "fingerprints match",
  };
}
