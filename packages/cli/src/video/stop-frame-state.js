// M7 stop-frame driving logic shared by the generated video hosts.
//
// The exported source strings are inlined VERBATIM into both generated hosts
// (Remotion frame documents and the HyperFrames composition driver), so both
// backends apply the exact same stop schedule semantics as the Slide Runtime:
//   - __latticeStopState(stops, localFrame) mirrors
//     computeSlideFrameState()'s stop selection (active stop, index, span,
//     offset, revealed list) as a pure function of the integer frame;
//   - __latticeApplyRevealOffsets(root, stops, localFrame, animation) applies
//     the per-element --lattice-reveal-offset variable to every
//     data-lattice-reveal marker with the same stagger indexing as the
//     runtime's applyRevealState.
// No backend animation engine is introduced: the hosts only apply the
// canonical frame-state surface (attributes + CSS variables) that the theme's
// per-frame CSS presets read.

export const STOP_FRAME_STATE_FUNCTIONS_SOURCE = String.raw`
function __latticeStopState(stops, localFrame) {
  if (!stops || !stops.length) {
    throw new Error("lattice host: clip carries no stop schedule");
  }
  var activeIndex = 0;
  for (var i = 0; i < stops.length; i += 1) {
    if (stops[i].frame <= localFrame) activeIndex = i;
    else break;
  }
  var active = stops[activeIndex];
  var next = stops[activeIndex + 1] || null;
  var span = next ? next.frame - active.frame : 0;
  return {
    stopId: active.id,
    stopIndex: activeIndex,
    stopFrame: active.frame,
    span: span,
    offset: localFrame - active.frame,
    revealedStops: stops
      .filter(function (stop) { return stop.frame <= localFrame; })
      .map(function (stop) { return stop.id; }),
  };
}

function __latticeApplyRevealOffsets(root, stops, localFrame, animation) {
  if (!root || typeof root.querySelectorAll !== "function") return;
  var frames = {};
  for (var i = 0; i < stops.length; i += 1) frames[stops[i].id] = stops[i].frame;
  var stagger = animation && typeof animation.stagger === "number" ? animation.stagger : 0;
  var hasAnimation = Boolean(animation);
  var counters = {};
  var elements = root.querySelectorAll("[data-lattice-reveal]");
  for (var j = 0; j < elements.length; j += 1) {
    var element = elements[j];
    var stopId = element.getAttribute("data-lattice-reveal") || "";
    if (!hasAnimation) {
      element.style.removeProperty("--lattice-reveal-offset");
      continue;
    }
    if (!(stopId in frames)) {
      throw new Error('lattice host: data-lattice-reveal="' + stopId + '" does not reference a stop of this clip');
    }
    var staggerIndex = counters[stopId] || 0;
    counters[stopId] = staggerIndex + 1;
    element.style.setProperty(
      "--lattice-reveal-offset",
      String(localFrame - frames[stopId] + staggerIndex * stagger)
    );
  }
}
`;

/**
 * The same stop-state computation as the generated hosts, as a real function
 * for Node-side consumers (host generation bootstrap state, tests). This and
 * the generated source above are kept semantically identical; the parity
 * suite asserts the rendered outputs agree.
 */
export function resolveStopFrameState(stops, localFrame) {
  if (!Array.isArray(stops) || stops.length === 0) {
    throw new Error("resolveStopFrameState requires a non-empty stop schedule");
  }
  let activeIndex = 0;
  for (let index = 0; index < stops.length; index += 1) {
    if (stops[index].frame <= localFrame) activeIndex = index;
    else break;
  }
  const active = stops[activeIndex];
  const next = stops[activeIndex + 1] ?? null;
  return {
    stopId: active.id,
    stopIndex: activeIndex,
    stopFrame: active.frame,
    span: next ? next.frame - active.frame : 0,
    offset: localFrame - active.frame,
    revealedStops: stops.filter((stop) => stop.frame <= localFrame).map((stop) => stop.id),
  };
}
