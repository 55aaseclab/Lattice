/*
 * Lattice Presentation browser surface (M2).
 *
 * The engine-neutral state machine (../presentation/index.js) owns every
 * navigation decision; this module only interprets its intents on top of the
 * integer-frame Slide Runtime (ready/seek/painted/destroy). It never imports,
 * probes, or initializes a video backend (A14), mounts each slide through the
 * shared runtime so arbitrary seeks stay history-independent, and keeps the
 * audience DOM free of presenter notes (A18).
 *
 * This module deliberately has NO top-level CSS import so it stays importable
 * in plain Node (backend-isolation proof); consumers import
 * "lattice-runtime/renderer/presentation.css" alongside it.
 */

import {
  PRESENTATION_URL_PARAMS,
  createPresentationModel,
  currentPresentationStep,
  formatPresentationAddress,
  parsePresentationAddress,
  playSegmentFrames,
  presentationAddressParams,
  presentationEnterBranch,
  presentationExitBranch,
  presentationFirst,
  presentationLast,
  presentationNext,
  presentationPrevious,
  presentationJumpToStop,
} from "../presentation/index.js";
import { createSlideRuntime, resolveSlideHtml } from "../slide-runtime/index.js";

const PARAMS = PRESENTATION_URL_PARAMS;

const INTERACTIVE_SELECTOR = [
  "button",
  "a",
  "input",
  "select",
  "textarea",
  "summary",
  "details",
  "[contenteditable]",
  "[tabindex]:not([tabindex='-1'])",
].join(", ");

const TOUCH_SWIPE_THRESHOLD_PX = 40;

const NOTE_SOURCE_SELECTOR = ".slide-note-source";

export class PresentationAddressError extends Error {
  constructor(deckId, errors) {
    super(
      `[lattice-presentation] invalid presentation address for deck "${deckId}": ` +
        errors.map((error) => `${error.code}: ${error.message}`).join("; "),
    );
    this.name = "PresentationAddressError";
    this.deckId = deckId;
    this.errors = errors;
  }
}

// ---- Slide html preparation ----

/**
 * Extract and remove presenter notes from the slide html. The mounted stage
 * never carries notes; presenter notes render only in the dedicated notes
 * panel of presenter mode (A18).
 */
export function stripSlideNotes(html) {
  if (typeof document === "undefined") return { html, note: null };
  const parsed = new DOMParser().parseFromString(`<body>${html}</body>`, "text/html");
  const notes = parsed.body.querySelectorAll(NOTE_SOURCE_SELECTOR);
  let note = null;
  if (notes.length > 0) {
    const text = Array.from(notes).map((element) => element.textContent?.trim() ?? "").filter(Boolean).join("\n\n");
    note = text !== "" ? text : null;
    notes.forEach((element) => element.remove());
  }
  return { html: parsed.body.innerHTML, note };
}

// ---- Error surface ----

/**
 * Explicit invalid-address screen. Nothing from the deck is mounted and no
 * other content is substituted (A17: never fall back to wrong content).
 */
export function renderPresentationError(container, { deckId, title = "Presentation", errors = [], missingDeckId = null } = {}) {
  const heading = missingDeckId ? `Unknown deck "${missingDeckId}"` : "Invalid presentation address";
  const details = errors.length > 0
    ? errors.map((error) => `<li><code>${escapeHtml(error.code)}</code> ${escapeHtml(error.message)}</li>`).join("")
    : "";
  container.innerHTML = `
    <div class="lattice-presentation lattice-presentation-error" data-lattice-presentation-error="invalid-address" role="alert">
      <div class="lattice-presentation-error-card">
        <h1>${escapeHtml(heading)}</h1>
        <p>${escapeHtml(title)} cannot be presented at this address. No fallback content is shown.</p>
        ${details ? `<ul class="lattice-presentation-error-list">${details}</ul>` : ""}
        <p><a href="${escapeHtml(window.location.pathname)}">Back to the deck list</a></p>
      </div>
    </div>`;
  return { ok: false, errors };
}

// ---- Main surface ----

export async function renderPresentationApp(container, deckDescriptor, options = {}) {
  if (typeof document === "undefined" || typeof window === "undefined") {
    throw new Error("[lattice-presentation] renderPresentationApp requires a browser document/window");
  }
  const {
    presenter = false,
    history = window.history,
    location = window.location,
    fpsFallback = 30,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    requestAnimationFrame = window.requestAnimationFrame?.bind(window) ?? ((fn) => setTimeout(fn, 0)),
    matchMedia = window.matchMedia?.bind(window) ?? (() => ({ matches: false })),
    exposeHook = true,
  } = options;

  const model = createPresentationModel(deckDescriptor);
  const fps = model.fps ?? fpsFallback;

  const parsed = parsePresentationAddress(model, new URLSearchParams(new URL(location.href).search));
  if (!parsed.ok) {
    const failure = renderPresentationError(container, { deckId: model.deckId, title: model.title, errors: parsed.errors });
    if (exposeHook) {
      window.__latticePresentation = {
        deckId: model.deckId,
        error: () => failure,
        ready: () => false,
        address: () => null,
        isPlaying: () => false,
      };
    }
    return { ok: false, errors: parsed.errors, model };
  }

  const freezeAddressState = (address) =>
    Object.freeze({
      routeId: address.routeId,
      slideId: address.slideId,
      stopId: address.stopId,
      branchOrigin: address.branchOrigin ? Object.freeze({ ...address.branchOrigin }) : null,
    });

  const initial = freezeAddressState(parsed.address);

  container.innerHTML = `
    <div class="lattice-presentation" data-lattice-presentation data-lattice-presentation-deck="${escapeHtml(model.deckId)}" role="application" aria-roledescription="presentation" aria-label="${escapeHtml(model.title)}" data-lattice-presentation-ready="false" data-lattice-presenter="${presenter ? "true" : "false"}" data-lattice-audience-projection="false">
      <div class="lattice-presentation-stage" data-lattice-stage>
        <div class="lattice-presentation-canvas" data-lattice-canvas></div>
      </div>
      <div class="lattice-presentation-hud" data-lattice-hud>
        <button type="button" class="lattice-presentation-button" data-lattice-nav="previous" aria-label="Previous step" title="Previous step">◀</button>
        <span class="lattice-presentation-position" data-lattice-position aria-hidden="true"></span>
        <button type="button" class="lattice-presentation-button" data-lattice-nav="next" aria-label="Next step" title="Next step">▶</button>
        <details class="lattice-presentation-routes" data-lattice-routes>
          <summary aria-label="Routes">Routes</summary>
          <ul data-lattice-route-list role="menu" aria-label="Deck routes"></ul>
        </details>
        <button type="button" class="lattice-presentation-button" data-lattice-branch-return aria-label="Return to parent route" hidden>↩ Back</button>
        ${presenter ? `<button type="button" class="lattice-presentation-button" data-lattice-audience-button aria-label="Project audience view" aria-pressed="false" title="Project the audience canvas fullscreen (M8)">▣</button>` : ""}
        <button type="button" class="lattice-presentation-button" data-lattice-fullscreen aria-label="Toggle fullscreen" aria-pressed="false" title="Fullscreen (F)">⛶</button>
      </div>
      <p class="lattice-visually-hidden" data-lattice-live aria-live="polite" aria-atomic="true"></p>
      ${presenter ? '<aside class="lattice-presentation-notes" data-lattice-notes aria-label="Presenter notes"><h2 class="lattice-presentation-notes-title">Notes</h2><div class="lattice-presentation-notes-body" data-lattice-notes-body></div></aside>' : ""}
    </div>`;

  const root = container.querySelector("[data-lattice-presentation]");
  const stage = root.querySelector("[data-lattice-stage]");
  const canvas = root.querySelector("[data-lattice-canvas]");
  const liveRegion = root.querySelector("[data-lattice-live]");
  const positionElement = root.querySelector("[data-lattice-position]");
  const routeList = root.querySelector("[data-lattice-route-list]");
  const routesDetails = root.querySelector("[data-lattice-routes]");
  const branchReturnButton = root.querySelector("[data-lattice-branch-return]");
  const fullscreenButton = root.querySelector("[data-lattice-fullscreen]");
  const audienceProjectionButton = root.querySelector("[data-lattice-audience-button]");
  const notesBody = root.querySelector("[data-lattice-notes-body]");
  const previousButton = root.querySelector('[data-lattice-nav="previous"]');
  const nextButton = root.querySelector('[data-lattice-nav="next"]');

  // ---- Internal session ----

  let current = initial;
  let runtime = null;
  let mountedSlideId = null;
  let navToken = 0;
  let playing = false;
  let playTrace = [];
  let fullscreenError = null;
  let queue = Promise.resolve();
  let destroyed = false;
  let popstateApplying = false;

  // ---- URL/history (A17) ----

  function locationUrl(addressState, { replace = false } = {}) {
    const url = new URL(location.href);
    url.searchParams.set(PARAMS.deck, model.deckId);
    url.searchParams.set(PARAMS.present, "1");
    if (presenter) url.searchParams.set(PARAMS.presenter, "1");
    else url.searchParams.delete(PARAMS.presenter);
    const params = presentationAddressParams(addressState);
    for (const key of [PARAMS.route, PARAMS.slide, PARAMS.stop, PARAMS.originRoute, PARAMS.originSlide, PARAMS.originStop]) {
      url.searchParams.delete(key);
    }
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    history[replace ? "replaceState" : "pushState"](null, "", `${url.pathname}${url.search}`);
    return `${url.pathname}${url.search}`;
  }

  async function applyFromLocation() {
    const nextParsed = parsePresentationAddress(model, new URLSearchParams(new URL(location.href).search));
    if (!nextParsed.ok) {
      renderPresentationError(container, { deckId: model.deckId, title: model.title, errors: nextParsed.errors });
      return false;
    }
    current = freezeAddressState(nextParsed.address);
    await mountAndPaint();
    return true;
  }

  async function onPopState() {
    if (destroyed || popstateApplying) return;
    popstateApplying = true;
    try {
      await applyFromLocation();
    } finally {
      popstateApplying = false;
    }
  }

  // ---- Slide runtime mounting ----

  async function ensureRuntime(slideId) {
    const slide = deckDescriptor.slides.find((entry) => entry.id === slideId);
    if (!slide) throw new Error(`[lattice-presentation] slide "${slideId}" is missing from the deck descriptor`);
    if (runtime && mountedSlideId === slideId) return runtime;
    if (runtime) {
      runtime.destroy();
      runtime = null;
      mountedSlideId = null;
    }
    const { html, note } = stripSlideNotes(resolveSlideHtml(slide));
    const presentable = { ...slide, html: () => html };
    const nextRuntime = createSlideRuntime({ slide: presentable, container: canvas });
    await nextRuntime.ready();
    runtime = nextRuntime;
    mountedSlideId = slideId;
    if (notesBody) {
      const noteText = note ?? (typeof deckDescriptor.notes?.[slideId] === "string" ? deckDescriptor.notes[slideId] : null);
      notesBody.textContent = noteText ?? "No notes for this slide.";
    }
    return runtime;
  }

  async function paintFrame(targetFrame) {
    await runtime.seek(targetFrame);
    await runtime.painted(targetFrame);
  }

  async function mountAndPaint() {
    const token = ++navToken;
    playing = false;
    root.removeAttribute("data-lattice-playing");
    const { slide, stop } = currentPresentationStep(model, current);
    await ensureRuntime(slide.id);
    if (token !== navToken || destroyed) return;
    await paintFrame(stop.frame);
    if (token !== navToken || destroyed) return;
    renderStatus();
  }

  // ---- Play segment (A15) ----

  async function runPlaySegment(intent) {
    const token = navToken;
    playing = true;
    playTrace = [];
    root.setAttribute("data-lattice-playing", "true");
    // Start exactly on the current stop's frame, then advance to the target.
    await paintFrame(intent.fromFrame);
    if (token !== navToken || destroyed) return;
    const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)")?.matches === true;
    const frames = reduceMotion ? [] : playSegmentFrames(intent);
    for (const frame of frames) {
      if (token !== navToken || destroyed) return;
      await paintFrame(frame);
      if (token !== navToken || destroyed) return;
      playTrace.push(frame);
      await sleep(Math.max(0, Math.round(1000 / fps)));
    }
    if (token !== navToken || destroyed) return;
    // Pause exactly on the target stop frame — never one frame beyond. When
    // the loop already landed there this is an idempotent re-paint; in
    // reduced-motion mode it is the only paint. Recorded exactly once.
    await paintFrame(intent.toFrame);
    if (token !== navToken || destroyed) return;
    if (playTrace[playTrace.length - 1] !== intent.toFrame) playTrace.push(intent.toFrame);
    playing = false;
    root.removeAttribute("data-lattice-playing");
    renderStatus();
  }

  // ---- Transition plumbing ----

  function enqueueTransition(transition) {
    queue = queue.then(async () => {
      if (destroyed) return;
      const result = transition();
      if (!result.intent) {
        renderStatus();
        return;
      }
      current = result.state;
      const token = ++navToken;
      locationUrl(current);
      if (result.intent.kind === "play") {
        renderStatus();
        await ensureRuntime(current.slideId);
        if (token !== navToken || destroyed) return;
        await runPlaySegment(result.intent);
      } else {
        const { slide, stop } = currentPresentationStep(model, current);
        await ensureRuntime(slide.id);
        if (token !== navToken || destroyed) return;
        await paintFrame(stop.frame);
        if (token !== navToken || destroyed) return;
        playing = false;
        root.removeAttribute("data-lattice-playing");
        renderStatus();
      }
    }, () => {});
    return queue;
  }

  function renderStatus() {
    if (destroyed) return;
    const route = model.routes.get(current.routeId);
    const slideNumber = route.indexOf(current.slideId) + 1;
    const { index } = currentPresentationStep(model, current);
    const stepCount = model.slides.get(current.slideId).stops.length;
    positionElement.textContent = `${slideNumber} / ${route.length} · step ${index + 1} / ${stepCount}`;
    liveRegion.textContent = `Slide ${slideNumber} of ${route.length}: ${current.slideId}. Step ${index + 1} of ${stepCount}: ${current.stopId}.`;
    root.setAttribute("data-lattice-address", formatPresentationAddress(current));
    renderRoutes();
    root.setAttribute("data-lattice-presentation-ready", "true");
  }

  function renderRoutes() {
    routeList.innerHTML = "";
    for (const routeId of model.routes.keys()) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.setAttribute("role", "menuitem");
      button.setAttribute("data-lattice-route", routeId);
      button.setAttribute("aria-label", routeId === current.routeId ? `Current route ${routeId}` : `Enter route ${routeId}`);
      button.setAttribute("aria-current", routeId === current.routeId ? "true" : "false");
      button.textContent = routeId === "main" ? "main" : `↳ ${routeId}`;
      button.addEventListener("click", () => {
        routesDetails.open = false;
        void enterBranch(routeId);
      });
      item.append(button);
      routeList.append(item);
    }
    const inBranch = Boolean(current.branchOrigin);
    branchReturnButton.hidden = !inBranch;
    if (inBranch) branchReturnButton.textContent = `↩ Back to ${current.branchOrigin.routeId}`;
  }

  // ---- Public actions ----

  function next() {
    return enqueueTransition(() => presentationNext(model, current));
  }

  function previous() {
    return enqueueTransition(() => presentationPrevious(model, current));
  }

  function first() {
    return enqueueTransition(() => presentationFirst(model, current));
  }

  function last() {
    return enqueueTransition(() => presentationLast(model, current));
  }

  function jumpTo({ slideId, stopId, routeId } = {}) {
    return enqueueTransition(() => presentationJumpToStop(model, current, { routeId: routeId ?? current.routeId, slideId, stopId }));
  }

  function enterBranch(routeId) {
    return enqueueTransition(() => presentationEnterBranch(model, current, routeId));
  }

  function exitBranch() {
    return enqueueTransition(() => presentationExitBranch(model, current));
  }

  async function settle() {
    while (playing) await sleep(0);
    await queue;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  // ---- Keyboard (A16/A19) ----

  function onKeyDown(event) {
    if (destroyed || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target;
    // Interactive-control focus protection: a focused control keeps its own
    // keys (Space activates buttons, arrows work inside inputs) and never
    // drives deck navigation.
    if (target && typeof target.closest === "function" && target.closest(INTERACTIVE_SELECTOR)) return;
    switch (event.key) {
      case "ArrowRight":
      case "PageDown":
      case " ":
        event.preventDefault();
        void next();
        return;
      case "ArrowLeft":
      case "PageUp":
        event.preventDefault();
        void previous();
        return;
      case "Home":
        event.preventDefault();
        void first();
        return;
      case "End":
        event.preventDefault();
        void last();
        return;
      case "f":
      case "F":
        event.preventDefault();
        void toggleFullscreen();
        return;
      case "Escape":
        // M8: one-key return from the audience projection. In true fullscreen
        // the browser consumes Esc itself and the fullscreenchange handler
        // flips the role view; this branch covers the viewport-filling
        // fallback. Outside the projection Escape stays inert (M2 unchanged).
        if (audienceProjectionActive()) {
          event.preventDefault();
          void exitAudienceProjection();
        }
        return;
      default:
        return;
    }
  }

  // ---- Touch (A19) ----
  //
  // Real touch gestures frequently end in pointercancel (the browser cancels
  // pointer events once it classifies the contact as a gesture), so the swipe
  // commits as soon as the horizontal threshold is crossed during move — not
  // only on pointerup. Vertical intent cancels the swipe; mouse pointers are
  // ignored entirely.

  let swipe = null;
  // M8: set when a touch swipe actually navigates, so the click event that
  // some browsers synthesize after a gesture cannot be misread as the
  // one-click "return to presenter view" action in audience projection.
  let swipeCommitted = false;

  function swipeDelta(event) {
    return { dx: event.clientX - swipe.startX, dy: event.clientY - swipe.startY };
  }

  function commitSwipe(dx, dy) {
    if (Math.abs(dx) >= TOUCH_SWIPE_THRESHOLD_PX && Math.abs(dx) > Math.abs(dy)) {
      swipe = null;
      swipeCommitted = true;
      if (dx < 0) void next();
      else void previous();
      return true;
    }
    return false;
  }

  function onPointerDown(event) {
    if (destroyed || event.pointerType !== "touch" || !event.isPrimary) return;
    if (event.target?.closest?.(INTERACTIVE_SELECTOR)) return;
    swipeCommitted = false;
    swipe = { startX: event.clientX, startY: event.clientY, pointerId: event.pointerId };
  }

  function onPointerMove(event) {
    if (!swipe || destroyed || event.pointerId !== swipe.pointerId) return;
    const { dx, dy } = swipeDelta(event);
    if (Math.abs(dy) > Math.abs(dx) && Math.abs(dy) >= TOUCH_SWIPE_THRESHOLD_PX) {
      swipe = null; // vertical intent: scroll gesture, not navigation
      return;
    }
    commitSwipe(dx, dy);
  }

  function onPointerUp(event) {
    if (!swipe || destroyed || event.pointerId !== swipe.pointerId) return;
    const { dx, dy } = swipeDelta(event);
    swipe = null;
    commitSwipe(dx, dy);
  }

  function onPointerCancel(event) {
    if (!swipe || destroyed || event.pointerId !== swipe.pointerId) return;
    swipe = null;
  }

  // M8 one-click return: while the audience projection is active the whole
  // stage is the return control. Outside the projection a stage click is
  // inert, so M2 click/touch semantics stay untouched.
  function onStageClick(event) {
    if (destroyed || !audienceProjectionActive()) return;
    if (swipeCommitted) {
      swipeCommitted = false;
      return;
    }
    if (event.target?.closest?.(INTERACTIVE_SELECTOR)) return;
    void exitAudienceProjection();
  }

  // ---- Fullscreen (A19) ----

  async function toggleFullscreen() {
    try {
      // Fullscreen the presentation ROOT so the HUD stays inside the top
      // layer and remains operable; the stage then fills the root.
      if (document.fullscreenElement === root) {
        await document.exitFullscreen();
      } else {
        await root.requestFullscreen();
      }
      fullscreenError = null;
    } catch (error) {
      fullscreenError = String(error?.message ?? error);
      root.setAttribute("data-lattice-fullscreen-error", fullscreenError);
    }
  }

  function onFullscreenChange() {
    const active = document.fullscreenElement === root;
    fullscreenButton.setAttribute("aria-pressed", String(active));
    fullscreenButton.setAttribute("aria-label", active ? "Exit fullscreen" : "Toggle fullscreen");
    root.setAttribute("data-lattice-fullscreen-active", active ? "true" : "false");
    // M8: the native Esc exit is the presenter's one-key return — leaving
    // fullscreen always also leaves audience projection, restoring the
    // presenter role view (notes + controls).
    if (!active && audienceProjectionActive()) setAudienceProjection(false);
    fitCanvas();
  }

  // ---- Audience projection (M8, presenter role view) ----
  //
  // The presenter flips their running presentation into the audience role
  // view with one click: the deck canvas fills the screen as a pure
  // projection (HUD + notes hidden) while the state machine keeps running —
  // keyboard navigation, live region and URL state are untouched, so next/
  // previous keep working during the projection. Returning is one action:
  // Esc (native fullscreen exit), a click/tap on the projected stage, or the
  // projection toggle. This is the "in-place fullscreen stage" option of the
  // M8 contract; a synced second window would duplicate the state machine
  // and was deliberately not taken. When the Fullscreen API is unavailable
  // (some headless engines), the projection degrades to the viewport-filling
  // fixed root — the audience-projection attribute still applies.

  function audienceProjectionActive() {
    return root.getAttribute("data-lattice-audience-projection") === "true";
  }

  function setAudienceProjection(active, { announce = true } = {}) {
    root.setAttribute("data-lattice-audience-projection", active ? "true" : "false");
    if (audienceProjectionButton) {
      audienceProjectionButton.setAttribute("aria-pressed", String(active));
      audienceProjectionButton.setAttribute("aria-label", active ? "Return to presenter view" : "Project audience view");
    }
    if (announce) {
      liveRegion.textContent = active
        ? "Audience projection on. Press Escape or click the slide to return to presenter view."
        : "Returned to presenter view.";
    }
  }

  async function toggleAudienceProjection() {
    const nextActive = !audienceProjectionActive();
    setAudienceProjection(nextActive);
    try {
      if (nextActive && document.fullscreenElement !== root) await root.requestFullscreen();
      if (!nextActive && document.fullscreenElement === root) await document.exitFullscreen();
      fullscreenError = null;
    } catch (error) {
      // The projection itself stays active (viewport-filling fallback); the
      // fullscreen failure is recorded through the existing M2 channel.
      fullscreenError = String(error?.message ?? error);
      root.setAttribute("data-lattice-fullscreen-error", fullscreenError);
    }
  }

  async function exitAudienceProjection() {
    if (!audienceProjectionActive()) return;
    setAudienceProjection(false);
    try {
      if (document.fullscreenElement === root) await document.exitFullscreen();
    } catch {
      // Fullscreen may already be gone; the role view flip above is what matters.
    }
  }

  // ---- Canvas fit ----

  function fitCanvas() {
    const canvasWidth = deckDescriptor.canvas?.width ?? 960;
    const canvasHeight = deckDescriptor.canvas?.height ?? 540;
    const scale = Math.min(stage.clientWidth / canvasWidth, stage.clientHeight / canvasHeight) || 1;
    canvas.style.width = `${canvasWidth}px`;
    canvas.style.height = `${canvasHeight}px`;
    canvas.style.setProperty("--lattice-presentation-scale", String(scale));
  }

  function onResize() {
    if (destroyed) return;
    fitCanvas();
  }

  // ---- Wire up ----

  previousButton.addEventListener("click", () => void previous());
  nextButton.addEventListener("click", () => void next());
  branchReturnButton.addEventListener("click", () => void exitBranch());
  fullscreenButton.addEventListener("click", () => void toggleFullscreen());
  audienceProjectionButton?.addEventListener("click", () => void toggleAudienceProjection());
  stage.addEventListener("click", onStageClick);
  document.addEventListener("keydown", onKeyDown);
  document.addEventListener("fullscreenchange", onFullscreenChange);
  window.addEventListener("resize", onResize);
  window.addEventListener("popstate", onPopState);
  stage.addEventListener("pointerdown", onPointerDown);
  stage.addEventListener("pointermove", onPointerMove);
  stage.addEventListener("pointerup", onPointerUp);
  stage.addEventListener("pointercancel", onPointerCancel);

  // ---- Boot ----

  locationUrl(current, { replace: true });
  await mountAndPaint();
  fitCanvas();

  function notesInAudienceDom() {
    return root.querySelectorAll(`${NOTE_SOURCE_SELECTOR}, [data-lattice-notes]`).length;
  }

  function presenterNotesText() {
    return notesBody?.textContent?.trim() ?? null;
  }

  function normalizedState() {
    return {
      address: { ...current },
      playing,
      attributes: {
        frame: canvas.getAttribute("data-lattice-frame"),
        stop: canvas.getAttribute("data-lattice-stop"),
        stopIndex: canvas.getAttribute("data-lattice-stop-index"),
        revealedStops: canvas.getAttribute("data-lattice-revealed-stops"),
        slideId: canvas.getAttribute("data-lattice-slide-id"),
      },
      variables: {
        localFrame: canvas.style.getPropertyValue("--lattice-local-frame"),
        stopFrame: canvas.style.getPropertyValue("--lattice-stop-frame"),
      },
    };
  }

  const hook = {
    deckId: model.deckId,
    ready: () => root.getAttribute("data-lattice-presentation-ready") === "true",
    address: () => ({ ...current }),
    url: () => `${location.pathname}${location.search}`,
    isPlaying: () => playing,
    playTrace: () => [...playTrace],
    error: () => null,
    fullscreenError: () => fullscreenError,
    liveRegionText: () => liveRegion.textContent,
    positionText: () => positionElement.textContent,
    notesInAudienceDom,
    presenterNotesText,
    mountedSlideId: () => mountedSlideId,
    normalizedState,
    next,
    previous,
    first,
    last,
    jumpTo,
    enterBranch,
    exitBranch,
    settle,
    toggleFullscreen,
    toggleAudienceProjection,
    audienceProjectionActive,
    exitAudienceProjection,
    fitCanvas,
    focusInteractive(selector) {
      const element = container.querySelector(selector);
      element?.focus();
      return document.activeElement === element;
    },
    destroy() {
      destroyed = true;
      navToken += 1;
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("popstate", onPopState);
      stage.removeEventListener("pointerdown", onPointerDown);
      stage.removeEventListener("pointermove", onPointerMove);
      stage.removeEventListener("pointerup", onPointerUp);
      stage.removeEventListener("pointercancel", onPointerCancel);
      stage.removeEventListener("click", onStageClick);
      runtime?.destroy();
      runtime = null;
      container.innerHTML = "";
    },
  };

  if (exposeHook) window.__latticePresentation = hook;
  return { ok: true, model, hook, state: current };
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

/**
 * Portal entry: boots the v2 presentation for the selected deck id, with an
 * explicit unknown-deck error surface (no fallback to the v1 deck app).
 */
export function bootPresentation(container, { deckId, v2Decks, presenter = false, location = window.location } = {}) {
  const deck = v2Decks?.[deckId];
  if (!deck) {
    const failure = renderPresentationError(container, {
      deckId,
      missingDeckId: deckId,
      errors: [{ code: "unknown-deck", param: PARAMS.deck, value: deckId, message: `deck ${JSON.stringify(deckId ?? null)} is not a lattice.deck.v2 presentation deck` }],
    });
    if (typeof window !== "undefined") {
      window.__latticePresentation = {
        deckId: deckId ?? null,
        error: () => failure,
        ready: () => false,
        address: () => null,
        isPlaying: () => false,
      };
    }
    return failure;
  }
  return renderPresentationApp(container, deck, { presenter, location });
}
