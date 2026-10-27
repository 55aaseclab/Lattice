/*
 * Lattice Slide Runtime (M1 contract).
 *
 * The runtime evaluates one Slide at an integer localFrame. Frame state is a
 * pure function of (SlideDefinition, localFrame): a lightweight frame reducer
 * produces normalized state that is applied to the slide root as CSS custom
 * properties plus data attributes, so fresh, forward, backward, repeated and
 * random seeks to the same frame always converge to the same normalized DOM
 * state (A11). No animation library, no playback history, no wall clock, no
 * backend units — only integer frames (A09).
 */

import {
  FRAME_ADDRESS_VARIABLES,
  assertFrameAddress,
} from "../deck-v2/index.js";

export { FRAME_ADDRESS_VARIABLES, assertFrameAddress };

const APPLY_ATTRIBUTES = ["data-lattice-frame", "data-lattice-stop", "data-lattice-stop-index", "data-lattice-revealed-stops"];

// M7 stop-reveal animation surface: container attributes/variables derived
// from the slide's timeline animation declaration, plus the per-element
// `--lattice-reveal-offset` variable applied to every data-lattice-reveal
// marker. All values are pure functions of the integer frame, so seeks stay
// history-independent and every surface paints identical frames.
const ANIMATION_ATTRIBUTES = ["data-lattice-anim", "data-lattice-anim-direction"];
const ANIMATION_VARIABLES = [
  "--lattice-anim-duration-frames",
  "--lattice-anim-distance",
  "--lattice-anim-stagger-frames",
];
const REVEAL_VARIABLE = "--lattice-reveal-offset";

/**
 * Per-element reveal offset: frames since the element's stop revealed,
 * extended by the element's stagger index so every element of a stop
 * completes its window exactly on the stop frame. Shared semantics with the
 * video hosts' generated frame drivers.
 */
export function computeRevealOffset(localFrame, stopFrame, staggerIndex, stagger) {
  return localFrame - stopFrame + staggerIndex * stagger;
}

export function resolveSlideHtml(slide) {
  return typeof slide.html === "function" ? slide.html() : slide.html;
}

/**
 * Pure frame reducer. Throws on any frame that is not an integer within
 * [0, durationFrames - 1]; the returned state depends only on the slide
 * definition and the requested frame.
 */
export function computeSlideFrameState(slide, localFrame) {
  if (typeof localFrame !== "number" || !Number.isFinite(localFrame) || !Number.isInteger(localFrame)) {
    throw new TypeError(
      `localFrame must be an integer frame, got ${String(localFrame)}` +
        (typeof localFrame === "number" && Number.isFinite(localFrame) ? " (fractional frames are not canonical)" : ""),
    );
  }
  if (localFrame < 0) {
    throw new RangeError(`localFrame must be >= 0, got ${localFrame}`);
  }
  const durationFrames = slide.durationFrames;
  if (!Number.isInteger(durationFrames) || durationFrames <= 0) {
    throw new TypeError(`slide "${slide.id}" has invalid durationFrames ${String(durationFrames)}`);
  }
  if (localFrame > durationFrames - 1) {
    throw new RangeError(
      `localFrame ${localFrame} is outside [0, durationFrames - 1] for slide "${slide.id}" (durationFrames ${durationFrames})`,
    );
  }
  const stops = slide.stops;
  if (!Array.isArray(stops) || stops.length === 0) {
    throw new TypeError(`slide "${slide.id}" must declare at least one stop`);
  }

  let activeIndex = 0;
  for (let index = 0; index < stops.length; index += 1) {
    if (stops[index].frame <= localFrame) activeIndex = index;
    else break;
  }
  const active = stops[activeIndex];
  const next = stops[activeIndex + 1] ?? null;
  const span = next ? next.frame - active.frame : durationFrames - active.frame;
  const offset = localFrame - active.frame;

  const revealedStopIds = [];
  for (const stop of stops) {
    if (stop.frame <= localFrame) revealedStopIds.push(stop.id);
  }

  const stopFrameById = {};
  for (const stop of stops) {
    stopFrameById[stop.id] = stop.frame;
  }

  return {
    localFrame,
    stopId: active.id,
    stopIndex: activeIndex,
    stopFrame: active.frame,
    navigation: active.navigation ?? "jump",
    revealedStopIds,
    stopFrameById,
    animation: slide.animation ?? null,
    variables: {
      "--lattice-local-frame": String(localFrame),
      "--lattice-duration-frames": String(durationFrames),
      "--lattice-stop-index": String(activeIndex),
      "--lattice-stop-frame": String(active.frame),
      "--lattice-stop-span": String(span),
      "--lattice-stop-frame-offset": String(offset),
    },
  };
}

/**
 * Normalized frame state of a mounted container: the exact attribute/style
 * surface the runtime owns. Seek equivalence tests compare this snapshot.
 */
export function snapshotSlideFrameState(container) {
  const attributes = {};
  for (const name of [...APPLY_ATTRIBUTES, ...ANIMATION_ATTRIBUTES]) {
    const value = container.getAttribute?.(name);
    if (value !== null && value !== undefined) attributes[name] = value;
  }
  const variables = {};
  for (const name of [...FRAME_ADDRESS_VARIABLES, ...ANIMATION_VARIABLES]) {
    const value = container.style?.getPropertyValue?.(name);
    if (value !== undefined && value !== null && value !== "") variables[name] = value;
  }
  return { attributes, variables };
}

function clearFrameState(container) {
  for (const name of APPLY_ATTRIBUTES) {
    container.removeAttribute?.(name);
  }
  for (const name of [...FRAME_ADDRESS_VARIABLES, ...ANIMATION_VARIABLES]) {
    container.style?.removeProperty?.(name);
  }
  for (const name of ANIMATION_ATTRIBUTES) {
    container.removeAttribute?.(name);
  }
}

function applyAnimationState(container, animation) {
  if (!animation) return;
  container.setAttribute?.("data-lattice-anim", animation.preset);
  if (animation.direction !== undefined) {
    container.setAttribute?.("data-lattice-anim-direction", animation.direction);
  }
  if (animation.durationFrames !== undefined) {
    container.style?.setProperty?.("--lattice-anim-duration-frames", String(animation.durationFrames));
  }
  if (animation.distancePx !== undefined) {
    container.style?.setProperty?.("--lattice-anim-distance", `${animation.distancePx}px`);
  }
  if (animation.stagger !== undefined) {
    container.style?.setProperty?.("--lattice-anim-stagger-frames", String(animation.stagger));
  }
}

/**
 * Apply the per-element reveal offsets for this frame. Elements mark their
 * stop with data-lattice-reveal="<stopId>"; an unknown stop id is a hard
 * error (fail-fast, never a silently wrong reveal). When the slide declares
 * no animation the marker variable is cleared so stale values can never
 * surface.
 */
function applyRevealState(container, state) {
  if (typeof container.querySelectorAll !== "function") return;
  const stagger = state.animation?.stagger ?? 0;
  const hasAnimation = Boolean(state.animation);
  const elements = container.querySelectorAll("[data-lattice-reveal]");
  const counters = new Map();
  for (const element of elements) {
    const stopId = element.getAttribute?.("data-lattice-reveal") ?? "";
    if (!hasAnimation) {
      element.style?.removeProperty?.(REVEAL_VARIABLE);
      continue;
    }
    const stopFrame = state.stopFrameById?.[stopId];
    if (!Number.isInteger(stopFrame)) {
      throw new Error(
        `slide element data-lattice-reveal="${stopId}" does not reference a stop of slide (stops: ${Object.keys(state.stopFrameById ?? {}).join(", ")})`,
      );
    }
    const staggerIndex = counters.get(stopId) ?? 0;
    counters.set(stopId, staggerIndex + 1);
    element.style?.setProperty?.(REVEAL_VARIABLE, String(computeRevealOffset(state.localFrame, stopFrame, staggerIndex, stagger)));
  }
}

function applyFrameState(container, state) {
  clearFrameState(container);
  for (const [name, value] of Object.entries(state.variables)) {
    container.style?.setProperty?.(name, value);
  }
  container.setAttribute?.("data-lattice-frame", String(state.localFrame));
  container.setAttribute?.("data-lattice-stop", state.stopId);
  container.setAttribute?.("data-lattice-stop-index", String(state.stopIndex));
  container.setAttribute?.("data-lattice-revealed-stops", state.revealedStopIds.join(" "));
  applyAnimationState(container, state.animation);
  applyRevealState(container, state);
}

function nextTick({ requestAnimationFrame }) {
  if (typeof requestAnimationFrame === "function") {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }
  // Deterministic non-browser fallback (Node tests): one macrotask boundary.
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// ---- Default resource readiness barrier (PRD 3.1.3 / A10) ----
//
// "字体、图片、SVG、视频和音频必须在 ready() 完成前可验证地加载或失败" — fonts,
// images, SVG images, video, and audio must be verifiably loaded or failed
// before ready() resolves. The barrier below inspects only the mounted
// container and the (optionally injected) document:
//   - it never constructs resources of its own (no new Image(), no fetch());
//   - it never scans string values — only structural element/attribute state;
//   - it attaches listeners synchronously at mount time so no load/error event
//     can be missed, and removes every still-attached listener when the wait
//     settles (including cancellation via destroy()).
// All injected primitives (document.fonts, element APIs) come from the
// container/document so the barrier stays testable in plain Node.

const RESOURCE_SELECTOR = "img, image, video, audio";

const MEDIA_READY_STATE_HAVE_CURRENT_DATA = 2;

// Media networkState === NETWORK_EMPTY (0): loading never started. A
// preload="none" element stays here forever on its own; triggering its own
// declared source is the only way readiness stays verifiable. This requests
// nothing the slide did not already declare.
const MEDIA_NETWORK_STATE_EMPTY = 0;

function declaredResourceUrl(element) {
  const value = element.getAttribute?.("src") ?? element.getAttribute?.("href") ?? element.getAttribute?.("xlink:href");
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

function describeResource(element) {
  const tag = typeof element.tagName === "string" ? element.tagName.toLowerCase() : "element";
  const url = declaredResourceUrl(element);
  return url ? `${tag}[${url}]` : tag;
}

function collectFontFaces(fonts) {
  const faces = [];
  if (typeof fonts.forEach === "function") fonts.forEach((face) => faces.push(face));
  else if (typeof fonts[Symbol.iterator] === "function") faces.push(...fonts);
  return faces;
}

/**
 * Create the default readiness waiter. Returns `{ promise, cancel }`:
 *   - promise resolves with a `{ fonts, resources }` summary once every
 *     relevant resource is verifiably loaded, or rejects naming every resource
 *     that verifiably failed;
 *   - cancel(reason) settles the promise early (used by destroy() and by
 *     ready() error paths) and removes all remaining listeners.
 */
export function createSlideResourcesWaiter({ container, document: documentRef = globalThis.document } = {}) {
  const listeners = [];
  const failures = [];
  let cancelled = false;
  let cancelError = null;
  let rejectCancelled = null;

  const cancelledPromise = new Promise((_, reject) => {
    rejectCancelled = reject;
  });

  function track(target, type, handler) {
    target.addEventListener?.(type, handler, { once: true });
    listeners.push([target, type, handler]);
  }

  function cleanup() {
    for (const [target, type, handler] of listeners.splice(0)) {
      target.removeEventListener?.(type, handler);
    }
  }

  const waiters = [];
  let usedFonts = false;
  let resourceCount = 0;

  // Fonts: document.fonts.ready proves pending loads settled; individual
  // FontFace.status === "error" is the verifiable failure signal.
  const fonts = documentRef?.fonts;
  if (fonts && typeof fonts.ready?.then === "function") {
    usedFonts = true;
    waiters.push(
      fonts.ready.then(
        () => {
          if (cancelled) return;
          for (const face of collectFontFaces(fonts)) {
            if (face?.status === "error") failures.push(`font "${face.family ?? "unknown"}" failed to load`);
          }
        },
        (error) => {
          if (!cancelled) failures.push(`font readiness failed: ${error?.message ?? String(error)}`);
        },
      ),
    );
  }

  function waitImageResource(element) {
    const url = declaredResourceUrl(element);
    if (!url) return null; // nothing declared → nothing to verify
    const label = describeResource(element);
    if (element.complete === true) {
      // HTMLImageElement: a completed image with no intrinsic size failed.
      if (element.naturalWidth === 0 && element.naturalHeight === 0) {
        failures.push(`image failed to load: ${label}`);
      }
      return null;
    }
    resourceCount += 1;
    return new Promise((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      track(element, "load", settle);
      track(element, "error", () => {
        if (!cancelled) failures.push(`image failed to load: ${label}`);
        settle();
      });
    });
  }

  function waitMediaResource(element) {
    const sourceElements = typeof element.querySelectorAll === "function"
      ? Array.from(element.querySelectorAll("source"))
      : [];
    const hasSource = declaredResourceUrl(element) !== null || sourceElements.length > 0;
    if (!hasSource) return null; // nothing declared → nothing to verify
    const label = describeResource(element);
    if (element.error) {
      failures.push(`media failed to load: ${label}`);
      return null;
    }
    if (typeof element.readyState === "number" && element.readyState >= MEDIA_READY_STATE_HAVE_CURRENT_DATA) {
      return null; // first frame / audio data already decoded
    }
    if (element.networkState === MEDIA_NETWORK_STATE_EMPTY && typeof element.load === "function") {
      // preload="none" media never starts loading on its own; trigger its own
      // declared source so readiness stays verifiable. NETWORK_NO_SOURCE is
      // deliberately NOT treated as a synchronous failure: the resource
      // selection algorithm passes through it before loading starts.
      try {
        element.load();
      } catch {
        // Keep waiting on events; some engines reject redundant load() calls.
      }
    }
    resourceCount += 1;
    return new Promise((resolve) => {
      let settled = false;
      let failedSourceCount = 0;
      const settle = () => {
        if (settled) return;
        settled = true;
        resolve();
      };
      track(element, "loadeddata", settle);
      track(element, "error", () => {
        if (!cancelled) failures.push(`media failed to load: ${label}`);
        settle();
      });
      // <source>-children report their own failures; the media element itself
      // never fires error when every source candidate fails.
      for (const sourceElement of sourceElements) {
        track(sourceElement, "error", () => {
          failedSourceCount += 1;
          if (failedSourceCount >= sourceElements.length && !settled) {
            if (!cancelled) failures.push(`media has no usable source: ${label}`);
            settle();
          }
        });
      }
    });
  }

  if (container && typeof container.querySelectorAll === "function") {
    for (const element of Array.from(container.querySelectorAll(RESOURCE_SELECTOR))) {
      const tag = typeof element.tagName === "string" ? element.tagName.toLowerCase() : "";
      const waiter = tag === "video" || tag === "audio" ? waitMediaResource(element) : waitImageResource(element);
      if (waiter) waiters.push(waiter);
    }
  }

  const promise = (async () => {
    try {
      await Promise.all(waiters.map((waiter) => Promise.race([waiter, cancelledPromise])));
    } catch (error) {
      cleanup();
      throw cancelled && cancelError ? cancelError : error;
    }
    cleanup();
    if (cancelled) throw cancelError ?? new Error("slide resource wait cancelled");
    if (failures.length > 0) {
      throw new Error(`slide resources failed to load: ${failures.join("; ")}`);
    }
    return { fonts: usedFonts, resources: resourceCount, failures: [] };
  })();

  function cancel(reason) {
    if (cancelled) return;
    cancelled = true;
    cancelError = reason instanceof Error ? reason : new Error(String(reason ?? "slide resource wait cancelled"));
    cleanup();
    // Mark cancelledPromise handled even when no waiter race is pending
    // anymore, so the early rejection can never surface as unhandledRejection.
    void cancelledPromise.catch(() => {});
    rejectCancelled(cancelError);
    void promise.catch(() => {}); // a cancelled wait is expected to reject; never unhandled
  }

  return { promise, cancel };
}

/**
 * One-shot convenience wrapper: wait for all resources relevant to `container`.
 */
export function waitForSlideResources(deps = {}) {
  return createSlideResourcesWaiter(deps).promise;
}

/**
 * Create a Lattice Slide Runtime handle for one slide.
 *
 * Contract (PRD 3.3.2):
 *   ready()               mount slide html, await resources, then resolve
 *   seek(localFrame)      apply pure frame state (history-independent)
 *   painted(localFrame)   resolve once the requested frame is applied and
 *                         the compositor has settled (double rAF in browsers)
 *   destroy()             unmount and invalidate the handle
 *
 * Readiness (PRD 3.1.3): ready() always runs the default deterministic
 * resource barrier (fonts + every declared image/SVG-image/video/audio inside
 * the mounted container) before resolving. The `waitForResources` hook EXTENDS
 * that default — it is awaited alongside it and can never replace or disable
 * it. Injected primitives (`document`, `requestAnimationFrame`) keep the whole
 * contract testable in plain Node.
 */
export function createSlideRuntime({
  slide,
  container,
  requestAnimationFrame = globalThis.requestAnimationFrame,
  waitForResources = null,
  document: documentRef = globalThis.document,
} = {}) {
  if (!slide || typeof slide !== "object") {
    throw new TypeError("createSlideRuntime requires a SlideDefinition");
  }
  if (!container) {
    throw new TypeError("createSlideRuntime requires a container element");
  }

  let phase = "idle";
  let appliedFrame = null;
  let activeResourceWaiter = null;

  async function ready() {
    if (phase === "destroyed") throw new Error("slide runtime already destroyed");
    if (phase === "ready") return;
    const html = resolveSlideHtml(slide);
    if (typeof html !== "string") {
      throw new TypeError(`slide "${slide.id}" html must resolve to a string`);
    }
    container.innerHTML = html;
    // Runtime-owned stable structural identity (PRD 3.1.1): the mounted
    // runtime root carries a stable data-lattice-id derived from slide.id.
    container.setAttribute?.("data-lattice-slide-id", slide.id);
    container.setAttribute?.("data-lattice-id", slide.id);
    const waiter = createSlideResourcesWaiter({ container, document: documentRef });
    activeResourceWaiter = waiter;
    try {
      if (waitForResources) {
        // Caller hook extends the default barrier; it never replaces it.
        await Promise.all([waiter.promise, Promise.resolve().then(waitForResources)]);
      } else {
        await waiter.promise;
      }
    } catch (error) {
      waiter.cancel(error);
      throw error;
    } finally {
      activeResourceWaiter = null;
    }
    phase = "ready";
  }

  async function seek(localFrame) {
    if (phase === "destroyed") throw new Error("slide runtime already destroyed");
    if (phase !== "ready") throw new Error("slide runtime is not ready; call ready() before seek()");
    const state = computeSlideFrameState(slide, localFrame);
    applyFrameState(container, state);
    appliedFrame = localFrame;
    return state;
  }

  async function painted(localFrame) {
    if (phase === "destroyed") throw new Error("slide runtime already destroyed");
    if (phase !== "ready") throw new Error("slide runtime is not ready; call ready() before painted()");
    const address = assertFrameAddress({ slideId: slide.id, localFrame }, { label: `painted() address for slide "${slide.id}"` });
    if (appliedFrame !== address.localFrame) {
      throw new Error(
        `painted(${address.localFrame}) requested before seek(${address.localFrame}) applied that frame (applied: ${String(appliedFrame)})`,
      );
    }
    await nextTick({ requestAnimationFrame });
    if (appliedFrame !== localFrame) {
      throw new Error(`frame ${localFrame} changed while waiting for paint`);
    }
    return snapshotSlideFrameState(container);
  }

  function destroy() {
    if (phase === "destroyed") return;
    if (activeResourceWaiter) {
      activeResourceWaiter.cancel(new Error(`slide "${slide.id}" runtime destroyed while waiting for resources`));
      activeResourceWaiter = null;
    }
    clearFrameState(container);
    for (const name of ["data-lattice-slide-id", "data-lattice-id"]) container.removeAttribute?.(name);
    container.innerHTML = "";
    phase = "destroyed";
    appliedFrame = null;
  }

  return { ready, seek, painted, destroy };
}
