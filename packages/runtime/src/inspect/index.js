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

const inspectMeasurableSlide = (slide, inspect) => {
  const view = slide.ownerDocument?.defaultView ?? globalThis.window;
  const style = view?.getComputedStyle?.(slide);
  const hasBox = slide.getClientRects?.().length !== 0 &&
    slide.clientWidth > 0 && slide.clientHeight > 0;
  if (style?.display !== "none" && style?.visibility !== "hidden" && hasBox) return inspect();
  if (!slide.style?.setProperty || !slide.getAttribute) return inspect();

  const previousStyle = slide.getAttribute("style");
  // Reveal hides inactive sections with `display: none`. Expose one slide at
  // a time so browser geometry is available to the inspector, then restore
  // the authored/Reveal state before inspecting the next slide.
  slide.style.setProperty("display", "block", "important");
  slide.style.setProperty("visibility", "visible", "important");
  try {
    return inspect();
  } finally {
    if (previousStyle === null) slide.removeAttribute("style");
    else slide.setAttribute("style", previousStyle);
  }
};

export function inspectRenderedDeck(
  root = document,
  {
    slideSelector = ".slide-canvas",
    overflow,
    density,
    contrast = {},
  } = {},
) {
  const slides = [...root.querySelectorAll(slideSelector)];
  const errors = slides.flatMap((slide, index) => inspectMeasurableSlide(
    slide,
    () => inspectRenderedSlide(slide, {
      overflow: { slide: slideAddress(slide, index + 1), ...overflow },
      density: { slide: slideAddress(slide, index + 1), ...density },
    }).errors,
  ));
  if (contrast !== false) {
    const contrastRoot = contrast.root || root.documentElement || root.ownerDocument?.documentElement;
    if (contrastRoot) errors.push(...inspectThemeContrast(contrastRoot, contrast).errors);
  }
  return { ok: errors.length === 0, errors, slides: slides.length };
}

/**
 * Run browser-only validation when `?inspect=1` is present and publish the
 * stable report for agents, test harnesses, and portal integrations.
 */
export function installRenderedInspection(
  root = document,
  {
    location = root.ownerDocument?.defaultView?.location ?? globalThis.location,
    target = root.ownerDocument?.defaultView ?? globalThis.window,
    queryParam = "inspect",
    deck = null,
    options = {},
  } = {},
) {
  if (!location || new URL(location.href).searchParams.get(queryParam) !== "1") return null;
  const report = { deck, ...inspectRenderedDeck(root, options) };
  target.__latticeInspection = report;
  const EventConstructor = target.CustomEvent ?? globalThis.CustomEvent;
  if (EventConstructor) {
    target.dispatchEvent?.(new EventConstructor("lattice:inspection", { detail: report }));
  }
  if (!report.ok) console.warn("[lattice] rendered inspection found issues:", report.errors);
  return report;
}

export { installDimensionInspection } from "./dimension-overlay.js";
