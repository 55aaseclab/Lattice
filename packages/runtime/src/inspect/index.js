import { createValidationIssue } from "../validator/index.js";
import { describeElement, elementArea, slideAddress } from "./address.js";

export { describeElement, elementArea, slideAddress } from "./address.js";

const DEFAULT_OVERFLOW_SELECTOR = [
  "[data-inspector-name]",
  ".ph",
  ".sl-grid-cell",
].join(", ");

const DEFAULT_DENSITY_SELECTOR = [
  "[data-inspector-name]",
  ".slide-table",
  ".slide-figure",
  ".slide-textbox",
  ".sl-grid-cell",
].join(", ");

const DEFAULT_CONTRAST_PAIRS = [
  { foreground: "--title-color", background: "--slide-bg", token: "title-color/slide-bg" },
  { foreground: "--body-color", background: "--slide-bg", token: "body-color/slide-bg" },
];

const round = (value, precision = 2) => {
  const factor = 10 ** precision;
  return Math.round(value * factor) / factor;
};

const compactText = (value, maximum = 64) => {
  const normalized = String(value || "").replace(/\s+/g, " ").trim();
  return normalized.length > maximum
    ? `${normalized.slice(0, maximum - 1).trimEnd()}…`
    : normalized;
};

const isVisible = (element, style) =>
  style.display !== "none" &&
  style.visibility !== "hidden" &&
  Number.parseFloat(style.opacity || "1") > 0 &&
  element.getClientRects?.().length !== 0;

export function inspectTextOverflow(
  slide,
  {
    slide: requestedSlide,
    selector = DEFAULT_OVERFLOW_SELECTOR,
    tolerance = 1,
    getStyle,
  } = {},
) {
  if (!slide?.querySelectorAll) throw new TypeError("[lattice-inspect] slide must be a DOM element");
  const address = requestedSlide ?? slideAddress(slide);
  const view = slide.ownerDocument?.defaultView ?? globalThis.window;
  const computedStyle = getStyle ?? ((element) => view.getComputedStyle(element));
  const errors = [];
  const seen = new Set();

  for (const element of slide.querySelectorAll(selector)) {
    const style = computedStyle(element);
    if (!isVisible(element, style)) continue;
    if (element.clientWidth <= 0 || element.clientHeight <= 0) continue;
    const overflowX = element.scrollWidth - element.clientWidth;
    const overflowY = element.scrollHeight - element.clientHeight;
    if (overflowX <= tolerance && overflowY <= tolerance) continue;

    const descriptor = describeElement(element);
    const area = elementArea(element);
    const key = `${area}\u0000${descriptor}`;
    if (seen.has(key)) continue;
    seen.add(key);
    errors.push(createValidationIssue({
      type: "text-overflow",
      slide: address,
      area,
      element: descriptor,
      overflow: { x: round(Math.max(0, overflowX)), y: round(Math.max(0, overflowY)) },
      message: `${descriptor} overflows${area ? ` area "${area}"` : " its box"} by ${round(Math.max(0, overflowX))}px horizontally and ${round(Math.max(0, overflowY))}px vertically`,
    }));
  }
  return { ok: errors.length === 0, errors };
}

const textWithoutAuthoringLayers = (slide) => {
  const clone = slide.cloneNode(true);
  clone.querySelectorAll?.([
    ".sl-grid-overlay",
    ".sl-dimension-overlay",
    ".slide-note-source",
    ".slide-page-number",
    "script",
    "style",
  ].join(", ")).forEach((element) => element.remove());
  return compactText(clone.textContent, Number.POSITIVE_INFINITY);
};

export function inspectSlideDensity(
  slide,
  {
    slide: requestedSlide,
    selector = DEFAULT_DENSITY_SELECTOR,
    maxElements = 60,
    maxWords = 220,
  } = {},
) {
  if (!slide?.querySelectorAll) throw new TypeError("[lattice-inspect] slide must be a DOM element");
  const address = requestedSlide ?? slideAddress(slide);
  const elements = new Set(slide.querySelectorAll(selector));
  const words = textWithoutAuthoringLayers(slide).match(/[\p{L}\p{N}]+(?:['’.-][\p{L}\p{N}]+)*/gu) || [];
  if (elements.size <= maxElements && words.length <= maxWords) return { ok: true, errors: [] };
  const exceeded = [
    elements.size > maxElements ? `${elements.size} elements (limit ${maxElements})` : "",
    words.length > maxWords ? `${words.length} words (limit ${maxWords})` : "",
  ].filter(Boolean).join(" and ");
  return {
    ok: false,
    errors: [createValidationIssue({
      type: "density",
      slide: address,
      counts: { elements: elements.size, words: words.length },
      limits: { elements: maxElements, words: maxWords },
      message: `slide ${address ?? "unknown"} exceeds density threshold: ${exceeded}`,
    })],
  };
}

const parseHexColor = (value) => {
  const match = value.match(/^#([\da-f]{3,8})$/i);
  if (!match) return null;
  let source = match[1];
  if ([3, 4].includes(source.length)) source = [...source].map((part) => `${part}${part}`).join("");
  if (![6, 8].includes(source.length)) return null;
  return {
    r: Number.parseInt(source.slice(0, 2), 16),
    g: Number.parseInt(source.slice(2, 4), 16),
    b: Number.parseInt(source.slice(4, 6), 16),
    a: source.length === 8 ? Number.parseInt(source.slice(6, 8), 16) / 255 : 1,
  };
};

export function parseCssColor(value) {
  const normalized = String(value || "").trim();
  const hex = parseHexColor(normalized);
  if (hex) return hex;
  const match = normalized.match(/^rgba?\(\s*([\d.]+)(?:\s+|\s*,\s*)([\d.]+)(?:\s+|\s*,\s*)([\d.]+)(?:\s*(?:\/|,)\s*([\d.]+)%?)?\s*\)$/i);
  if (!match) return null;
  const alpha = match[4] === undefined
    ? 1
    : Math.max(0, Math.min(1, Number(match[4]) / (normalized.includes("%") ? 100 : 1)));
  return {
    r: Math.max(0, Math.min(255, Number(match[1]))),
    g: Math.max(0, Math.min(255, Number(match[2]))),
    b: Math.max(0, Math.min(255, Number(match[3]))),
    a: alpha,
  };
}

const composite = (foreground, background) => {
  const alpha = foreground.a + background.a * (1 - foreground.a);
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha,
    g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha,
    b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha,
    a: alpha,
  };
};

const luminance = ({ r, g, b }) => {
  const linear = [r, g, b].map((channel) => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
};

export function contrastRatio(foreground, background) {
  const foregroundColor = typeof foreground === "string" ? parseCssColor(foreground) : foreground;
  const backgroundColor = typeof background === "string" ? parseCssColor(background) : background;
  if (!foregroundColor || !backgroundColor) return null;
  const opaqueBackground = backgroundColor.a < 1
    ? composite(backgroundColor, { r: 255, g: 255, b: 255, a: 1 })
    : backgroundColor;
  const opaqueForeground = foregroundColor.a < 1
    ? composite(foregroundColor, opaqueBackground)
    : foregroundColor;
  const values = [luminance(opaqueForeground), luminance(opaqueBackground)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

const resolveCustomProperty = (style, property, seen = new Set()) => {
  if (seen.has(property)) return "";
  seen.add(property);
  const value = style.getPropertyValue(property).trim();
  const reference = value.match(/^var\(\s*(--[\w-]+)(?:\s*,\s*(.+))?\)$/);
  if (!reference) return value;
  return resolveCustomProperty(style, reference[1], seen) || reference[2]?.trim() || "";
};

export function inspectThemeContrast(
  root,
  {
    pairs = DEFAULT_CONTRAST_PAIRS,
    minimum = 4.5,
    slide = null,
    getStyle,
  } = {},
) {
  if (!root) throw new TypeError("[lattice-inspect] contrast root is required");
  const view = root.ownerDocument?.defaultView ?? globalThis.window;
  const style = (getStyle ?? ((element) => view.getComputedStyle(element)))(root);
  const errors = [];
  for (const entry of pairs) {
    const pair = Array.isArray(entry)
      ? { foreground: entry[0], background: entry[1], token: `${entry[0]}/${entry[1]}` }
      : entry;
    const foreground = pair.foreground.startsWith("--")
      ? resolveCustomProperty(style, pair.foreground)
      : pair.foreground;
    const background = pair.background.startsWith("--")
      ? resolveCustomProperty(style, pair.background)
      : pair.background;
    const ratio = contrastRatio(foreground, background);
    if (ratio === null || ratio >= (pair.minimum ?? minimum)) continue;
    const token = pair.token || `${pair.foreground}/${pair.background}`;
    errors.push(createValidationIssue({
      type: "contrast",
      slide,
      token,
      ratio: round(ratio),
      minimum: pair.minimum ?? minimum,
      colors: { foreground, background },
      message: `${token} contrast is ${round(ratio)}:1; minimum is ${pair.minimum ?? minimum}:1`,
    }));
  }
  return { ok: errors.length === 0, errors };
}

export function inspectRenderedSlide(slide, options = {}) {
  const overflow = inspectTextOverflow(slide, options.overflow);
  const density = inspectSlideDensity(slide, options.density);
  const errors = [...overflow.errors, ...density.errors];
  return { ok: errors.length === 0, errors };
}

// ---- M9 creation-time visual lint (lattice.lint.v1) --------------------------
//
// Agent-consumable visual checks that go beyond the blocking overflow /
// density / contrast inspection: text spilling past the slide canvas,
// elements extending outside the canvas, and typography anomalies (font
// sizes and line-height ratios below the theme's own readability floor).
// Thresholds derive from theme tokens (--sl-lint-min-font-size,
// --sl-lint-min-line-height); a missing token disables its check instead of
// inventing a magic number. The grid container itself (.sl-grid) is excluded
// as an element — its box always equals the declared canvas size while the
// slide frame carries a 1px border — while its descendants stay in scope.

export const LINT_SCHEMA = "lattice.lint.v1";

const DEFAULT_LINT_EXCLUDED_SELECTOR = [
  ".sl-grid-overlay",
  ".sl-dimension-overlay",
  ".slide-note-source",
  "script",
  "style",
  "template",
].join(", ");

// Layout-system containers are excluded as elements themselves (their box is
// the declared canvas size while the slide frame carries a 1px border), but
// their descendants are ordinary content and stay in scope.
const LINT_SELF_EXCLUDED_SELECTOR = ".sl-grid";

const LINT_FINDING_TYPES = ["canvas-text-overflow", "element-out-of-bounds", "font-size-anomaly", "line-height-anomaly"];

export function resolveLintThresholds(root, getStyle) {
  const target = root?.documentElement ?? root;
  if (!target) return { minFontSizePx: null, minLineHeightRatio: null };
  const view = root?.defaultView ?? root?.ownerDocument?.defaultView ?? globalThis.window;
  const style = getStyle ? getStyle(target) : view?.getComputedStyle?.(target);
  const read = (token) => {
    const raw = style?.getPropertyValue?.(token)?.trim();
    if (!raw) return null;
    const value = Number.parseFloat(raw);
    return Number.isFinite(value) ? value : null;
  };
  return {
    minFontSizePx: read("--sl-lint-min-font-size"),
    minLineHeightRatio: read("--sl-lint-min-line-height"),
  };
}

const hasDirectText = (element) => {
  for (const node of element.childNodes ?? []) {
    if (node.nodeType === 3 && String(node.textContent ?? "").trim() !== "") return true;
  }
  return false;
};

const textRects = (element, createRange) => {
  if (!createRange) return [];
  try {
    const rects = [];
    for (const node of element.childNodes ?? []) {
      if (node.nodeType !== 3 || String(node.textContent ?? "").trim() === "") continue;
      const range = createRange();
      range.selectNodeContents(node);
      const list = range.getClientRects?.() ?? [];
      for (const rect of list) rects.push(rect);
    }
    return rects;
  } catch {
    return [];
  }
};

/**
 * Run every lint check on one slide. Returns { ok, findings, counts,
 * thresholds }; findings use the shared validation-issue shape (type /
 * slide / area / element / message) so agents consume one addressing
 * convention across validation, inspection, and lint.
 */
export function inspectSlideLint(slide, {
  slide: requestedSlide,
  tolerance = 0.5,
  outOfBounds = true,
  canvasTextOverflow = true,
  typography = true,
  excludedSelector = DEFAULT_LINT_EXCLUDED_SELECTOR,
  minFontSizePx = null,
  minLineHeightRatio = null,
  getStyle,
  createRange,
} = {}) {
  if (!slide?.querySelectorAll) throw new TypeError("[lattice-inspect] slide must be a DOM element");
  const address = requestedSlide ?? slideAddress(slide);
  const view = slide.ownerDocument?.defaultView ?? globalThis.window;
  const computedStyle = getStyle ?? ((element) => view.getComputedStyle(element));
  const rangeOf = createRange ?? slide.ownerDocument?.createRange?.bind(slide.ownerDocument) ?? globalThis.document?.createRange?.bind(globalThis.document) ?? null;
  const canvasBorderBox = slide.getBoundingClientRect?.() ?? null;
  // The canvas border belongs to the presentation frame, not to the slide
  // content area: measure against the client box (border excluded) so the
  // canvas's own 1px frame never reads as a constant out-of-bounds offset.
  let canvasRect = canvasBorderBox;
  if (canvasBorderBox) {
    const canvasStyle = computedStyle(slide);
    const borderLeft = Number.parseFloat(canvasStyle.borderLeftWidth) || 0;
    const borderTop = Number.parseFloat(canvasStyle.borderTopWidth) || 0;
    const borderRight = Number.parseFloat(canvasStyle.borderRightWidth) || 0;
    const borderBottom = Number.parseFloat(canvasStyle.borderBottomWidth) || 0;
    canvasRect = {
      left: canvasBorderBox.left + borderLeft,
      top: canvasBorderBox.top + borderTop,
      right: canvasBorderBox.right - borderRight,
      bottom: canvasBorderBox.bottom - borderBottom,
      width: canvasBorderBox.width - borderLeft - borderRight,
      height: canvasBorderBox.height - borderTop - borderBottom,
    };
  }
  const findings = [];
  const counts = Object.fromEntries(LINT_FINDING_TYPES.map((type) => [type, 0]));
  const reported = new Set();

  const push = (type, element, descriptor, extra, message) => {
    const key = `${type}\u0000${descriptor}`;
    if (reported.has(key)) return;
    reported.add(key);
    counts[type] += 1;
    findings.push(createValidationIssue({
      type,
      slide: address,
      area: elementArea(element),
      element: descriptor,
      ...extra,
      message,
    }));
  };

  for (const element of slide.querySelectorAll("*")) {
    if (element === slide) continue;
    const style = computedStyle(element);
    if (!isVisible(element, style)) continue;
    if (element.closest?.(excludedSelector)) continue;
    if (element.matches?.(LINT_SELF_EXCLUDED_SELECTOR)) continue;
    const descriptor = describeElement(element);

    if (canvasRect) {
      const rect = element.getBoundingClientRect?.() ?? null;
      if (outOfBounds && rect && rect.width > 0 && rect.height > 0) {
        const pastLeft = round(canvasRect.left - rect.left);
        const pastRight = round(rect.right - canvasRect.right);
        const pastTop = round(canvasRect.top - rect.top);
        const pastBottom = round(rect.bottom - canvasRect.bottom);
        const worst = Math.max(pastLeft, pastRight, pastTop, pastBottom);
        if (worst > tolerance) {
          push("element-out-of-bounds", element, descriptor, {
            offset: {
              left: Math.max(0, pastLeft),
              right: Math.max(0, pastRight),
              top: Math.max(0, pastTop),
              bottom: Math.max(0, pastBottom),
            },
          }, `${descriptor} extends ${round(worst)}px outside the slide canvas`);
          continue;
        }
      }
      if (canvasTextOverflow && hasDirectText(element)) {
        let worst = 0;
        for (const rect of textRects(element, rangeOf)) {
          if (!rect || (rect.width === 0 && rect.height === 0)) continue;
          worst = Math.max(
            worst,
            canvasRect.left - rect.left,
            rect.right - canvasRect.right,
            canvasRect.top - rect.top,
            rect.bottom - canvasRect.bottom,
          );
        }
        if (worst > tolerance) {
          push("canvas-text-overflow", element, descriptor, {
            overflow: { px: round(worst) },
          }, `text of ${descriptor} spills ${round(worst)}px past the slide canvas`);
        }
      }
    }

    if (typography && hasDirectText(element)) {
      const fontSize = Number.parseFloat(style.fontSize);
      if (minFontSizePx !== null && Number.isFinite(fontSize) && fontSize < minFontSizePx) {
        push("font-size-anomaly", element, descriptor, {
          fontSize: round(fontSize),
          minimum: minFontSizePx,
        }, `${descriptor} renders at ${round(fontSize)}px, below the theme's minimum readable size ${minFontSizePx}px`);
      }
      if (minLineHeightRatio !== null && Number.isFinite(fontSize) && fontSize > 0) {
        const lineHeight = Number.parseFloat(style.lineHeight);
        if (Number.isFinite(lineHeight)) {
          const ratio = round(lineHeight / fontSize);
          if (ratio < minLineHeightRatio) {
            push("line-height-anomaly", element, descriptor, {
              lineHeightRatio: ratio,
              minimum: minLineHeightRatio,
            }, `${descriptor} sets a line-height ratio of ${ratio}, below the theme's minimum ${minLineHeightRatio}`);
          }
        }
      }
    }
  }

  return {
    schema: LINT_SCHEMA,
    ok: findings.length === 0,
    findings,
    counts,
    thresholds: { minFontSizePx, minLineHeightRatio },
  };
}

/**
 * Drain FontFaces that are still loading in the given document, then let one
 * animation frame paint, so layout measurements observe final glyph metrics.
 * Exposing a previously hidden slide can trigger webfont loads that were
 * never started while the slide was `display: none`; measuring before they
 * settle reports fallback-font overflow that does not exist in the rendered
 * deck.
 */
async function settleExposedSlideFonts(doc, slide, sleep) {
  const fonts = doc?.fonts ?? null;
  if (!fonts) return;
  const pendingFaces = () => [...fonts].filter((face) => face.status === "loading");
  const startedAt = Date.now();
  // Bounded drain: a face whose load never settles (hung request) must not
  // stall inspection past the deadline, so every wait races a poll tick and
  // the deadline is re-checked while waiting, not only between iterations.
  while (Date.now() - startedAt < 2000) {
    const pending = pendingFaces();
    if (pending.length === 0) break;
    await Promise.race([
      Promise.allSettled(pending.map((face) => face.loaded)),
      sleep(250),
    ]);
  }
  // Layout metrics (scrollHeight/clientWidth) are read synchronously by the
  // caller; no paint frame is required, so the settle must not depend on
  // requestAnimationFrame — headless compositors may never produce a frame
  // and an rAF await would stall inspection indefinitely.
  void slide;
}

const inspectMeasurableSlide = async (slide, inspect, { document: requestedDocument, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) => {
  const view = slide.ownerDocument?.defaultView ?? globalThis.window;
  const style = view?.getComputedStyle?.(slide);
  const hasBox = slide.getClientRects?.().length !== 0 &&
    slide.clientWidth > 0 && slide.clientHeight > 0;
  if (style?.display !== "none" && style?.visibility !== "hidden" && hasBox) return inspect();
  if (!slide.style?.setProperty || !slide.getAttribute) return inspect();

  const previousStyle = slide.getAttribute("style");
  // Reveal hides inactive sections with `display: none`. Expose one slide at
  // a time so browser geometry is available to the inspector, wait for any
  // font loads the exposure triggered, then restore the authored/Reveal state
  // before inspecting the next slide.
  slide.style.setProperty("display", "block", "important");
  slide.style.setProperty("visibility", "visible", "important");
  try {
    await settleExposedSlideFonts(requestedDocument ?? slide.ownerDocument, slide, sleep);
    return inspect();
  } finally {
    if (previousStyle === null) slide.removeAttribute("style");
    else slide.setAttribute("style", previousStyle);
  }
};

export class RenderReadinessError extends Error {
  constructor(message, blocking = []) {
    super(message);
    this.name = "RenderReadinessError";
    this.blocking = blocking;
  }
}

const READY_TIMEOUT_MESSAGE = "rendered inspection timed out waiting for the app to become ready";

/**
 * Wait until the rendered slide tree is safe to measure: web fonts are loaded
 * and every image under `root` finished decoding (or is reported as failed).
 * Throws a `RenderReadinessError` listing the blocking resources when the
 * deadline passes, so callers fail fast instead of measuring an unstable page.
 */
export async function waitForRenderReadiness(
  root,
  {
    timeout = 10000,
    document: requestedDocument,
    fonts: requestedFonts,
    images: requestedImages,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  const doc = requestedDocument ?? root?.ownerDocument ?? globalThis.document;
  const startedAt = Date.now();
  const expired = () => Date.now() - startedAt >= timeout;
  const pending = [];
  const failed = [];
  const blocking = [];
  let fontsStatus = "pending";

  // The deadline is shared by every readiness stage, and each stage records
  // its own blocker instead of throwing early: a hung image request also
  // holds `readyState` and `fonts.ready` back, and the report must name the
  // concrete resources, not just whichever stage checked first.

  // Stage 1 — document subresources: `document.fonts.ready` resolves
  // trivially when no @font-face has been registered yet, which is exactly
  // the state of a page whose stylesheet has not finished loading (a static
  // export's `<link>` can lose that race against the app bundle). Wait for
  // `readyState === "complete"` (all stylesheets, images, and scripts).
  if (doc?.readyState && doc.readyState !== "complete") {
    pending.push("document readyState");
    while (doc.readyState !== "complete" && !expired()) await sleep(25);
    pending.splice(pending.indexOf("document readyState"), 1);
    if (doc.readyState !== "complete") blocking.push("document readyState");
  }

  // Stage 2 — web fonts.
  const fonts = requestedFonts ?? doc?.fonts ?? null;
  if (fonts?.ready) {
    let settled = false;
    fonts.ready.then(
      () => {
        fontsStatus = "ready";
        settled = true;
      },
      () => {
        fontsStatus = "unavailable";
        settled = true;
      },
    );
    pending.push("document.fonts.ready");
    while (!settled && !expired()) await sleep(25);
    pending.splice(pending.indexOf("document.fonts.ready"), 1);
    if (!settled) {
      blocking.push("document.fonts.ready");
      if (fontsStatus === "pending") fontsStatus = "unavailable";
    }
  } else if (!fonts) {
    fontsStatus = "unavailable";
  }

  // `document.fonts.ready` only proves pending font loads settled — not that
  // they succeeded. A used @font-face whose FontFace reached status "error"
  // (CSSOM state, no string parsing) means the page renders with a fallback
  // and must be reported. Unused @font-face declarations stay "unloaded" and
  // system-font fallbacks never appear in the FontFaceSet, so neither can
  // create a false positive.
  const failedFonts = [];
  if (fonts && typeof fonts[Symbol.iterator] === "function") {
    for (const face of fonts) {
      if (face?.status === "error" && face.family && !failedFonts.includes(face.family)) {
        failedFonts.push(face.family);
      }
    }
  }

  // Stage 3 — image load and decode.
  const imageElements = requestedImages ?? [...(root?.querySelectorAll?.("img") ?? [])];
  for (const image of imageElements) {
    const source = image.currentSrc || image.getAttribute?.("src") || "unknown";
    const hasSource = Boolean(image.currentSrc || image.getAttribute?.("src"));
    if (!hasSource) continue;
    if (expired()) {
      blocking.push(source);
      continue;
    }

    if (typeof image.decode === "function") {
      // Prefer the platform decode() promise: it resolves only after the
      // image is fully loaded AND decoded, so publication cannot race ahead
      // of pixel availability. Environments/mocks without decode() fall back
      // to polling `complete`/`naturalWidth` below.
      pending.push(source);
      let settled = false;
      let decodeFailed = false;
      let decodePromise = null;
      try {
        decodePromise = image.decode();
      } catch {
        decodeFailed = true;
        settled = true;
      }
      if (decodePromise) {
        decodePromise.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
            decodeFailed = true;
          },
        );
      }
      while (!settled && !expired()) await sleep(25);
      pending.splice(pending.indexOf(source), 1);
      if (!settled) {
        blocking.push(source);
        continue;
      }
      if (decodeFailed) failed.push(source);
      continue;
    }

    if (!image.complete) {
      pending.push(source);
      while (!image.complete && !expired()) await sleep(25);
      pending.splice(pending.indexOf(source), 1);
      if (!image.complete) {
        blocking.push(source);
        continue;
      }
    }
    if (image.naturalWidth === 0) {
      failed.push(source);
    }
  }

  if (blocking.length > 0) {
    throw new RenderReadinessError(
      `${READY_TIMEOUT_MESSAGE}: ${blocking.join(", ")}`,
      [...blocking, ...pending],
    );
  }

  return {
    fonts: fontsStatus,
    fontsFailed: failedFonts,
    images: { total: imageElements.length, failed: [...failed] },
    durationMs: Date.now() - startedAt,
  };
}

export async function inspectRenderedDeck(
  root = document,
  {
    slideSelector = ".slide-canvas",
    overflow,
    density,
    contrast = {},
    lint,
    sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  } = {},
) {
  const slides = [...root.querySelectorAll(slideSelector)];
  const errors = [];
  const lintFindings = [];
  const lintCounts = Object.fromEntries(LINT_FINDING_TYPES.map((type) => [type, 0]));
  for (const [index, slide] of slides.entries()) {
    const address = slideAddress(slide, index + 1);
    const slideErrors = await inspectMeasurableSlide(
      slide,
      () => inspectRenderedSlide(slide, {
        overflow: { slide: address, ...overflow },
        density: { slide: address, ...density },
      }).errors,
      { document: root.ownerDocument, sleep },
    );
    errors.push(...slideErrors);

    if (lint !== false) {
      const thresholds = resolveLintThresholds(root.ownerDocument ?? root, lint?.getStyle);
      const slideLint = inspectSlideLint(slide, {
        slide: address,
        minFontSizePx: thresholds.minFontSizePx,
        minLineHeightRatio: thresholds.minLineHeightRatio,
        ...(lint ?? {}),
      });
      // The thresholds option is report metadata, not a per-slide knob.
      delete slideLint.thresholds;
      lintFindings.push(...slideLint.findings);
      for (const [type, count] of Object.entries(slideLint.counts)) lintCounts[type] += count;
    }
  }
  if (contrast !== false) {
    const contrastRoot = contrast.root || root.documentElement || root.ownerDocument?.documentElement;
    if (contrastRoot) errors.push(...inspectThemeContrast(contrastRoot, contrast).errors);
  }
  const lintReport = lint === false ? null : {
    schema: LINT_SCHEMA,
    ok: lintFindings.length === 0,
    findings: lintFindings,
    counts: lintCounts,
    thresholds: resolveLintThresholds(root.ownerDocument ?? root, lint?.getStyle),
  };
  return { ok: errors.length === 0, errors, slides: slides.length, lint: lintReport };
}

/**
 * Run browser-only validation when `?inspect=1` is present, wait for the app
 * to become measurable (fonts + images), and publish the stable report for
 * agents, headless CLIs, test harnesses, and portal integrations. The resolved
 * report is both the return value and the explicit app-ready signal:
 * `window.__latticeInspection` is set (and `lattice:inspection` dispatched)
 * only after readiness, so headless consumers can wait on it directly.
 */
export async function installRenderedInspection(
  root = document,
  {
    location = root.ownerDocument?.defaultView?.location ?? globalThis.location,
    target = root.ownerDocument?.defaultView ?? globalThis.window,
    queryParam = "inspect",
    deck = null,
    readyTimeout = 10000,
    options = {},
  } = {},
) {
  if (!location || new URL(location.href).searchParams.get(queryParam) !== "1") return null;

  let errors = [];
  let readiness = null;
  try {
    readiness = await waitForRenderReadiness(root, { timeout: readyTimeout });
  } catch (error) {
    if (!(error instanceof RenderReadinessError)) throw error;
    errors.push(createValidationIssue({
      type: "ready-timeout",
      slide: deck,
      area: null,
      element: "document readiness",
      blocking: error.blocking,
      message: `deck "${deck ?? "unknown"}": ${error.message}`,
    }));
  }

  for (const url of readiness?.images.failed ?? []) {
    errors.push(createValidationIssue({
      type: "missing-asset",
      slide: deck,
      area: null,
      element: "img",
      url,
      message: `deck "${deck ?? "unknown"}": image failed to load or decode: ${url}`,
    }));
  }

  for (const family of readiness?.fontsFailed ?? []) {
    errors.push(createValidationIssue({
      type: "missing-font",
      slide: deck,
      area: null,
      element: family,
      family,
      message: `deck "${deck ?? "unknown"}": webfont failed to load, rendering with fallback: ${family}`,
    }));
  }

  let slides = 0;
  let lint = null;
  if (errors.length === 0) {
    // Theme contrast is a document-level token check; stamp it with the deck
    // id so findings carry stable slide addressing instead of a null slide.
    const deckOptions = { ...options };
    if (deckOptions.contrast !== false) {
      deckOptions.contrast = { ...(deckOptions.contrast ?? {}) };
      if (deckOptions.contrast.slide == null) deckOptions.contrast.slide = deck;
    }
    const report = await inspectRenderedDeck(root, deckOptions);
    errors = report.errors;
    slides = report.slides;
    lint = report.lint;
  }

  const report = { deck, ok: errors.length === 0, errors, slides, readiness, lint };
  target.__latticeInspection = report;
  const EventConstructor = target.CustomEvent ?? globalThis.CustomEvent;
  if (EventConstructor) {
    target.dispatchEvent?.(new EventConstructor("lattice:inspection", { detail: report }));
  }
  if (!report.ok) console.warn("[lattice] rendered inspection found issues:", report.errors);
  return report;
}

export { installDimensionInspection } from "./dimension-overlay.js";
