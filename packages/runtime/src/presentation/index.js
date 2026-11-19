/*
 * Lattice Presentation (M2) — engine-neutral pure state machine.
 *
 * This module owns page/step navigation for lattice.deck.v2 decks as a pure
 * function of (deck model, presentation state). It never touches the DOM,
 * timers, history, or any video backend: the browser presentation surface
 * (renderer/presentation-app.js) interprets the emitted intents with the
 * integer-frame Slide Runtime. Steps are stable stop IDs, never array
 * indices, so every surface shares one address shape:
 *   { routeId, slideId, stopId }.
 *
 * Stop navigation semantics (PRD 3.4 / A15):
 *   - navigation "jump" (default): the step change is an exact seek to the
 *     target stop's frame;
 *   - navigation "play": the surface plays frames from the current stop's
 *     frame to the next stop's frame — within the same slide — and pauses
 *     exactly on the target stop's frame, never one frame beyond. A step
 *     change that crosses a slide boundary is always an exact seek.
 *
 * The state machine is history-independent by construction: transitions read
 * only the current state, and any address can be restored directly (A17).
 */

import { DECK_SCHEMA_V2, isStableDeckId } from "../deck-v2/index.js";
import { resolveTimeline } from "../timeline/index.js";
import { validateStopRevealAnimation } from "../../themes/simple-light/presets.js";

export const PRESENTATION_MAIN_ROUTE = "main";

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function fail(message) {
  throw new TypeError(`[lattice-presentation] ${message}`);
}

function isPositiveInteger(value) {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value > 0;
}

function isNonNegativeInteger(value) {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

/**
 * Normalize and validate a v2 deck for presentation. Fails fast on any
 * structural problem; nothing is silently repaired or dropped.
 */
export function createPresentationModel(deck) {
  if (!deck || typeof deck !== "object" || Array.isArray(deck)) {
    fail("deck must be an object { id, routes, slides, ... }");
  }
  if (typeof deck.id !== "string" || !isStableDeckId(deck.id)) {
    fail(`deck.id ${JSON.stringify(deck.id)} must be a stable slug (lowercase letters, digits, hyphens)`);
  }
  if (!Array.isArray(deck.slides) || deck.slides.length === 0) {
    fail(`deck "${deck.id}" must declare a non-empty slides array`);
  }

  const slides = new Map();
  for (const slide of deck.slides) {
    if (!slide || typeof slide !== "object" || Array.isArray(slide)) {
      fail(`deck "${deck.id}": each slide must be an object`);
    }
    if (typeof slide.id !== "string" || !SLUG_PATTERN.test(slide.id)) {
      fail(`deck "${deck.id}": slide id ${JSON.stringify(slide?.id)} must be a stable slug`);
    }
    if (slides.has(slide.id)) {
      fail(`deck "${deck.id}": duplicate slide id "${slide.id}"`);
    }
    if (!isPositiveInteger(slide.durationFrames)) {
      fail(`slide "${slide.id}" must declare a positive integer durationFrames`);
    }
    if (!Array.isArray(slide.stops) || slide.stops.length === 0) {
      fail(`slide "${slide.id}" must declare at least one stop`);
    }
    const stops = [];
    const stopIndex = new Map();
    let previousFrame = -1;
    for (const stop of slide.stops) {
      if (!stop || typeof stop !== "object" || Array.isArray(stop)) {
        fail(`slide "${slide.id}": each stop must be an object`);
      }
      if (typeof stop.id !== "string" || !SLUG_PATTERN.test(stop.id)) {
        fail(`slide "${slide.id}": stop id ${JSON.stringify(stop?.id)} must be a stable slug`);
      }
      if (stopIndex.has(stop.id)) {
        fail(`slide "${slide.id}": duplicate stop id "${stop.id}"`);
      }
      if (!isNonNegativeInteger(stop.frame)) {
        fail(`slide "${slide.id}" stop "${stop.id}" must declare an integer frame >= 0`);
      }
      if (stop.frame > slide.durationFrames - 1) {
        fail(`slide "${slide.id}" stop "${stop.id}" frame ${stop.frame} is outside [0, ${slide.durationFrames - 1}]`);
      }
      if (stop.frame <= previousFrame) {
        fail(`slide "${slide.id}" stop "${stop.id}" frame ${stop.frame} must be strictly increasing (previous ${previousFrame})`);
      }
      if (stop.navigation !== undefined && stop.navigation !== "jump" && stop.navigation !== "play") {
        fail(`slide "${slide.id}" stop "${stop.id}" navigation must be "jump" or "play", got ${JSON.stringify(stop.navigation)}`);
      }
      stopIndex.set(stop.id, stops.length);
      stops.push(Object.freeze({ id: stop.id, frame: stop.frame, navigation: stop.navigation ?? "jump" }));
      previousFrame = stop.frame;
    }
    slides.set(
      slide.id,
      Object.freeze({
        id: slide.id,
        durationFrames: slide.durationFrames,
        stops,
        stopIndex,
      }),
    );
  }

  if (!deck.routes || typeof deck.routes !== "object" || Array.isArray(deck.routes)) {
    fail(`deck "${deck.id}" must declare a routes object`);
  }
  const routeKeys = Object.keys(deck.routes);
  if (!routeKeys.includes(PRESENTATION_MAIN_ROUTE)) {
    fail(`deck "${deck.id}" routes must include the "${PRESENTATION_MAIN_ROUTE}" route`);
  }
  const routes = new Map();
  for (const routeId of routeKeys) {
    if (!SLUG_PATTERN.test(routeId)) {
      fail(`deck "${deck.id}": route id ${JSON.stringify(routeId)} must be a stable slug`);
    }
    const route = deck.routes[routeId];
    if (!Array.isArray(route) || route.length === 0) {
      fail(`deck "${deck.id}" route "${routeId}" must be a non-empty array of slide ids`);
    }
    const seen = new Set();
    for (const slideId of route) {
      if (typeof slideId !== "string" || !slides.has(slideId)) {
        fail(`deck "${deck.id}" route "${routeId}" references unknown slide id ${JSON.stringify(slideId)}`);
      }
      if (seen.has(slideId)) {
        fail(`deck "${deck.id}" route "${routeId}" lists slide "${slideId}" more than once`);
      }
      seen.add(slideId);
    }
    routes.set(routeId, Object.freeze([...route]));
  }

  if (deck.fps !== undefined && !isPositiveInteger(deck.fps)) {
    fail(`deck "${deck.id}" fps must be a positive integer when present`);
  }

  return Object.freeze({
    deckId: deck.id,
    title: typeof deck.title === "string" && deck.title !== "" ? deck.title : deck.id,
    fps: deck.fps ?? null,
    slides,
    routes,
    branchRouteIds: Object.freeze(routeKeys.filter((key) => key !== PRESENTATION_MAIN_ROUTE)),
  });
}

/**
 * Build a presentation-ready deck descriptor from canonical lattice.deck.v2
 * artifacts (manifest object + loaded slide definitions + optional notes map).
 * Rejects any manifest that is not explicitly lattice.deck.v2 — v1 sources
 * are never silently upgraded (A08).
 */
/**
 * Merge a resolved timeline entry back onto a slide definition: the timeline
 * re-times segments and stops (replacing the M1 static placeholder frames)
 * and carries the slide's animation declaration; content, notes routing, and
 * stop navigation modes stay with the slide definition.
 */
function applyTimelineToSlide(slide, entry) {
  const definitionStops = new Map(slide.stops.map((stop) => [stop.id, stop]));
  const stops = entry.stops.map((timedStop) => {
    const definitionStop = definitionStops.get(timedStop.id);
    const merged = { id: timedStop.id, frame: timedStop.frame };
    if (definitionStop && definitionStop.navigation !== undefined) merged.navigation = definitionStop.navigation;
    return merged;
  });
  const timed = { ...slide, durationFrames: entry.durationFrames, stops };
  if (entry.animation) timed.animation = entry.animation;
  return timed;
}

export function createV2DeckDescriptor({ manifest, slides, notes = {}, title } = {}) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    fail("createV2DeckDescriptor requires a manifest object");
  }
  if (manifest.schema !== DECK_SCHEMA_V2) {
    fail(
      `createV2DeckDescriptor requires schema ${JSON.stringify(DECK_SCHEMA_V2)}, got ${JSON.stringify(manifest.schema)}; ` +
        "v1 sources must run the explicit lattice migrate step first",
    );
  }
  if (!Array.isArray(slides)) {
    fail("createV2DeckDescriptor requires the loaded slideDefinitions array");
  }
  const slideIds = new Set(slides.map((slide) => (slide && typeof slide === "object" ? slide.id : null)));
  for (const routeId of Object.keys(manifest.routes ?? {})) {
    for (const slideId of manifest.routes[routeId]) {
      if (!slideIds.has(slideId)) {
        fail(`createV2DeckDescriptor: route "${routeId}" references slide id ${JSON.stringify(slideId)} missing from the loaded slide definitions`);
      }
    }
  }

  // M7: a declared lattice.timeline.v1 re-times every surface from one
  // declaration. Decks without a timeline keep the static slide timing
  // exactly, so frozen decks present byte-for-byte as before.
  let effectiveSlides = slides;
  if (manifest.timeline !== undefined) {
    const resolution = resolveTimeline({
      manifest,
      slides,
      validateAnimation: (animation, options) => validateStopRevealAnimation(animation, options),
    });
    if (!resolution.ok) {
      const detail = resolution.errors.map((error) => error.message ?? String(error)).join("; ");
      fail(`createV2DeckDescriptor: deck "${manifest.id}" declares an invalid timeline: ${detail}`);
    }
    const entriesById = new Map(resolution.timeline.slides.map((entry) => [entry.slideId, entry]));
    effectiveSlides = slides.map((slide) => {
      const entry = entriesById.get(slide.id);
      return entry ? applyTimelineToSlide(slide, entry) : slide;
    });
  }

  return Object.freeze({
    id: manifest.id,
    title: title ?? manifest.title,
    fps: manifest.fps,
    canvas: manifest.canvas ? Object.freeze({ ...manifest.canvas }) : null,
    routes: Object.freeze(Object.fromEntries(Object.entries(manifest.routes).map(([key, value]) => [key, Object.freeze([...value])]))),
    slides: Object.freeze([...effectiveSlides]),
    notes: Object.freeze({ ...notes }),
  });
}

// ---- Address helpers ----

export function resolveSlideStep(model, slideId, stopId) {
  const slide = model.slides.get(slideId);
  if (!slide) return null;
  const index = slide.stopIndex.get(stopId);
  if (index === undefined) return null;
  const stop = slide.stops[index];
  return { slide, stop, index };
}

export function resolveRoute(model, routeId) {
  return model.routes.get(routeId) ?? null;
}

function assertRouteSlide(model, routeId, slideId) {
  const route = resolveRoute(model, routeId);
  if (!route) fail(`route ${JSON.stringify(routeId)} does not exist in deck "${model.deckId}"`);
  if (!model.slides.has(slideId)) {
    fail(`slide ${JSON.stringify(slideId)} does not exist in deck "${model.deckId}"`);
  }
  if (!route.includes(slideId)) {
    fail(`slide ${JSON.stringify(slideId)} is not part of route ${JSON.stringify(routeId)} in deck "${model.deckId}"`);
  }
}

export function formatPresentationAddress(address) {
  if (!address) return String(address);
  return `${address.routeId}/${address.slideId}#${address.stopId}`;
}

function freezeState(state) {
  return Object.freeze({
    routeId: state.routeId,
    slideId: state.slideId,
    stopId: state.stopId,
    branchOrigin: state.branchOrigin ? Object.freeze({ ...state.branchOrigin }) : null,
  });
}

function stateFromAddress(model, { routeId, slideId, stopId }) {
  const resolved = resolveSlideStep(model, slideId, stopId);
  if (!resolved) fail(`invalid presentation address ${formatPresentationAddress({ routeId, slideId, stopId })} in deck "${model.deckId}"`);
  assertRouteSlide(model, routeId, slideId);
  return freezeState({ routeId, slideId, stopId, branchOrigin: null });
}

/**
 * Initial state of a route: first slide, first stop. Unknown route fails
 * explicitly — there is no fallback route.
 */
export function initialPresentationState(model, { routeId = PRESENTATION_MAIN_ROUTE } = {}) {
  const route = resolveRoute(model, routeId);
  if (!route) fail(`route ${JSON.stringify(routeId)} does not exist in deck "${model.deckId}"`);
  const slideId = route[0];
  const slide = model.slides.get(slideId);
  return stateFromAddress(model, { routeId, slideId, stopId: slide.stops[0].id });
}

export function currentPresentationStep(model, state) {
  return resolveSlideStep(model, state.slideId, state.stopId);
}

function stepAddress(state) {
  return { routeId: state.routeId, slideId: state.slideId, stopId: state.stopId };
}

function seekIntent(state, slide, stop) {
  return {
    state: freezeState(state),
    boundary: null,
    intent: Object.freeze({
      kind: "seek",
      routeId: state.routeId,
      slideId: slide.id,
      stopId: stop.id,
      localFrame: stop.frame,
      navigation: stop.navigation,
    }),
  };
}

function boundaryResult(state, boundary) {
  return { state: freezeState(state), boundary, intent: null };
}

/**
 * Next step. Within a slide the CURRENT stop's navigation mode decides the
 * frame behavior: "play" emits a play segment from the current stop's frame
 * to the next stop's frame (same slide only); "jump" (and every cross-slide
 * step) emits an exact seek.
 */
export function presentationNext(model, state) {
  const { slide, stop, index } = currentPresentationStep(model, state);
  const nextStop = slide.stops[index + 1];
  if (nextStop) {
    if (stop.navigation === "play") {
      return {
        state: freezeState({ ...state, stopId: nextStop.id }),
        boundary: null,
        intent: Object.freeze({
          kind: "play",
          routeId: state.routeId,
          slideId: slide.id,
          stopId: nextStop.id,
          fromFrame: stop.frame,
          toFrame: nextStop.frame,
          navigation: nextStop.navigation,
        }),
      };
    }
    return seekIntent({ ...state, stopId: nextStop.id }, slide, nextStop);
  }
  const route = resolveRoute(model, state.routeId);
  const slideIndex = route.indexOf(slide.id);
  const nextSlideId = route[slideIndex + 1];
  if (!nextSlideId) return boundaryResult(state, "end");
  const nextSlide = model.slides.get(nextSlideId);
  return seekIntent({ ...state, slideId: nextSlideId, stopId: nextSlide.stops[0].id }, nextSlide, nextSlide.stops[0]);
}

/**
 * Previous step. Always an exact seek (play is a forward-only behavior).
 */
export function presentationPrevious(model, state) {
  const { slide, stop, index } = currentPresentationStep(model, state);
  const previousStop = slide.stops[index - 1];
  if (previousStop) {
    return seekIntent({ ...state, stopId: previousStop.id }, slide, previousStop);
  }
  const route = resolveRoute(model, state.routeId);
  const slideIndex = route.indexOf(slide.id);
  const previousSlideId = route[slideIndex - 1];
  if (!previousSlideId) return boundaryResult(state, "start");
  const previousSlide = model.slides.get(previousSlideId);
  const lastStop = previousSlide.stops[previousSlide.stops.length - 1];
  return seekIntent({ ...state, slideId: previousSlideId, stopId: lastStop.id }, previousSlide, lastStop);
}

/**
 * Home: first stop of the first slide of the current route.
 */
export function presentationFirst(model, state) {
  const route = resolveRoute(model, state.routeId);
  const slide = model.slides.get(route[0]);
  const stop = slide.stops[0];
  return seekIntent({ ...state, slideId: slide.id, stopId: stop.id }, slide, stop);
}

/**
 * End: last stop of the last slide of the current route.
 */
export function presentationLast(model, state) {
  const route = resolveRoute(model, state.routeId);
  const slide = model.slides.get(route[route.length - 1]);
  const stop = slide.stops[slide.stops.length - 1];
  return seekIntent({ ...state, slideId: slide.id, stopId: stop.id }, slide, stop);
}

/**
 * Direct jump to an exact step address. Unknown route/slide/stop or a slide
 * outside the route fails explicitly — never a fallback to nearby content.
 */
export function presentationJumpToStop(model, state, { routeId = state.routeId, slideId, stopId } = {}) {
  if (typeof slideId !== "string" || typeof stopId !== "string") {
    fail("presentationJumpToStop requires string slideId and stopId");
  }
  assertRouteSlide(model, routeId, slideId);
  const resolved = resolveSlideStep(model, slideId, stopId);
  if (!resolved) {
    fail(`slide ${JSON.stringify(slideId)} has no stop ${JSON.stringify(stopId)} in deck "${model.deckId}"`);
  }
  const keepOrigin = routeId === state.routeId ? state.branchOrigin : state.branchOrigin;
  return seekIntent({ ...state, routeId, slideId, stopId, branchOrigin: keepOrigin }, resolved.slide, resolved.stop);
}

/**
 * Jump to an arbitrary integer frame of a slide: presentation addresses are
 * steps, so the frame resolves to the stop governing it (largest stop frame
 * <= localFrame) and lands exactly on that stop's frame.
 */
export function presentationStopAtFrame(slide, localFrame) {
  if (!isNonNegativeInteger(localFrame)) {
    fail(`localFrame must be a non-negative integer frame, got ${String(localFrame)}`);
  }
  if (localFrame > slide.durationFrames - 1) {
    fail(`localFrame ${localFrame} is outside [0, ${slide.durationFrames - 1}] for slide "${slide.id}"`);
  }
  let active = slide.stops[0];
  for (const stop of slide.stops) {
    if (stop.frame <= localFrame) active = stop;
    else break;
  }
  return active;
}

export function presentationJumpToFrame(model, state, { slideId = state.slideId, localFrame } = {}) {
  const slide = model.slides.get(slideId);
  if (!slide) fail(`slide ${JSON.stringify(slideId)} does not exist in deck "${model.deckId}"`);
  const stop = presentationStopAtFrame(slide, localFrame);
  return presentationJumpToStop(model, state, { slideId, stopId: stop.id });
}

/**
 * Enter a branch route. The exact parent address (route/slide/stop) is
 * remembered as branchOrigin (A18); entering from a branch keeps the
 * original origin, so return always restores the root presentation point.
 */
export function presentationEnterBranch(model, state, routeId) {
  if (typeof routeId !== "string") fail("presentationEnterBranch requires a route id string");
  const route = resolveRoute(model, routeId);
  if (!route) fail(`route ${JSON.stringify(routeId)} does not exist in deck "${model.deckId}"`);
  if (routeId === state.routeId) return boundaryResult(state, "already-on-route");
  const slideId = route[0];
  const slide = model.slides.get(slideId);
  const branchOrigin = state.branchOrigin ?? Object.freeze({ routeId: state.routeId, slideId: state.slideId, stopId: state.stopId });
  return seekIntent(
    { routeId, slideId, stopId: slide.stops[0].id, branchOrigin },
    slide,
    slide.stops[0],
  );
}

/**
 * Return from a branch: restores the exact parent route/slide/stop recorded
 * at entry and clears the origin.
 */
export function presentationExitBranch(model, state) {
  if (!state.branchOrigin) return boundaryResult(state, "no-branch-origin");
  const origin = state.branchOrigin;
  const resolved = resolveSlideStep(model, origin.slideId, origin.stopId);
  if (!resolved) fail(`branch origin ${formatPresentationAddress(origin)} no longer resolves in deck "${model.deckId}"`);
  return seekIntent(
    { routeId: origin.routeId, slideId: origin.slideId, stopId: origin.stopId, branchOrigin: null },
    resolved.slide,
    resolved.stop,
  );
}

/**
 * The inclusive integer frame sequence a play segment must advance through:
 * (fromFrame, toFrame] — the surface is already painted on fromFrame, so the
 * segment advances to the target stop frame and pauses exactly there, never
 * one frame beyond (A15).
 */
export function playSegmentFrames(intent) {
  if (!intent || intent.kind !== "play") {
    fail("playSegmentFrames requires a play intent");
  }
  const frames = [];
  for (let frame = intent.fromFrame + 1; frame <= intent.toFrame; frame += 1) frames.push(frame);
  return Object.freeze(frames);
}

// ---- URL codec (A17) ----
//
// Stable route/slide/step IDs only — never array indices. Absent step params
// mean the route's first step; any explicit but unknown value is an explicit
// parse error that callers must surface (no fallback to wrong content).

export const PRESENTATION_URL_PARAMS = Object.freeze({
  deck: "deck",
  present: "present",
  route: "route",
  slide: "slide",
  stop: "stop",
  presenter: "presenter",
  originRoute: "origin-route",
  originSlide: "origin-slide",
  originStop: "origin-stop",
});

const ORIGIN_URL_KEYS = Object.freeze({
  route: "origin-route",
  slide: "origin-slide",
  stop: "origin-stop",
});

export function presentationAddressParams({ routeId, slideId, stopId, branchOrigin } = {}) {
  const params = {};
  if (routeId !== undefined && routeId !== PRESENTATION_MAIN_ROUTE) params.route = routeId;
  if (slideId !== undefined) params.slide = slideId;
  if (stopId !== undefined) params.stop = stopId;
  if (branchOrigin && routeId !== PRESENTATION_MAIN_ROUTE) {
    params[ORIGIN_URL_KEYS.route] = branchOrigin.routeId;
    params[ORIGIN_URL_KEYS.slide] = branchOrigin.slideId;
    params[ORIGIN_URL_KEYS.stop] = branchOrigin.stopId;
  }
  return params;
}

/**
 * Parse presentation address parameters against a model.
 * Returns { ok: true, address: { routeId, slideId, stopId } } or
 * { ok: false, errors: [{ code, param, value, message }] }.
 */
export function parsePresentationAddress(model, params, { defaultRouteId = PRESENTATION_MAIN_ROUTE } = {}) {
  const errors = [];
  const get = (name) => (params instanceof URLSearchParams ? params.get(name) : params?.[name] ?? null);
  const has = (name) => (params instanceof URLSearchParams ? params.has(name) : params?.[name] !== undefined && params?.[name] !== null);

  const routeParam = get("route");
  const slideParam = get("slide");
  const stopParam = get("stop");

  let routeId = defaultRouteId;
  if (has("route")) {
    if (typeof routeParam !== "string" || routeParam === "") {
      errors.push({ code: "invalid-route", param: "route", value: routeParam, message: "route must be a non-empty route id" });
    } else if (!model.routes.has(routeParam)) {
      errors.push({ code: "unknown-route", param: "route", value: routeParam, message: `route "${routeParam}" does not exist in deck "${model.deckId}"` });
    } else {
      routeId = routeParam;
    }
  }

  let slideId = null;
  if (has("slide")) {
    if (typeof slideParam !== "string" || slideParam === "") {
      errors.push({ code: "invalid-slide", param: "slide", value: slideParam, message: "slide must be a non-empty slide id" });
    } else if (!model.slides.has(slideParam)) {
      errors.push({ code: "unknown-slide", param: "slide", value: slideParam, message: `slide "${slideParam}" does not exist in deck "${model.deckId}"` });
    } else if (!model.routes.get(routeId)?.includes(slideParam)) {
      errors.push({ code: "slide-not-in-route", param: "slide", value: slideParam, message: `slide "${slideParam}" is not part of route "${routeId}" in deck "${model.deckId}"` });
    } else {
      slideId = slideParam;
    }
  }

  let stopId = null;
  if (has("stop")) {
    if (typeof stopParam !== "string" || stopParam === "") {
      errors.push({ code: "invalid-stop", param: "stop", value: stopParam, message: "stop must be a non-empty stop id" });
    } else {
      const targetSlideId = slideId ?? model.routes.get(routeId)?.[0] ?? null;
      const slide = targetSlideId ? model.slides.get(targetSlideId) : null;
      if (!slide || !slide.stopIndex.has(stopParam)) {
        errors.push({
          code: "unknown-stop",
          param: "stop",
          value: stopParam,
          message: `stop "${stopParam}" does not exist${targetSlideId ? ` on slide "${targetSlideId}"` : ""} in deck "${model.deckId}"`,
        });
      } else {
        stopId = stopParam;
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  const route = model.routes.get(routeId);
  const resolvedSlideId = slideId ?? route[0];
  const slide = model.slides.get(resolvedSlideId);
  const resolvedStopId = stopId ?? slide.stops[0].id;

  // Branch origin (A18): stable parent route/slide/stop recorded in the URL so
  // refresh/back/forward inside a branch keep the exact return address. The
  // origin is only honored on a non-main route, and every origin value must
  // resolve explicitly — no fallback.
  let branchOrigin = null;
  if (routeId !== PRESENTATION_MAIN_ROUTE) {
    const originRoute = get(ORIGIN_URL_KEYS.route);
    const originSlide = get(ORIGIN_URL_KEYS.slide);
    const originStop = get(ORIGIN_URL_KEYS.stop);
    const originProvided = has(ORIGIN_URL_KEYS.route) || has(ORIGIN_URL_KEYS.slide) || has(ORIGIN_URL_KEYS.stop);
    if (originProvided) {
      const originModelRoute = typeof originRoute === "string" ? model.routes.get(originRoute) : null;
      if (!originModelRoute) {
        errors.push({ code: "unknown-route", param: ORIGIN_URL_KEYS.route, value: originRoute, message: `branch origin route ${JSON.stringify(originRoute)} does not exist in deck "${model.deckId}"` });
      } else {
        const originSlideId = typeof originSlide === "string" && originModelRoute.includes(originSlide) ? originSlide : null;
        if (!originSlideId) {
          errors.push({ code: "unknown-slide", param: ORIGIN_URL_KEYS.slide, value: originSlide, message: `branch origin slide ${JSON.stringify(originSlide)} is not part of route "${originRoute}" in deck "${model.deckId}"` });
        } else {
          const originSlideDef = model.slides.get(originSlideId);
          if (typeof originStop !== "string" || !originSlideDef.stopIndex.has(originStop)) {
            errors.push({ code: "unknown-stop", param: ORIGIN_URL_KEYS.stop, value: originStop, message: `branch origin stop ${JSON.stringify(originStop)} does not exist on slide "${originSlideId}" in deck "${model.deckId}"` });
          } else {
            branchOrigin = Object.freeze({ routeId: originRoute, slideId: originSlideId, stopId: originStop });
          }
        }
      }
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    address: Object.freeze({ routeId, slideId: resolvedSlideId, stopId: resolvedStopId, branchOrigin }),
  };
}

/**
 * Verify a full address (all four stable IDs) against a model. Used at boot:
 * an unknown deck/route/slide/step must fail explicitly (A17).
 */
export function validatePresentationAddress(model, address) {
  const errors = [];
  const check = (ok, code, value, message) => {
    if (!ok) errors.push({ code, value, message });
  };
  check(typeof address?.routeId === "string" && model.routes.has(address.routeId), "unknown-route", address?.routeId, `route ${JSON.stringify(address?.routeId)} does not exist in deck "${model.deckId}"`);
  check(typeof address?.slideId === "string" && model.slides.has(address.slideId), "unknown-slide", address?.slideId, `slide ${JSON.stringify(address?.slideId)} does not exist in deck "${model.deckId}"`);
  if (errors.length === 0) {
    const route = model.routes.get(address.routeId);
    check(route.includes(address.slideId), "slide-not-in-route", address.slideId, `slide "${address.slideId}" is not part of route "${address.routeId}" in deck "${model.deckId}"`);
    const slide = model.slides.get(address.slideId);
    check(slide.stopIndex.has(address.stopId), "unknown-stop", address.stopId, `stop ${JSON.stringify(address.stopId)} does not exist on slide "${address.slideId}" in deck "${model.deckId}"`);
  }
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}
