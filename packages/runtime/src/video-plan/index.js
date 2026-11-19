import { createHash } from "node:crypto";

export const VIDEO_PLAN_SCHEMA = "lattice.video-plan.v1";

// M7: plans compiled from a deck that declares a lattice.timeline.v1 carry
// the stop schedule (and optional animation declaration) per clip under a
// versioned schema. Plans without timeline data keep the v1 schema and byte
// layout exactly.
export const VIDEO_PLAN_SCHEMA_V2 = "lattice.video-plan.v2";

const JSON_UNSAFE_TYPES = new Set(["undefined", "function", "symbol", "bigint"]);

function isJsonSafe(value, path = "$", ancestors = new Set(), skip = null) {
  if (skip !== null && skip.has(value)) return { ok: true };
  if (value === null) return { ok: true };
  const type = typeof value;
  if (JSON_UNSAFE_TYPES.has(type)) {
    return { ok: false, reason: `non-JSON-safe ${type} at ${path}` };
  }
  if (type === "number") {
    if (Number.isNaN(value)) return { ok: false, reason: `non-JSON-safe NaN at ${path}` };
    if (!Number.isFinite(value)) return { ok: false, reason: `non-JSON-safe ${value > 0 ? "Infinity" : "-Infinity"} at ${path}` };
  }
  if (type !== "object") return { ok: true };
  // Only ancestor cycles are rejected. Shared, non-cyclic references appear
  // once per branch of the DFS chain and are allowed.
  if (ancestors.has(value)) {
    return { ok: false, reason: `cyclic reference detected at ${path}` };
  }
  if (Array.isArray(value)) {
    // Arrays follow the same boundary rules as plain objects: a replaced or
    // missing prototype breaks canonical array serialization (value.map), and
    // own symbol-keyed properties would be silently dropped by it.
    const arrayProto = Object.getPrototypeOf(value);
    if (arrayProto !== Array.prototype) {
      return { ok: false, reason: `unsupported prototype at ${path}` };
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      return { ok: false, reason: `symbol-keyed property at ${path}` };
    }
    ancestors.add(value);
    try {
      for (let i = 0; i < value.length; i++) {
        if (!(i in value)) {
          return { ok: false, reason: `sparse array at ${path}[${i}]` };
        }
        const r = isJsonSafe(value[i], `${path}[${i}]`, ancestors, skip);
        if (!r.ok) return r;
      }
    } finally {
      ancestors.delete(value);
    }
    return { ok: true };
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== null && proto !== Object.prototype) {
    return { ok: false, reason: `unsupported prototype at ${path}` };
  }
  if (Object.getOwnPropertySymbols(value).length > 0) {
    return { ok: false, reason: `symbol-keyed property at ${path}` };
  }
  ancestors.add(value);
  try {
    for (const key of Object.keys(value)) {
      const r = isJsonSafe(value[key], `${path}.${key}`, ancestors, skip);
      if (!r.ok) return r;
    }
  } finally {
    ancestors.delete(value);
  }
  return { ok: true };
}

function stableCanonicalSerialize(value, indent = 2, _seen = new Set()) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (Object.is(value, -0)) return "-0";
    if (Number.isNaN(value) || !Number.isFinite(value)) {
      throw new TypeError(`Cannot serialize non-finite number: ${value}`);
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "undefined" || typeof value === "function" ||
      typeof value === "symbol" || typeof value === "bigint") {
    throw new TypeError(`Cannot serialize non-JSON-safe ${typeof value}`);
  }
  if (typeof value === "object") {
    // Ancestor-cycle tracking: shared non-cyclic references are allowed
    // because entries are removed once their subtree is serialized.
    if (_seen.has(value)) {
      throw new TypeError("Cannot serialize cyclic reference");
    }
    _seen.add(value);
  }
  if (Array.isArray(value)) {
    // Same array boundary rules as isJsonSafe: non-Array prototypes break the
    // value.map serialization below, and own symbol-keyed properties would be
    // silently dropped by it.
    const arrayProto = Object.getPrototypeOf(value);
    if (arrayProto !== Array.prototype) {
      _seen.delete(value);
      throw new TypeError("Cannot serialize non-plain array");
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      _seen.delete(value);
      throw new TypeError("Cannot serialize symbol-keyed properties");
    }
    for (let i = 0; i < value.length; i++) {
      if (!(i in value)) {
        _seen.delete(value);
        throw new TypeError(`Cannot serialize sparse array (hole at index ${i})`);
      }
    }
    if (value.length === 0) {
      _seen.delete(value);
      return "[]";
    }
    const innerIndent = " ".repeat(indent);
    const items = value.map((v) => innerIndent + stableCanonicalSerialize(v, indent + 2, _seen));
    _seen.delete(value);
    return "[\n" + items.join(",\n") + "\n" + " ".repeat(indent - 2) + "]";
  }
  if (typeof value === "object") {
    if (Object.getOwnPropertySymbols(value).length > 0) {
      _seen.delete(value);
      throw new TypeError("Cannot serialize symbol-keyed properties");
    }
    const proto = Object.getPrototypeOf(value);
    if (proto !== null && proto !== Object.prototype) {
      _seen.delete(value);
      throw new TypeError("Cannot serialize non-plain object");
    }
    const keys = Object.keys(value).sort();
    if (keys.length === 0) {
      _seen.delete(value);
      return "{}";
    }
    const innerIndent = " ".repeat(indent);
    const pairs = keys.map((k) =>
      innerIndent +
      JSON.stringify(k) +
      ": " +
      stableCanonicalSerialize(value[k], indent + 2, _seen),
    );
    _seen.delete(value);
    return "{\n" + pairs.join(",\n") + "\n" + " ".repeat(indent - 2) + "}";
  }
  throw new TypeError(`Cannot serialize type: ${typeof value}`);
}

function recursiveDeepEqual(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return a === b;
  if (typeof a === "number") {
    if (Number.isNaN(a) && Number.isNaN(b)) return true;
    if (Object.is(a, -0) && Object.is(b, 0)) return false;
    if (Object.is(a, 0) && Object.is(b, -0)) return false;
    return a === b;
  }
  if (typeof a !== "object") return a === b;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const aEntries = Object.entries(a);
  const bEntries = Object.entries(b);
  if (aEntries.length !== bEntries.length) return false;
  if (Array.isArray(a)) {
    for (let i = 0; i < a.length; i++) {
      if (!recursiveDeepEqual(a[i], b[i])) return false;
    }
    return true;
  }
  for (const [key, val] of aEntries) {
    if (!(key in b)) return false;
    if (!recursiveDeepEqual(val, b[key])) return false;
  }
  return true;
}

export function validateRoute(slides, route) {
  if (!Array.isArray(route) || route.length === 0) {
    return { ok: false, reason: "empty-or-invalid-route" };
  }
  const slideIds = new Set();
  const duplicateIds = [];
  for (const slide of slides) {
    if (!slide || typeof slide !== "object") continue;
    if (typeof slide.id !== "string" || slide.id === "") {
      return { ok: false, reason: "invalid-slide-id", slideId: String(slide.id) };
    }
    if (slideIds.has(slide.id)) {
      duplicateIds.push(slide.id);
    }
    slideIds.add(slide.id);
  }
  if (duplicateIds.length > 0) {
    return { ok: false, reason: "duplicate-slide-definition", slideIds: duplicateIds };
  }
  const seen = new Set();
  for (const slideId of route) {
    if (typeof slideId !== "string" || slideId === "") {
      return { ok: false, reason: "invalid-slideId-in-route", slideId };
    }
    if (!slideIds.has(slideId)) {
      return { ok: false, reason: "unknown-slideId-in-route", slideId };
    }
    if (seen.has(slideId)) {
      return { ok: false, reason: "duplicate-slideId-in-route", slideId };
    }
    seen.add(slideId);
  }
  return { ok: true };
}

export function resolveDeckRoutes(routes) {
  if (!routes || typeof routes !== "object") {
    return { main: [] };
  }
  return routes;
}

function validatePositiveIntegerFrame(value, label) {
  if (typeof value !== "number") {
    return `${label} must be a number, got ${typeof value}`;
  }
  if (!Number.isInteger(value)) {
    return `${label} must be an integer, got ${value}`;
  }
  if (value <= 0) {
    return `${label} must be positive, got ${value}`;
  }
  return null;
}

function validateNonNegativeInteger(value, label) {
  if (typeof value !== "number") {
    return `${label} must be a number, got ${typeof value}`;
  }
  if (!Number.isInteger(value)) {
    return `${label} must be an integer, got ${value}`;
  }
  if (value < 0) {
    return `${label} must not be negative, got ${value}`;
  }
  return null;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Structural validation of a clip's stop schedule (M7 lattice.video-plan.v2).
 * Preset-name validation happens at deck compile time against the theme
 * catalog; the engine-neutral plan contract only enforces shape and frames.
 */
function validateClipStops(stops, durationFrames, label) {
  if (!Array.isArray(stops) || stops.length === 0) {
    return `${label}.stops must be a non-empty array of { id, frame }`;
  }
  let previousFrame = -1;
  const seenIds = new Set();
  for (let index = 0; index < stops.length; index += 1) {
    const stop = stops[index];
    if (!stop || typeof stop !== "object" || Array.isArray(stop)) {
      return `${label}.stops[${index}] must be an object { id, frame }`;
    }
    if (typeof stop.id !== "string" || stop.id === "" || !SLUG_PATTERN.test(stop.id)) {
      return `${label}.stops[${index}].id must be a stable slug, got ${JSON.stringify(stop.id ?? null)}`;
    }
    if (seenIds.has(stop.id)) {
      return `${label}.stops[${index}].id duplicates an earlier stop id: ${stop.id}`;
    }
    seenIds.add(stop.id);
    const frameError = validateNonNegativeInteger(stop.frame, `${label}.stops[${index}].frame`);
    if (frameError) return frameError;
    if (stop.frame <= previousFrame) {
      return `${label}.stops[${index}].frame must be strictly increasing (previous stop frame ${previousFrame})`;
    }
    previousFrame = stop.frame;
    if (stop.frame > durationFrames - 1) {
      return `${label}.stops[${index}].frame ${stop.frame} is outside [0, ${durationFrames - 1}]`;
    }
  }
  return null;
}

function validateClipAnimation(animation, label) {
  if (!animation || typeof animation !== "object" || Array.isArray(animation)) {
    return `${label}.animation must be an object`;
  }
  if (typeof animation.preset !== "string" || animation.preset === "") {
    return `${label}.animation.preset must be a non-empty string (a named preset from the theme catalog)`;
  }
  for (const [key, value] of Object.entries(animation)) {
    if (key === "preset") continue;
    if (key === "direction") {
      if (typeof value !== "string" || value === "") {
        return `${label}.animation.direction must be a non-empty string, got ${JSON.stringify(value ?? null)}`;
      }
      continue;
    }
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
      return `${label}.animation.${key} must be a non-negative integer, got ${JSON.stringify(value ?? null)}`;
    }
  }
  return null;
}

function normalizeClipTimelineFields({ stops, animation }) {
  const entry = {};
  if (stops !== undefined) {
    entry.stops = stops.map((stop) => ({ id: stop.id, frame: stop.frame }));
  }
  if (animation !== undefined) {
    entry.animation = { ...animation };
  }
  return entry;
}

export function compileVideoPlan({
  deckId,
  routeId = "main",
  routes = {},
  slides = [],
  width = 960,
  height = 540,
  fps = 30,
  audioTracks = [],
  inputProps = {},
} = {}) {
  if (typeof deckId !== "string" || deckId === "") {
    return { ok: false, reason: "deckId must be a non-empty string" };
  }
  if (typeof routeId !== "string" || routeId === "") {
    return { ok: false, reason: "routeId must be a non-empty string" };
  }

  if (routes === null || typeof routes !== "object" || Array.isArray(routes)) {
    return { ok: false, reason: "routes must be a plain object mapping route ids to non-empty slide-id arrays" };
  }
  if (!Array.isArray(slides)) {
    return { ok: false, reason: "slides must be an array of slide descriptors" };
  }
  if (!Array.isArray(audioTracks)) {
    return { ok: false, reason: "audioTracks must be an array of audio track descriptors" };
  }
  if (inputProps === null || typeof inputProps !== "object" || Array.isArray(inputProps)) {
    return { ok: false, reason: "inputProps must be a plain JSON object" };
  }

  const err = validatePositiveIntegerFrame(width, "width");
  if (err) return { ok: false, reason: err };
  const err2 = validatePositiveIntegerFrame(height, "height");
  if (err2) return { ok: false, reason: err2 };
  const err3 = validatePositiveIntegerFrame(fps, "fps");
  if (err3) return { ok: false, reason: err3 };

  if (routes[routeId] === undefined) {
    return { ok: false, reason: `unknown-or-empty-route: ${routeId}` };
  }
  const route = routes[routeId];
  if (!Array.isArray(route) || route.length === 0) {
    return { ok: false, reason: `unknown-or-empty-route: ${routeId}` };
  }

  if (routes) {
    const seenRouteKeys = new Set();
    for (const rkey of Object.keys(routes)) {
      if (seenRouteKeys.has(rkey)) {
        return { ok: false, reason: `duplicate-route-definition: ${rkey}` };
      }
      seenRouteKeys.add(rkey);
    }
  }

  const slidesWithIds = (slides || []).filter((s) => s && typeof s === "object");
  const slideIdsSet = new Set();
  for (const slide of slidesWithIds) {
    if (typeof slide.id !== "string" || slide.id === "") {
      return { ok: false, reason: `invalid slide id: ${JSON.stringify(slide.id)}` };
    }
    if (slideIdsSet.has(slide.id)) {
      return { ok: false, reason: `duplicate-slide-definition: ${slide.id}` };
    }
    slideIdsSet.add(slide.id);
  }

  for (const rkey of Object.keys(routes)) {
    const r = routes[rkey];
    if (!Array.isArray(r)) continue;
    const seen = new Set();
    for (const sid of r) {
      if (!slideIdsSet.has(sid)) {
        return { ok: false, reason: `slide-not-found: ${sid} (route ${rkey})` };
      }
      if (seen.has(sid)) {
        return { ok: false, reason: `duplicate-slideId-in-route: ${sid} (route ${rkey})` };
      }
      seen.add(sid);
    }
  }

  const slidesById = Object.fromEntries(
    slidesWithIds.map((s) => [s.id, s]),
  );

  for (const slideId of route) {
    const slide = slidesById[slideId];
    if (!slide) continue;
    const dur = slide.durationFrames;
    const errD = validatePositiveIntegerFrame(dur, `durationFrames for slide ${slideId}`);
    if (errD) {
      return { ok: false, reason: errD };
    }
    if (slide.stops !== undefined) {
      const stopsError = validateClipStops(slide.stops, dur, `slide ${slideId}`);
      if (stopsError) return { ok: false, reason: stopsError };
    }
    if (slide.animation !== undefined) {
      const animationError = validateClipAnimation(slide.animation, `slide ${slideId}`);
      if (animationError) return { ok: false, reason: animationError };
    }
    const slideInputProps = slide.inputProps;
    if (slideInputProps !== undefined && (slideInputProps === null || typeof slideInputProps !== "object" || Array.isArray(slideInputProps))) {
      return {
        ok: false,
        reason: `inputProps for slide ${slideId} must be a plain JSON object, got ${slideInputProps === null ? "null" : Array.isArray(slideInputProps) ? "array" : typeof slideInputProps}`,
      };
    }
  }

  const globalInputPropsSafety = isJsonSafe(inputProps, "$.inputProps");
  if (!globalInputPropsSafety.ok) {
    return { ok: false, reason: `global inputProps: ${globalInputPropsSafety.reason}` };
  }

  const clips = [];
  let currentFrame = 0;
  let hasTimelineData = false;

  for (const slideId of route) {
    const slide = slidesById[slideId];
    const durationFrames = slide.durationFrames;

    const clipInputProps = { ...(slide.inputProps ?? {}), ...inputProps };
    const clipInputPropsSafety = isJsonSafe(clipInputProps, `clip[${slideId}].inputProps`);
    if (!clipInputPropsSafety.ok) {
      return { ok: false, reason: `clip ${slideId} inputProps: ${clipInputPropsSafety.reason}` };
    }

    const clip = {
      slideId,
      startFrame: currentFrame,
      durationFrames,
      source: `slide:${slideId}`,
      inputProps: clipInputProps,
    };
    const timelineFields = normalizeClipTimelineFields(slide);
    if (timelineFields.stops !== undefined) clip.stops = timelineFields.stops;
    if (timelineFields.animation !== undefined) clip.animation = timelineFields.animation;
    if (clip.stops !== undefined || clip.animation !== undefined) hasTimelineData = true;

    clips.push(clip);

    currentFrame += durationFrames;
  }

  const validatedAudioTracks = [];
  const audioTrackIds = new Set();
  for (let i = 0; i < audioTracks.length; i++) {
    const track = audioTracks[i];
    if (!track || typeof track !== "object") {
      return { ok: false, reason: `audioTracks[${i}] is not an object` };
    }
    if (typeof track.id !== "string" || track.id === "") {
      return { ok: false, reason: `audioTracks[${i}] has invalid id` };
    }
    if (typeof track.src !== "string" || track.src === "") {
      return { ok: false, reason: `audioTracks[${i}] has invalid src` };
    }
    const startErr = validateNonNegativeInteger(track.startFrame, `audioTracks[${i}].startFrame`);
    if (startErr) return { ok: false, reason: startErr };

    if (track.durationFrames !== undefined) {
      const durErr = validatePositiveIntegerFrame(track.durationFrames, `audioTracks[${i}].durationFrames`);
      if (durErr) return { ok: false, reason: durErr };
    }

    if (track.volume !== undefined) {
      if (typeof track.volume !== "number" || !Number.isFinite(track.volume) || track.volume < 0) {
        return { ok: false, reason: `audioTracks[${i}].volume must be a finite non-negative number` };
      }
    }

    if (audioTrackIds.has(track.id)) {
      return { ok: false, reason: `audioTracks[${i}] duplicate id: ${track.id}` };
    }
    audioTrackIds.add(track.id);

    const entry = {
      id: track.id,
      src: track.src,
      startFrame: track.startFrame,
    };
    if (track.durationFrames !== undefined) {
      entry.durationFrames = track.durationFrames;
    }
    if (track.volume !== undefined) {
      entry.volume = track.volume;
    }
    validatedAudioTracks.push(entry);
  }

  if (clips.length === 0) {
    return { ok: false, reason: "plan must have at least one clip" };
  }

  // Incomplete plan shell: provenance hashes are empty until real canonical
  // inputs and a real Slide Web Bundle identity are baked in via
  // bakeVideoPlanProvenance. validateVideoPlan rejects empty provenance, so
  // an unbaked plan can never be mistaken for a complete plan.
  const plan = {
    schema: hasTimelineData ? VIDEO_PLAN_SCHEMA_V2 : VIDEO_PLAN_SCHEMA,
    deckId,
    routeId,
    width,
    height,
    fps,
    totalFrames: currentFrame,
    clips,
    audioTracks: validatedAudioTracks,
    provenance: {
      deckHash: "",
      bundleHash: "",
      inputPropsHash: "",
      toolchain: {},
    },
  };

  return { ok: true, plan };
}

const PROVENANCE_HASH_KEYS = ["deckHash", "bundleHash", "inputPropsHash"];

function isNonemptyString(value) {
  return typeof value === "string" && value.length > 0;
}

export function bakeVideoPlanProvenance(plan, { deckHash, bundleHash, inputPropsHash } = {}) {
  if (!plan || typeof plan !== "object" || !plan.provenance || typeof plan.provenance !== "object") {
    throw new TypeError("bakeVideoPlanProvenance requires a plan with a provenance object");
  }

  const provided = { deckHash, bundleHash, inputPropsHash };
  for (const key of PROVENANCE_HASH_KEYS) {
    const value = provided[key];
    if (value !== undefined && !isNonemptyString(value)) {
      throw new TypeError(`${key} must be a nonempty string when provided`);
    }
  }

  const baked = { ...plan };
  baked.provenance = { ...plan.provenance };

  if (deckHash !== undefined) baked.provenance.deckHash = deckHash;
  if (bundleHash !== undefined) baked.provenance.bundleHash = bundleHash;
  if (inputPropsHash !== undefined) baked.provenance.inputPropsHash = inputPropsHash;

  // A baked plan is a complete plan: empty provenance can never produce a
  // plan that adapters accept, so reject it here instead of downstream.
  for (const key of PROVENANCE_HASH_KEYS) {
    if (!isNonemptyString(baked.provenance[key])) {
      throw new TypeError(
        `baked plan provenance.${key} must be a nonempty string; got ${JSON.stringify(baked.provenance[key] ?? null)}`,
      );
    }
  }
  return baked;
}

export function serializeVideoPlan(plan) {
  return stableCanonicalSerialize(plan);
}

export function hashVideoPlan(plan) {
  const content = stableCanonicalSerialize(plan);
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function validateVideoPlan(plan) {
  const errors = [];
  if (!plan || typeof plan !== "object") {
    return { ok: false, errors: ["plan is not an object"] };
  }
  // serializeVideoPlan/hashVideoPlan throw raw TypeErrors on non-JSON-safe
  // values, and both adapters hash the plan right after this validation, so
  // any non-JSON-safe value anywhere in the accepted plan must be rejected
  // here. Clip inputProps roots are skipped because each one is scanned
  // separately below with its own precise diagnostics.
  const clipInputPropsRoots = new Set();
  if (Array.isArray(plan.clips)) {
    for (const clip of plan.clips) {
      if (clip && typeof clip === "object" && clip.inputProps !== null && typeof clip.inputProps === "object") {
        clipInputPropsRoots.add(clip.inputProps);
      }
    }
  }
  const planSafety = isJsonSafe(plan, "$", new Set(), clipInputPropsRoots);
  if (!planSafety.ok) {
    errors.push(`plan is not JSON-safe: ${planSafety.reason}`);
  }
  if (plan.schema !== VIDEO_PLAN_SCHEMA && plan.schema !== VIDEO_PLAN_SCHEMA_V2) {
    errors.push(`invalid schema: ${plan.schema}`);
  }
  if (typeof plan.deckId !== "string" || plan.deckId === "") {
    errors.push("missing or invalid deckId");
  }
  if (typeof plan.routeId !== "string" || plan.routeId === "") {
    errors.push("missing or invalid routeId");
  }
  if (!Number.isInteger(plan.width) || plan.width <= 0) {
    errors.push(`invalid width: ${plan.width}`);
  }
  if (!Number.isInteger(plan.height) || plan.height <= 0) {
    errors.push(`invalid height: ${plan.height}`);
  }
  if (!Number.isInteger(plan.fps) || plan.fps <= 0) {
    errors.push(`invalid fps: ${plan.fps}`);
  }
  if (!Number.isInteger(plan.totalFrames) || plan.totalFrames < 0) {
    errors.push(`invalid totalFrames: ${plan.totalFrames}`);
  }
  if (!Array.isArray(plan.clips)) {
    errors.push("missing clips array");
  } else if (plan.clips.length === 0) {
    errors.push("clips array is empty");
  } else {
    let expectedStart = 0;
    const clipSlideIds = new Set();
    for (let i = 0; i < plan.clips.length; i++) {
      const clip = plan.clips[i];
      if (!clip || typeof clip !== "object") {
        errors.push(`clips[${i}] is not an object`);
        continue;
      }
      if (typeof clip.slideId !== "string" || clip.slideId === "") {
        errors.push(`clips[${i}] has invalid slideId`);
      }
      if (!Number.isInteger(clip.startFrame)) {
        errors.push(`clips[${i}].startFrame must be integer, got ${clip.startFrame}`);
      }
      if (!Number.isInteger(clip.durationFrames) || clip.durationFrames <= 0) {
        errors.push(`clips[${i}].durationFrames must be positive integer, got ${clip.durationFrames}`);
      }
      if (typeof clip.source !== "string" || clip.source === "") {
        errors.push(`clips[${i}] has invalid source`);
      }
      if (clip.stops !== undefined || clip.animation !== undefined) {
        if (plan.schema !== VIDEO_PLAN_SCHEMA_V2) {
          errors.push(`clips[${i}] carries timeline data but plan.schema is ${plan.schema} (expected ${VIDEO_PLAN_SCHEMA_V2})`);
        }
      }
      if (clip.stops !== undefined) {
        const stopsError = validateClipStops(clip.stops, Number.isInteger(clip.durationFrames) ? clip.durationFrames : 1, `clips[${i}]`);
        if (stopsError) errors.push(stopsError);
      }
      if (clip.animation !== undefined) {
        const animationError = validateClipAnimation(clip.animation, `clips[${i}]`);
        if (animationError) errors.push(animationError);
      }
      if (clip.inputProps === null || typeof clip.inputProps !== "object" || Array.isArray(clip.inputProps)) {
        errors.push(
          `clips[${i}].inputProps must be a JSON-safe object, got ${clip.inputProps === null ? "null" : Array.isArray(clip.inputProps) ? "array" : typeof clip.inputProps}`,
        );
      } else {
        const inputPropsSafety = isJsonSafe(clip.inputProps, `$.clips[${i}].inputProps`);
        if (!inputPropsSafety.ok) {
          errors.push(`clips[${i}].inputProps: ${inputPropsSafety.reason}`);
        }
      }
      if (clip.startFrame !== undefined && clip.startFrame !== expectedStart) {
        errors.push(`clips[${i}] gap: expected startFrame ${expectedStart}, got ${clip.startFrame}`);
      }
      if (clip.startFrame !== undefined && clip.durationFrames !== undefined) {
        expectedStart = clip.startFrame + clip.durationFrames;
      }
      if (clipSlideIds.has(clip.slideId)) {
        errors.push(`clips[${i}] duplicate slideId: ${clip.slideId}`);
      }
      clipSlideIds.add(clip.slideId);
    }
    if (expectedStart !== plan.totalFrames) {
      errors.push(`clip total (${expectedStart}) != totalFrames (${plan.totalFrames})`);
    }
  }
  if (!Array.isArray(plan.audioTracks)) {
    errors.push("missing audioTracks array");
  } else {
    const trackIds = new Set();
    for (let i = 0; i < plan.audioTracks.length; i++) {
      const track = plan.audioTracks[i];
      if (!track || typeof track !== "object") {
        errors.push(`audioTracks[${i}] is not an object`);
        continue;
      }
      if (typeof track.id !== "string" || track.id === "") {
        errors.push(`audioTracks[${i}] has invalid id`);
      }
      if (typeof track.src !== "string" || track.src === "") {
        errors.push(`audioTracks[${i}] has invalid src`);
      }
      if (!Number.isInteger(track.startFrame) || track.startFrame < 0) {
        errors.push(`audioTracks[${i}] has invalid startFrame: ${track.startFrame}`);
      }
      if (track.durationFrames !== undefined) {
        if (!Number.isInteger(track.durationFrames) || track.durationFrames <= 0) {
          errors.push(`audioTracks[${i}].durationFrames must be positive integer when present, got ${track.durationFrames}`);
        }
      }
      if (track.volume !== undefined) {
        if (typeof track.volume !== "number" || !Number.isFinite(track.volume) || track.volume < 0) {
          errors.push(`audioTracks[${i}].volume must be finite non-negative, got ${track.volume}`);
        }
      }
      if (trackIds.has(track.id)) {
        errors.push(`audioTracks[${i}] duplicate id: ${track.id}`);
      }
      trackIds.add(track.id);
    }
  }
  if (!plan.provenance || typeof plan.provenance !== "object" || Array.isArray(plan.provenance)) {
    errors.push("missing or invalid provenance object");
  } else {
    for (const key of PROVENANCE_HASH_KEYS) {
      if (!isNonemptyString(plan.provenance[key])) {
        errors.push(`provenance.${key} must be a nonempty string`);
      }
    }
    const toolchain = plan.provenance.toolchain;
    if (!toolchain || typeof toolchain !== "object" || Array.isArray(toolchain)) {
      errors.push("provenance.toolchain must be a plain object (Record<string, string>)");
    } else {
      for (const [key, value] of Object.entries(toolchain)) {
        if (typeof value !== "string") {
          errors.push(`provenance.toolchain.${key} must be a string, got ${typeof value}`);
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}
