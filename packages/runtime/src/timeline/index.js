/*
 * lattice.timeline.v1 — the deck-level presentation timeline (M7).
 *
 * A deck owns exactly one integer-frame timeline: segments (frames per slide)
 * × stops (reveal landing frames inside a segment) × audio tracks. The
 * declaration is deck-level metadata (manifest.timeline for lattice.deck.v2),
 * fully optional and strictly additive: decks without a timeline keep the
 * M1 static timing everywhere — compilation, planHash, and rendered pixels
 * are byte-identical.
 *
 * The timeline is engine-neutral: only integer frames, no backend units. It
 * is consumed by three surfaces that must stay frame-identical:
 *   - the presentation state machine (present-play),
 *   - the video backends through the compiled VideoPlan (stop schedule),
 *   - the video workbench preview (Slide Runtime playback).
 */

export const TIMELINE_SCHEMA = "lattice.timeline.v1";

// Local duplicates of the deck-v2 primitive predicates keep this module free
// of an import cycle with deck-v2 (which validates the manifest carrying the
// timeline).
function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isStableSlug(value) {
  return typeof value === "string" && value !== "" && /^[a-z0-9][a-z0-9-]*$/.test(value);
}

export const TIMELINE_DEFAULT_RHYTHM = Object.freeze({ first: 12, dwell: 45 });

const STOP_FRAME_KEY_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

const AUDIO_TRACK_KNOWN_FIELDS = new Set(["id", "src", "startFrame", "durationFrames", "volume"]);

const RHYTHM_KNOWN_FIELDS = new Set(["first", "dwell"]);

const TIMELINE_KNOWN_FIELDS = new Set(["schema", "rhythm", "defaults", "slides", "audioTracks"]);

const SLIDE_TIMING_KNOWN_FIELDS = new Set(["durationFrames", "stops", "animation"]);

const SLIDE_STOP_TIMING_KNOWN_FIELDS = new Set(["frame"]);

const DEFAULTS_KNOWN_FIELDS = new Set(["animation"]);

function issue(type, message, { slide = null, element = null, ...details } = {}) {
  return { type, slide, element, ...details, message };
}

function isInteger(value) {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value);
}

function resolveSlideHtml(slide) {
  return typeof slide.html === "function" ? slide.html() : slide.html;
}

/**
 * Structural validation of a timeline declaration without deck context.
 * Cross-references (slide ids, stop ids, preset names) are validated by
 * resolveTimeline against the real deck and the theme preset catalog.
 */
export function validateTimelineDeclaration(timeline) {
  const errors = [];
  if (!isPlainObject(timeline)) {
    return { ok: false, errors: [issue("invalid-timeline", "timeline must be an object")] };
  }
  for (const key of Object.keys(timeline)) {
    if (!TIMELINE_KNOWN_FIELDS.has(key)) {
      errors.push(issue("unknown-timeline-field", `timeline: unknown field "${key}" (allowed: ${[...TIMELINE_KNOWN_FIELDS].join(", ")})`, { element: `timeline.${key}` }));
    }
  }
  if (timeline.schema !== TIMELINE_SCHEMA) {
    errors.push(issue(
      "schema-mismatch",
      `timeline.schema must be ${JSON.stringify(TIMELINE_SCHEMA)}, got ${JSON.stringify(timeline.schema ?? null)}`,
      { element: "timeline.schema" },
    ));
  }
  if (timeline.rhythm !== undefined) {
    if (!isPlainObject(timeline.rhythm)) {
      errors.push(issue("invalid-rhythm", "timeline.rhythm must be an object { first, dwell }", { element: "timeline.rhythm" }));
    } else {
      for (const key of Object.keys(timeline.rhythm)) {
        if (!RHYTHM_KNOWN_FIELDS.has(key)) {
          errors.push(issue("unknown-rhythm-field", `timeline.rhythm: unknown field "${key}" (allowed: first, dwell)`, { element: `timeline.rhythm.${key}` }));
        }
      }
      if (timeline.rhythm.first !== undefined && (!isInteger(timeline.rhythm.first) || timeline.rhythm.first < 0)) {
        errors.push(issue("invalid-rhythm", `timeline.rhythm.first must be a non-negative integer, got ${JSON.stringify(timeline.rhythm.first)}`, { element: "timeline.rhythm.first" }));
      }
      if (timeline.rhythm.dwell !== undefined && (!isInteger(timeline.rhythm.dwell) || timeline.rhythm.dwell <= 0)) {
        errors.push(issue("invalid-rhythm", `timeline.rhythm.dwell must be a positive integer, got ${JSON.stringify(timeline.rhythm.dwell)}`, { element: "timeline.rhythm.dwell" }));
      }
    }
  }
  if (timeline.defaults !== undefined) {
    if (!isPlainObject(timeline.defaults)) {
      errors.push(issue("invalid-timeline-defaults", "timeline.defaults must be an object", { element: "timeline.defaults" }));
    } else {
      for (const key of Object.keys(timeline.defaults)) {
        if (!DEFAULTS_KNOWN_FIELDS.has(key)) {
          errors.push(issue("unknown-timeline-defaults-field", `timeline.defaults: unknown field "${key}" (allowed: animation)`, { element: `timeline.defaults.${key}` }));
        }
      }
    }
  }
  if (timeline.slides !== undefined) {
    if (!isPlainObject(timeline.slides)) {
      errors.push(issue("invalid-timeline-slides", "timeline.slides must be an object keyed by slide id", { element: "timeline.slides" }));
    } else {
      for (const [slideId, entry] of Object.entries(timeline.slides)) {
        const element = `timeline.slides.${slideId}`;
        if (!isStableSlug(slideId)) {
          errors.push(issue("invalid-timeline-slide", `${element}: slide id must be a stable slug`, { slide: slideId, element }));
          continue;
        }
        if (!isPlainObject(entry)) {
          errors.push(issue("invalid-timeline-slide", `${element} must be an object`, { slide: slideId, element }));
          continue;
        }
        for (const key of Object.keys(entry)) {
          if (!SLIDE_TIMING_KNOWN_FIELDS.has(key)) {
            errors.push(issue("unknown-timeline-slide-field", `${element}: unknown field "${key}" (allowed: ${[...SLIDE_TIMING_KNOWN_FIELDS].join(", ")})`, { slide: slideId, element: `${element}.${key}` }));
          }
        }
        if (entry.durationFrames !== undefined && (!isInteger(entry.durationFrames) || entry.durationFrames <= 0)) {
          errors.push(issue("invalid-timeline-slide", `${element}.durationFrames must be a positive integer, got ${JSON.stringify(entry.durationFrames)}`, { slide: slideId, element: `${element}.durationFrames` }));
        }
        if (entry.stops !== undefined) {
          if (!isPlainObject(entry.stops)) {
            errors.push(issue("invalid-timeline-slide", `${element}.stops must be an object keyed by stop id`, { slide: slideId, element: `${element}.stops` }));
          } else {
            for (const [stopId, stopTiming] of Object.entries(entry.stops)) {
              const stopElement = `${element}.stops.${stopId}`;
              if (!STOP_FRAME_KEY_PATTERN.test(stopId)) {
                errors.push(issue("invalid-timeline-stop", `${stopElement}: stop id must be a stable slug`, { slide: slideId, element: stopElement }));
                continue;
              }
              if (!isPlainObject(stopTiming)) {
                errors.push(issue("invalid-timeline-stop", `${stopElement} must be an object { frame }`, { slide: slideId, element: stopElement }));
                continue;
              }
              for (const key of Object.keys(stopTiming)) {
                if (!SLIDE_STOP_TIMING_KNOWN_FIELDS.has(key)) {
                  errors.push(issue("unknown-timeline-stop-field", `${stopElement}: unknown field "${key}" (allowed: frame)`, { slide: slideId, element: `${stopElement}.${key}` }));
                }
              }
              if (!isInteger(stopTiming.frame) || stopTiming.frame < 0) {
                errors.push(issue("invalid-timeline-stop", `${stopElement}.frame must be a non-negative integer frame, got ${JSON.stringify(stopTiming.frame)}`, { slide: slideId, element: `${stopElement}.frame` }));
              }
            }
          }
        }
      }
    }
  }
  if (timeline.audioTracks !== undefined) {
    if (!Array.isArray(timeline.audioTracks)) {
      errors.push(issue("invalid-timeline-audio", "timeline.audioTracks must be an array", { element: "timeline.audioTracks" }));
    } else {
      timeline.audioTracks.forEach((track, index) => {
        const element = `timeline.audioTracks[${index}]`;
        if (!isPlainObject(track)) {
          errors.push(issue("invalid-timeline-audio", `${element} must be an object`, { element }));
          return;
        }
        for (const key of Object.keys(track)) {
          if (!AUDIO_TRACK_KNOWN_FIELDS.has(key)) {
            errors.push(issue("unknown-timeline-audio-field", `${element}: unknown field "${key}" (allowed: ${[...AUDIO_TRACK_KNOWN_FIELDS].join(", ")})`, { element: `${element}.${key}` }));
          }
        }
        if (typeof track.id !== "string" || track.id === "") {
          errors.push(issue("invalid-timeline-audio", `${element}.id must be a non-empty string`, { element: `${element}.id` }));
        }
        if (typeof track.src !== "string" || track.src === "") {
          errors.push(issue("invalid-timeline-audio", `${element}.src must be a non-empty string (deck-relative or bundle-relative asset path)`, { element: `${element}.src` }));
        }
        if (!isInteger(track.startFrame) || track.startFrame < 0) {
          errors.push(issue("invalid-timeline-audio", `${element}.startFrame must be a non-negative integer frame, got ${JSON.stringify(track.startFrame)}`, { element: `${element}.startFrame` }));
        }
        if (track.durationFrames !== undefined && (!isInteger(track.durationFrames) || track.durationFrames <= 0)) {
          errors.push(issue("invalid-timeline-audio", `${element}.durationFrames must be a positive integer when present`, { element: `${element}.durationFrames` }));
        }
        if (track.volume !== undefined && (typeof track.volume !== "number" || !Number.isFinite(track.volume) || track.volume < 0)) {
          errors.push(issue("invalid-timeline-audio", `${element}.volume must be a finite non-negative number`, { element: `${element}.volume` }));
        }
      });
    }
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Reveal markers declared by slide markup. An element participates in
 * stop-reveal animation only through data-lattice-reveal="<stopId>"; the
 * marker must reference a stop that exists on the same slide.
 */
export function collectRevealMarkerIds(slide) {
  const html = resolveSlideHtml(slide);
  if (typeof html !== "string") return [];
  const ids = [];
  for (const match of html.matchAll(/data-lattice-reveal\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
    ids.push(match[1] ?? match[2] ?? "");
  }
  return ids;
}

/**
 * Derive the stop dwell rhythm: stop 0 lands on frame 0, each following stop
 * lands `dwell` frames after the previous reveal started (the first reveal
 * waits `first` frames). Deck rhythm overrides both values.
 */
export function deriveStopFrames(stopCount, rhythm) {
  const frames = [0];
  for (let index = 1; index < stopCount; index += 1) {
    frames.push(rhythm.first + (index - 1) * rhythm.dwell);
  }
  return frames;
}

/**
 * Resolve a deck's timeline into the effective per-slide timing every
 * consumer shares. Pure and fail-fast: any structural problem, unknown slide
 * or stop id, out-of-range frame, or illegal animation preset is an error —
 * nothing is silently repaired.
 *
 * `presetCatalog` validates animation declarations against the theme's named
 * preset vocabulary (e.g. the simple-light stop-reveal catalog).
 */
export function resolveTimeline({ manifest, slides, presetCatalog = null, validateAnimation = null } = {}) {
  const timeline = manifest?.timeline;
  if (timeline === undefined) {
    return { ok: true, errors: [], timeline: null };
  }
  if (!Array.isArray(slides) || slides.length === 0) {
    return { ok: false, errors: [issue("invalid-slides", "timeline resolution requires the deck's slide definitions")], timeline: null };
  }
  const declaration = validateTimelineDeclaration(timeline);
  if (!declaration.ok) {
    return { ok: false, errors: declaration.errors, timeline: null };
  }

  const rhythm = {
    first: timeline.rhythm?.first ?? TIMELINE_DEFAULT_RHYTHM.first,
    dwell: timeline.rhythm?.dwell ?? TIMELINE_DEFAULT_RHYTHM.dwell,
  };

  const animationOf = (animation, label) => {
    if (animation === undefined) return { ok: true, errors: [], normalized: null };
    if (validateAnimation) return validateAnimation(animation, { label });
    return { ok: false, errors: [issue("animation-catalog-missing", `${label}: no animation preset catalog was provided; cannot validate preset names`)] };
  };

  const defaultsResult = animationOf(timeline.defaults?.animation, "timeline.defaults.animation");
  if (!defaultsResult.ok) {
    return { ok: false, errors: defaultsResult.errors, timeline: null };
  }

  const errors = [];
  const slidesById = new Map();
  for (const slide of slides) {
    if (isPlainObject(slide) && typeof slide.id === "string") slidesById.set(slide.id, slide);
  }

  const declaredSlideIds = timeline.slides === undefined ? [] : Object.keys(timeline.slides);
  for (const slideId of declaredSlideIds) {
    if (!slidesById.has(slideId)) {
      errors.push(issue("unknown-timeline-slide", `timeline.slides references unknown slide id "${slideId}"`, { slide: slideId, element: `timeline.slides.${slideId}` }));
    }
  }

  const resolvedSlides = [];
  for (const slide of slides) {
    const slideId = slide.id;
    const entry = timeline.slides?.[slideId];
    const definitionStops = Array.isArray(slide.stops) ? slide.stops : [];
    const stopIds = definitionStops.map((stop) => (isPlainObject(stop) && typeof stop.id === "string" ? stop.id : null));
    if (stopIds.some((id) => id === null) || stopIds.length === 0) {
      errors.push(issue("invalid-slide-definition", `slide "${slideId}" must declare stops with stable ids before the timeline can assign frames`, { slide: slideId }));
      continue;
    }

    // Stop frames: explicit timeline frames win; otherwise the dwell rhythm
    // derives the whole sequence (replacing the M1 static placeholder frames).
    let frames;
    if (entry?.stops !== undefined) {
      const declaredIds = Object.keys(entry.stops);
      for (const stopId of declaredIds) {
        if (!stopIds.includes(stopId)) {
          errors.push(issue("unknown-timeline-stop", `timeline.slides.${slideId}.stops references unknown stop id "${stopId}" (slide stops: ${stopIds.join(", ")})`, { slide: slideId, element: `timeline.slides.${slideId}.stops.${stopId}` }));
        }
      }
      for (const stopId of stopIds) {
        if (!(stopId in entry.stops)) {
          errors.push(issue("missing-timeline-stop", `timeline.slides.${slideId}.stops must declare a frame for every slide stop (missing "${stopId}")`, { slide: slideId, element: `timeline.slides.${slideId}.stops.${stopId}` }));
        }
      }
      frames = stopIds.map((stopId) => entry.stops[stopId]?.frame);
    } else {
      frames = deriveStopFrames(stopIds.length, rhythm);
    }

    const durationFrames = entry?.durationFrames ?? (frames[frames.length - 1] + rhythm.dwell);

    if (!errors.some((error) => error.slide === slideId)) {
      let previousFrame = -1;
      frames.forEach((frame, index) => {
        const element = `timeline.slides.${slideId}.stops[${stopIds[index]}]`;
        if (!isInteger(frame) || frame < 0) {
          errors.push(issue("invalid-timeline-stop", `${element}.frame must be a non-negative integer, got ${JSON.stringify(frame ?? null)}`, { slide: slideId, element }));
          return;
        }
        if (frame <= previousFrame) {
          errors.push(issue("invalid-timeline-stop", `${element}.frame ${frame} must be strictly increasing (previous stop frame ${previousFrame})`, { slide: slideId, element }));
        }
        previousFrame = frame;
        if (frame > durationFrames - 1) {
          errors.push(issue("invalid-timeline-stop", `${element}.frame ${frame} is outside [0, ${durationFrames - 1}] (durationFrames ${durationFrames})`, { slide: slideId, element }));
        }
      });
      if (frames[0] !== 0) {
        errors.push(issue("invalid-timeline-stop", `timeline.slides.${slideId}: the first stop must land on frame 0 (the segment's initial state), got ${frames[0]}`, { slide: slideId, element: `timeline.slides.${slideId}` }));
      }
    }

    const animationResult = animationOf(entry?.animation ?? timeline.defaults?.animation, `timeline.slides.${slideId}.animation`);
    if (!animationResult.ok) {
      errors.push(...animationResult.errors);
    }

    // Reveal markers in the slide markup must reference real stops.
    for (const markerId of collectRevealMarkerIds(slide)) {
      if (!stopIds.includes(markerId)) {
        errors.push(issue(
          "unknown-reveal-marker",
          `slide "${slideId}" markup reveals stop "${markerId}" via data-lattice-reveal, but the slide stops are: ${stopIds.join(", ")}`,
          { slide: slideId },
        ));
      }
    }

    resolvedSlides.push({
      slideId,
      durationFrames,
      stops: stopIds.map((stopId, index) => ({ id: stopId, frame: frames[index] })),
      animation: animationResult.ok ? animationResult.normalized : null,
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors, timeline: null };
  }

  const audioTracks = Array.isArray(timeline.audioTracks) ? timeline.audioTracks : [];
  return {
    ok: true,
    errors: [],
    timeline: {
      schema: TIMELINE_SCHEMA,
      rhythm,
      animationDefaults: defaultsResult.normalized,
      slides: resolvedSlides,
      audioTracks,
    },
  };
}
