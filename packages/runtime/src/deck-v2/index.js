/*
 * lattice.deck.v2 — canonical Deck/Slide contracts for M1.
 *
 * Canonical time is the integer frame. Nothing in this module accepts
 * backend seconds, fractional frames, or non-finite values, and the closed
 * structural schemas below reject backend-specific fields outright
 * (A07/A09). V1 sources are never upgraded here: loading a v1 deck through
 * this module fails with explicit migration guidance (A08).
 */

import { isRuntimeCompatible } from "../deck/index.js";

export const DECK_SCHEMA_V2 = "lattice.deck.v2";

export const PUBLICATION_AUDIENCES = ["private", "internal", "public"];

export const STOP_NAVIGATION_MODES = ["jump", "play"];

export const FRAME_ADDRESS_VARIABLES = Object.freeze([
  "--lattice-local-frame",
  "--lattice-duration-frames",
  "--lattice-stop-index",
  "--lattice-stop-frame",
  "--lattice-stop-span",
  "--lattice-stop-frame-offset",
]);

const SLIDE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

// Backend time units are forbidden in canonical source: adapters convert at
// the boundary, never the deck. Any structural key from the seconds family is
// rejected so seconds can never re-enter the canonical model unnoticed.
const FORBIDDEN_TIME_KEY_TOKENS = new Set([
  "second",
  "seconds",
  "millis",
  "millisecond",
  "milliseconds",
  "ms",
]);

function structuralKeyTokens(key) {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function usesBackendTimeUnit(key) {
  const tokens = structuralKeyTokens(key);
  if (tokens.some((token) => FORBIDDEN_TIME_KEY_TOKENS.has(token))) return true;

  // Preserve the historical duration_s / time_us rejection while also
  // covering their camelCase forms (durationS / timeUs). A bare "s" or
  // "us" is only a time unit when the same key carries explicit time
  // semantics, avoiding false positives such as fps.
  const hasTimeContext = tokens.some((token) => ["duration", "time", "delay", "offset"].includes(token));
  return hasTimeContext && tokens.some((token) => token === "s" || token === "us");
}

const MANIFEST_KNOWN_FIELDS = new Set([
  "schema",
  "id",
  "title",
  "theme",
  "canvas",
  "fps",
  "entry",
  "publication",
  "routes",
  "videoProfiles",
  "owner",
  "presenter",
  "runtime",
  "assets",
  "description",
  "sources",
  "references",
]);

const ENTRY_KNOWN_FIELDS = new Set([
  "slides",
  "content",
  "layout",
  "notes",
  "sources",
  "references",
]);

const SLIDE_KNOWN_FIELDS = new Set([
  "id",
  "html",
  "durationFrames",
  "stops",
  "notes",
  "inputProps",
]);

const STOP_KNOWN_FIELDS = new Set(["id", "frame", "navigation"]);

// videoProfiles is engine-neutral policy: route selection plus audio/codec/
// size/frame-rate hints. Backend-specific structural keys (Remotion,
// HyperFrames) and backend time units are rejected anywhere inside it so
// adapters convert at the boundary instead of decks embedding backend shapes.
const VIDEO_PROFILE_KNOWN_FIELDS = new Set(["route", "audio", "codec", "width", "height", "fps"]);

const BACKEND_SPECIFIC_KEY_PATTERN = /(remotion|hyperframes)/i;

export function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIntegerFrame(value) {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

export function isStableDeckId(value) {
  return typeof value === "string" && value !== "" && SLIDE_ID_PATTERN.test(value);
}

function describeValue(value) {
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") return String(value);
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

export function formatFrameAddress(address) {
  if (!isFrameAddress(address)) return String(address);
  return `${address.slideId}#${address.localFrame}`;
}

export function isFrameAddress(value) {
  return (
    isPlainObject(value) &&
    Object.getPrototypeOf(value ?? {}) === Object.prototype &&
    typeof value.slideId === "string" &&
    value.slideId !== "" &&
    isIntegerFrame(value.localFrame) &&
    value.localFrame >= 0
  );
}

export function assertFrameAddress(value, { label = "frame address" } = {}) {
  if (!isPlainObject(value) || typeof value !== "object") {
    throw new TypeError(`${label} must be an object { slideId, localFrame }, got ${describeValue(value)}`);
  }
  if (typeof value.slideId !== "string" || value.slideId === "") {
    throw new TypeError(`${label}.slideId must be a non-empty string, got ${describeValue(value.slideId)}`);
  }
  if (!isIntegerFrame(value.localFrame)) {
    throw new TypeError(
      `${label}.localFrame must be a non-negative integer frame, got ${describeValue(value.localFrame)}` +
        (typeof value.localFrame === "number" && !Number.isInteger(value.localFrame) ? " (fractional frames are not canonical)" : ""),
    );
  }
  if (value.localFrame < 0) {
    throw new TypeError(`${label}.localFrame must be >= 0, got ${value.localFrame}`);
  }
  return Object.freeze({ slideId: value.slideId, localFrame: value.localFrame });
}

export function createFrameAddress(slideId, localFrame) {
  return assertFrameAddress({ slideId, localFrame });
}

function issue(type, message, { slide = null, area = null, element = null, ...details } = {}) {
  return { type, slide, area, element, ...details, message };
}

function checkForbiddenTimeKey(key, location, errors, type = "backend-time-unit") {
  if (usesBackendTimeUnit(key)) {
    errors.push(issue(
      type,
      `${location}: field "${key}" uses backend time units; lattice.deck.v2 is integer-frame only (use frame-valued fields such as durationFrames/stop.frame)`,
      { element: location },
    ));
    return true;
  }
  return false;
}

export function validateStop(stop, { slideId, index, durationFrames } = {}) {
  const errors = [];
  const location = `slides[${JSON.stringify(slideId)}].stops[${index}]`;
  if (!isPlainObject(stop)) {
    errors.push(issue("invalid-stop", `${location} must be an object, got ${describeValue(stop)}`, { slide: slideId, element: location }));
    return errors;
  }
  for (const key of Object.keys(stop)) {
    if (!STOP_KNOWN_FIELDS.has(key)) {
      if (checkForbiddenTimeKey(key, `${location}.${key}`, errors, "backend-time-unit")) continue;
      errors.push(issue("unknown-stop-field", `${location}: unknown field "${key}" (allowed: id, frame, navigation)`, { slide: slideId, element: `${location}.${key}` }));
    }
  }
  if (typeof stop.id !== "string" || stop.id === "") {
    errors.push(issue("invalid-stop", `${location}.id must be a non-empty string, got ${describeValue(stop.id)}`, { slide: slideId, element: `${location}.id` }));
  } else if (!SLIDE_ID_PATTERN.test(stop.id)) {
    errors.push(issue("invalid-stop", `${location}.id "${stop.id}" must be a stable slug (lowercase letters, digits, hyphens)`, { slide: slideId, element: `${location}.id` }));
  }
  if (!isIntegerFrame(stop.frame)) {
    errors.push(issue(
      "invalid-frame",
      `${location}.frame must be an integer frame, got ${describeValue(stop.frame)}` +
        (typeof stop.frame === "number" && Number.isFinite(stop.frame) ? " (fractional frames are not canonical)" : ""),
      { slide: slideId, element: `${location}.frame` },
    ));
  } else if (stop.frame < 0) {
    errors.push(issue("invalid-frame", `${location}.frame must be >= 0, got ${stop.frame}`, { slide: slideId, element: `${location}.frame` }));
  } else if (Number.isInteger(durationFrames) && stop.frame > durationFrames - 1) {
    errors.push(issue(
      "invalid-frame",
      `${location}.frame ${stop.frame} is outside [0, durationFrames - 1] (${durationFrames - 1})`,
      { slide: slideId, element: `${location}.frame` },
    ));
  }
  if (stop.navigation !== undefined && !STOP_NAVIGATION_MODES.includes(stop.navigation)) {
    errors.push(issue(
      "invalid-stop",
      `${location}.navigation must be one of ${JSON.stringify(STOP_NAVIGATION_MODES)}, got ${describeValue(stop.navigation)}`,
      { slide: slideId, element: `${location}.navigation` },
    ));
  }
  return errors;
}

export function validateSlideDefinition(slide, { index = 0 } = {}) {
  const errors = [];
  const location = `slides[${index}]`;
  if (!isPlainObject(slide)) {
    errors.push(issue("invalid-slide-definition", `${location} must be an object, got ${describeValue(slide)}`, { element: location }));
    return { errors, stopIds: [] };
  }
  for (const key of Object.keys(slide)) {
    if (!SLIDE_KNOWN_FIELDS.has(key)) {
      if (checkForbiddenTimeKey(key, `${location}.${key}`, errors)) continue;
      errors.push(issue(
        "unknown-slide-field",
        `${location}: unknown field "${key}" (allowed: id, html, durationFrames, stops, notes, inputProps)`,
        { element: `${location}.${key}` },
      ));
    }
  }
  if (typeof slide.id !== "string" || slide.id === "") {
    errors.push(issue("invalid-slide-definition", `${location}.id must be a non-empty string, got ${describeValue(slide.id)}`, { element: `${location}.id` }));
  } else if (!SLIDE_ID_PATTERN.test(slide.id)) {
    errors.push(issue("invalid-slide-definition", `${location}.id "${slide.id}" must be a stable slug (lowercase letters, digits, hyphens)`, { element: `${location}.id` }));
  }
  if (typeof slide.html !== "string" && typeof slide.html !== "function") {
    errors.push(issue(
      "invalid-slide-definition",
      `${location}.html must be an HTML string or a () => string function, got ${describeValue(slide.html)}`,
      { element: `${location}.html` },
    ));
  }
  if (!isIntegerFrame(slide.durationFrames)) {
    errors.push(issue(
      "invalid-frame",
      `${location}.durationFrames must be a positive integer frame, got ${describeValue(slide.durationFrames)}` +
        (typeof slide.durationFrames === "number" && Number.isFinite(slide.durationFrames) ? " (fractional frames are not canonical)" : ""),
      { element: `${location}.durationFrames` },
    ));
  } else if (slide.durationFrames <= 0) {
    errors.push(issue("invalid-frame", `${location}.durationFrames must be positive, got ${slide.durationFrames}`, { element: `${location}.durationFrames` }));
  }
  if (slide.notes !== undefined && typeof slide.notes !== "string") {
    errors.push(issue("invalid-slide-definition", `${location}.notes must be a string when present, got ${describeValue(slide.notes)}`, { element: `${location}.notes` }));
  }
  if (slide.inputProps !== undefined && !isPlainObject(slide.inputProps)) {
    errors.push(issue("invalid-slide-definition", `${location}.inputProps must be a plain object when present, got ${describeValue(slide.inputProps)}`, { element: `${location}.inputProps` }));
  }

  const stopIds = [];
  if (!Array.isArray(slide.stops) || slide.stops.length === 0) {
    errors.push(issue(
      "invalid-stop",
      `${location}.stops must be a non-empty array (a static slide still declares one stop, usually frame 0)`,
      { element: `${location}.stops` },
    ));
  } else {
    const seenStopIds = new Set();
    let previousFrame = -1;
    slide.stops.forEach((stop, stopIndex) => {
      const stopErrors = validateStop(stop, { slideId: typeof slide.id === "string" ? slide.id : `#${index}`, index: stopIndex, durationFrames: slide.durationFrames });
      errors.push(...stopErrors);
      if (isPlainObject(stop) && typeof stop.id === "string" && stop.id !== "") {
        if (seenStopIds.has(stop.id)) {
          errors.push(issue(
            "duplicate-stop-id",
            `${location}.stops[${stopIndex}].id "${stop.id}" duplicates an earlier stop id`,
            { element: `${location}.stops[${stopIndex}].id` },
          ));
        }
        seenStopIds.add(stop.id);
        stopIds.push(stop.id);
      }
      if (isIntegerFrame(stop?.frame)) {
        if (stop.frame <= previousFrame) {
          errors.push(issue(
            "invalid-stop",
            `${location}.stops[${stopIndex}].frame ${stop.frame} must be strictly increasing (previous stop frame ${previousFrame})`,
            { element: `${location}.stops[${stopIndex}].frame` },
          ));
        }
        previousFrame = stop.frame;
      }
    });
  }
  return { ok: errors.length === 0, errors, stopIds };
}

export function validateSlideDefinitions(slides, { knownIds = null } = {}) {
  const errors = [];
  if (!Array.isArray(slides) || slides.length === 0) {
    errors.push(issue("invalid-slide-definition", "slide definitions must be a non-empty array"));
    return { ok: false, errors, slideIds: [] };
  }
  const slideIds = [];
  const seen = new Set();
  slides.forEach((slide, index) => {
    const { errors: slideErrors } = validateSlideDefinition(slide, { index });
    errors.push(...slideErrors);
    if (isPlainObject(slide) && typeof slide.id === "string" && slide.id !== "") {
      if (seen.has(slide.id)) {
        errors.push(issue(
          "duplicate-slide-id",
          `slides[${index}].id "${slide.id}" duplicates an earlier slide id in this deck`,
          { slide: slide.id, element: `slides[${index}].id` },
        ));
      }
      seen.add(slide.id);
      slideIds.push(slide.id);
    }
  });
  if (Array.isArray(knownIds)) {
    for (const id of slideIds) {
      if (!knownIds.includes(id)) {
        errors.push(issue(
          "unknown-slide-id",
          `slide definition id "${id}" is not part of the deck's declared slide set`,
          { slide: id, element: "slides" },
        ));
      }
    }
  }
  return { ok: errors.length === 0, errors, slideIds };
}

function validateCanvas(canvas, errors) {
  if (!isPlainObject(canvas)) {
    errors.push(issue("invalid-canvas", "manifest.canvas must be an object { width, height }", { element: "manifest.canvas" }));
    return;
  }
  for (const key of ["width", "height"]) {
    const value = canvas[key];
    if (!isIntegerFrame(value) || value <= 0) {
      errors.push(issue(
        "invalid-canvas",
        `manifest.canvas.${key} must be a positive integer, got ${describeValue(value)}` +
          (typeof value === "number" && Number.isFinite(value) ? " (fractional canvas values are not canonical)" : ""),
        { element: `manifest.canvas.${key}` },
      ));
    }
  }
  for (const key of Object.keys(canvas)) {
    if (!["width", "height"].includes(key)) {
      errors.push(issue("unknown-canvas-field", `manifest.canvas: unknown field "${key}"`, { element: `manifest.canvas.${key}` }));
    }
  }
}

function validatePublication(publication, errors) {
  if (!isPlainObject(publication)) {
    errors.push(issue(
      "invalid-publication",
      "manifest.publication is required and must be an object with an audience field (private | internal | public)",
      { element: "manifest.publication" },
    ));
    return;
  }
  for (const key of Object.keys(publication)) {
    if (!["audience", "rights", "presenter", "organization", "date"].includes(key)) {
      errors.push(issue("unknown-publication-field", `manifest.publication: unknown field "${key}"`, { element: `manifest.publication.${key}` }));
    }
  }
  if (!PUBLICATION_AUDIENCES.includes(publication.audience)) {
    errors.push(issue(
      "invalid-publication",
      `manifest.publication.audience must be one of ${JSON.stringify(PUBLICATION_AUDIENCES)}, got ${describeValue(publication.audience)}`,
      { element: "manifest.publication.audience" },
    ));
    return;
  }
  if (publication.audience === "public") {
    for (const key of ["presenter", "organization", "date", "rights"]) {
      if (typeof publication[key] !== "string" || publication[key] === "") {
        errors.push(issue(
          "invalid-publication",
          `manifest.publication.${key} is required for a public deck`,
          { element: `manifest.publication.${key}` },
        ));
      }
    }
  }
  if (publication.rights !== undefined && (typeof publication.rights !== "string" || publication.rights === "")) {
    errors.push(issue("invalid-publication", "manifest.publication.rights must be a non-empty string when present", { element: "manifest.publication.rights" }));
  }
}

function validateRoutes(routes, errors, { slideIds = null } = {}) {
  if (!isPlainObject(routes)) {
    errors.push(issue(
      "invalid-route",
      'manifest.routes is required and must be an object with at least a "main" route array',
      { element: "manifest.routes" },
    ));
    return;
  }
  const routeKeys = Object.keys(routes);
  if (!routeKeys.includes("main")) {
    errors.push(issue("invalid-route", 'manifest.routes must define at least the "main" route', { element: "manifest.routes" }));
  }
  for (const key of routeKeys) {
    if (!SLIDE_ID_PATTERN.test(key)) {
      errors.push(issue("invalid-route", `manifest.routes.${key}: route id must be a stable slug`, { element: `manifest.routes.${key}` }));
    }
    const route = routes[key];
    if (!Array.isArray(route) || route.length === 0) {
      errors.push(issue("invalid-route", `manifest.routes.${key} must be a non-empty array of slide ids`, { element: `manifest.routes.${key}` }));
      continue;
    }
    const seen = new Set();
    route.forEach((slideId, index) => {
      const element = `manifest.routes.${key}[${index}]`;
      if (typeof slideId !== "string" || slideId === "") {
        errors.push(issue("invalid-route", `${element} must be a non-empty slide id string, got ${describeValue(slideId)}`, { element }));
        return;
      }
      if (seen.has(slideId)) {
        errors.push(issue("duplicate-route-entry", `${element}: slide id "${slideId}" appears more than once in route "${key}"`, { element }));
      }
      seen.add(slideId);
      if (Array.isArray(slideIds) && !slideIds.includes(slideId)) {
        errors.push(issue(
          "unknown-route-slide",
          `${element}: route "${key}" references unknown slide id "${slideId}"`,
          { slide: slideId, element },
        ));
      }
    });
  }
}

// Walk videoProfiles values (objects/arrays) and reject backend time units or
// backend-specific structural KEYS at any depth. String values are never
// scanned: business HTML and inputProps payloads are content, not structure.
function collectForbiddenVideoProfileKeys(value, location, errors) {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => collectForbiddenVideoProfileKeys(entry, `${location}[${index}]`, errors));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, nested] of Object.entries(value)) {
    const nestedLocation = `${location}.${key}`;
    if (checkForbiddenTimeKey(key, nestedLocation, errors, "backend-time-unit")) continue;
    if (BACKEND_SPECIFIC_KEY_PATTERN.test(key)) {
      errors.push(issue(
        "backend-specific-video-profile-field",
        `${nestedLocation}: field "${key}" is backend-specific (Remotion/HyperFrames); videoProfiles must stay engine-neutral`,
        { element: nestedLocation },
      ));
      continue;
    }
    collectForbiddenVideoProfileKeys(nested, nestedLocation, errors);
  }
}

function rejectForbiddenVideoProfileKey(key, location, errors) {
  if (checkForbiddenTimeKey(key, location, errors, "backend-time-unit")) return;
  if (BACKEND_SPECIFIC_KEY_PATTERN.test(key)) {
    errors.push(issue(
      "backend-specific-video-profile-field",
      `${location}: field "${key}" is backend-specific (Remotion/HyperFrames); videoProfiles must stay engine-neutral`,
      { element: location },
    ));
    return;
  }
  errors.push(issue(
    "unknown-video-profile-field",
    `${location}: unknown field "${key}" (allowed: route, audio, codec, width, height, fps; no backend time units)`,
    { element: location },
  ));
}

function validateVideoProfiles(videoProfiles, errors, { routeIds = null } = {}) {
  if (!isPlainObject(videoProfiles)) {
    errors.push(issue("invalid-video-profile", "manifest.videoProfiles must be an object when present", { element: "manifest.videoProfiles" }));
    return;
  }
  for (const [name, profile] of Object.entries(videoProfiles)) {
    const element = `manifest.videoProfiles.${name}`;
    checkForbiddenTimeKey(name, element, errors, "backend-time-unit");
    if (BACKEND_SPECIFIC_KEY_PATTERN.test(name)) {
      errors.push(issue(
        "backend-specific-video-profile-field",
        `${element}: profile name "${name}" is backend-specific (Remotion/HyperFrames); videoProfiles must stay engine-neutral`,
        { element },
      ));
    }
    if (!isPlainObject(profile)) {
      errors.push(issue("invalid-video-profile", `${element} must be an object`, { element }));
      continue;
    }
    for (const key of Object.keys(profile)) {
      if (!VIDEO_PROFILE_KNOWN_FIELDS.has(key)) rejectForbiddenVideoProfileKey(key, `${element}.${key}`, errors);
    }
    for (const [key, value] of Object.entries(profile)) {
      collectForbiddenVideoProfileKeys(value, `${element}.${key}`, errors);
    }
    if (profile.route !== undefined) {
      if (typeof profile.route !== "string" || profile.route === "") {
        errors.push(issue("invalid-video-profile", `${element}.route must be a non-empty route id`, { element: `${element}.route` }));
      } else if (Array.isArray(routeIds) && !routeIds.includes(profile.route)) {
        errors.push(issue("invalid-video-profile", `${element}.route references unknown route "${profile.route}"`, { element: `${element}.route` }));
      }
    }
    for (const key of ["width", "height", "fps"]) {
      const value = profile[key];
      if (value !== undefined && (!isIntegerFrame(value) || value <= 0)) {
        errors.push(issue("invalid-video-profile", `${element}.${key} must be a positive integer when present, got ${describeValue(value)}`, { element: `${element}.${key}` }));
      }
    }
  }
}

export function validateDeckManifestV2(manifest, { expectedId = "", slideIds = null, runtimeVersion = null } = {}) {
  const errors = [];
  if (!isPlainObject(manifest)) {
    return { ok: false, errors: [issue("invalid-manifest", "manifest must be a JSON object")] };
  }
  for (const key of Object.keys(manifest)) {
    if (!MANIFEST_KNOWN_FIELDS.has(key)) {
      errors.push(issue(
        "unknown-manifest-field",
        `manifest: unknown field "${key}" for ${DECK_SCHEMA_V2}; run the explicit v1→v2 migration for v1 sources`,
        { element: `manifest.${key}` },
      ));
    }
  }
  if (manifest.schema !== DECK_SCHEMA_V2) {
    errors.push(issue(
      "schema-mismatch",
      manifest.schema === "lattice.deck.v1"
        ? `deck schema is "lattice.deck.v1"; the v2 loader does not silently upgrade v1 sources — run the explicit v1→v2 migration (lattice migrate)`
        : `unsupported deck schema: ${describeValue(manifest.schema)} (expected ${DECK_SCHEMA_V2})`,
      { element: "manifest.schema" },
    ));
  }
  if (typeof manifest.id !== "string" || manifest.id === "") {
    errors.push(issue("invalid-manifest", "manifest.id must be a non-empty string", { element: "manifest.id" }));
  } else {
    if (!isStableDeckId(manifest.id)) {
      errors.push(issue("invalid-manifest", `manifest.id "${manifest.id}" must be a stable slug (lowercase letters, digits, hyphens)`, { element: "manifest.id" }));
    }
    if (expectedId && manifest.id !== expectedId) {
      errors.push(issue(
        "invalid-manifest",
        `manifest.id "${manifest.id}" does not match deck directory "${expectedId}"`,
        { slide: manifest.id, element: "manifest.id" },
      ));
    }
  }
  if (typeof manifest.title !== "string" || manifest.title === "") {
    errors.push(issue("invalid-manifest", "manifest.title must be a non-empty string", { element: "manifest.title" }));
  }
  if (typeof manifest.theme !== "string" || manifest.theme === "") {
    errors.push(issue("invalid-manifest", "manifest.theme must be a non-empty string", { element: "manifest.theme" }));
  }
  if (manifest.canvas === undefined) {
    errors.push(issue("invalid-canvas", "manifest.canvas is required ({ width, height } in integer pixels)", { element: "manifest.canvas" }));
  } else {
    validateCanvas(manifest.canvas, errors);
  }
  if (!isIntegerFrame(manifest.fps) || manifest.fps <= 0) {
    errors.push(issue(
      "invalid-fps",
      `manifest.fps must be a positive integer (the canonical frame rate all frames are interpreted with), got ${describeValue(manifest.fps)}`,
      { element: "manifest.fps" },
    ));
  }
  const entry = manifest.entry;
  if (!isPlainObject(entry)) {
    errors.push(issue("invalid-manifest", "manifest.entry is required and must map canonical entries (at least slides) to paths", { element: "manifest.entry" }));
  } else {
    for (const key of Object.keys(entry)) {
      if (!ENTRY_KNOWN_FIELDS.has(key)) {
        errors.push(issue("unknown-entry-field", `manifest.entry: unknown entry "${key}"`, { element: `manifest.entry.${key}` }));
      } else if (typeof entry[key] !== "string" || entry[key] === "") {
        errors.push(issue("invalid-manifest", `manifest.entry.${key} must be a non-empty path string`, { element: `manifest.entry.${key}` }));
      }
    }
    if (typeof entry.slides !== "string" || entry.slides === "") {
      errors.push(issue("invalid-manifest", "manifest.entry.slides is required (path to the deck's slide definitions module)", { element: "manifest.entry.slides" }));
    }
  }
  if (manifest.publication === undefined) {
    errors.push(issue("invalid-publication", "manifest.publication is required (audience private | internal | public, plus rights for public decks)", { element: "manifest.publication" }));
  } else {
    validatePublication(manifest.publication, errors);
  }
  if (manifest.routes === undefined) {
    errors.push(issue("invalid-route", 'manifest.routes is required (at least { main: [...] } referencing stable slide ids)', { element: "manifest.routes" }));
  } else {
    validateRoutes(manifest.routes, errors, { slideIds });
  }
  if (manifest.videoProfiles !== undefined) {
    validateVideoProfiles(manifest.videoProfiles, errors, {
      routeIds: isPlainObject(manifest.routes) ? Object.keys(manifest.routes) : null,
    });
  }
  if (manifest.runtime !== undefined && typeof manifest.runtime !== "string") {
    errors.push(issue("invalid-manifest", "manifest.runtime must be a version range string when present", { element: "manifest.runtime" }));
  }
  if (manifest.assets !== undefined && (typeof manifest.assets !== "string" || manifest.assets === "")) {
    errors.push(issue("invalid-manifest", "manifest.assets must be a non-empty path string when present", { element: "manifest.assets" }));
  }
  if (manifest.description !== undefined && typeof manifest.description !== "string") {
    errors.push(issue("invalid-manifest", "manifest.description must be a string when present", { element: "manifest.description" }));
  }
  if (manifest.sources !== undefined && !isPlainObject(manifest.sources)) {
    errors.push(issue("invalid-manifest", "manifest.sources must be an object when present", { element: "manifest.sources" }));
  }
  if (manifest.references !== undefined && !isPlainObject(manifest.references)) {
    errors.push(issue("invalid-manifest", "manifest.references must be an object when present", { element: "manifest.references" }));
  }
  if (runtimeVersion && typeof manifest.runtime === "string" && manifest.runtime !== "") {
    // Runtime compatibility shares the v1 range semantics; one implementation.
    if (!isRuntimeCompatible(manifest.runtime, runtimeVersion)) {
      errors.push(issue(
        "runtime-incompatible",
        `deck requires runtime ${manifest.runtime} but installed runtime is ${runtimeVersion}`,
        { element: "manifest.runtime" },
      ));
    }
  }
  return { ok: errors.length === 0, errors };
}

export async function loadDeckV2(deckDir, { importModule = defaultImportModule, runtimeVersion = null } = {}) {
  const path = await import("node:path");
  const fs = await import("node:fs/promises");
  const manifestPath = path.join(deckDir, "manifest.json");
  const deckId = path.basename(path.resolve(deckDir));

  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      errors: [issue("missing-manifest", `cannot read ${manifestPath}: ${error.message}`, { element: "manifest" })],
    };
  }

  const manifestReport = validateDeckManifestV2(manifest, { expectedId: deckId, runtimeVersion });
  if (!manifestReport.ok) {
    return { ok: false, errors: manifestReport.errors, manifest };
  }

  const slidesEntryPath = path.resolve(deckDir, manifest.entry.slides);
  let slideModule;
  try {
    slideModule = await importModule(slidesEntryPath);
  } catch (error) {
    return {
      ok: false,
      errors: [issue(
        "entry-import-failed",
        `cannot import manifest.entry.slides ${manifest.entry.slides} (${slidesEntryPath}): ${error.message}`,
        { slide: deckId, element: "manifest.entry.slides" },
      )],
      manifest,
    };
  }

  const slideDefinitions = slideModule?.slideDefinitions;
  if (!Array.isArray(slideDefinitions)) {
    return {
      ok: false,
      errors: [issue(
        "invalid-slide-entry",
        `manifest.entry.slides ${manifest.entry.slides} must export a "slideDefinitions" array (lattice.deck.v2 slide contract)`,
        { slide: deckId, element: "manifest.entry.slides" },
      )],
      manifest,
    };
  }

  const slideIds = slideDefinitions.map((slide) => (isPlainObject(slide) && typeof slide.id === "string" ? slide.id : null));
  const definitionsReport = validateSlideDefinitions(slideDefinitions);
  const manifestReportWithClosure = validateDeckManifestV2(manifest, {
    expectedId: deckId,
    slideIds: slideIds.filter((id) => id !== null),
    runtimeVersion,
  });
  const errors = [...manifestReportWithClosure.errors, ...definitionsReport.errors];
  if (errors.length > 0) {
    return { ok: false, errors, manifest, slides: slideDefinitions };
  }

  return {
    ok: true,
    errors: [],
    manifest,
    slides: slideDefinitions,
    routes: manifest.routes,
    slidesEntryPath,
  };
}

async function defaultImportModule(modulePath) {
  return import(modulePath);
}
