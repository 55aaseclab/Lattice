import { SLIDE_CANVAS } from "../grid/index.js";
import { describeElement } from "./address.js";

const CANVAS_WIDTH = SLIDE_CANVAS.width;
const CANVAS_HEIGHT = SLIDE_CANVAS.height;
const RULER_INSET = 9;
const EPSILON = 1.5;
const MAX_STRUCTURE_BREAKS = 7;

const SKIPPED_TAGS = new Set([
  "SVG",
  "PATH",
  "CIRCLE",
  "ELLIPSE",
  "RECT",
  "LINE",
  "POLYLINE",
  "POLYGON",
  "G",
  "DEFS",
  "MARKER",
  "CLIPPATH",
  "MASK",
  "STYLE",
  "SCRIPT",
  "IMG",
  "CANVAS",
  "VIDEO",
]);

function round(value) {
  return Math.round(value * 10) / 10;
}

function escapeSvgText(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&apos;",
  })[character]);
}

const elementName = (element) => describeElement(element);

async function copyInspectorName(name) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(name);
      return true;
    } catch {
      // Some embedded or non-secure authoring contexts deny the modern API.
      // Fall through to the browser-compatible selection-based path.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = name;
  textarea.setAttribute("readonly", "");
  textarea.style.cssText = "position:fixed;opacity:0;pointer-events:none;";
  document.body.append(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  textarea.remove();
  return copied;
}

function rectInCanvas(element, canvas) {
  if (!element) return null;
  const rect = element.getBoundingClientRect();
  const canvasRect = canvas.getBoundingClientRect();
  if (!canvasRect.width || !canvasRect.height) return null;
  const scaleX = CANVAS_WIDTH / canvasRect.width;
  const scaleY = CANVAS_HEIGHT / canvasRect.height;
  const left = (rect.left - canvasRect.left) * scaleX;
  const top = (rect.top - canvasRect.top) * scaleY;
  return {
    left,
    top,
    right: left + rect.width * scaleX,
    bottom: top + rect.height * scaleY,
    width: rect.width * scaleX,
    height: rect.height * scaleY,
  };
}

function rectIsInside(rect) {
  return (
    rect &&
    rect.width >= 42 &&
    rect.height >= 18 &&
    rect.left >= -EPSILON &&
    rect.top >= -EPSILON &&
    rect.right <= CANVAS_WIDTH + EPSILON &&
    rect.bottom <= CANVAS_HEIGHT + EPSILON
  );
}

function nonTransparentBackground(style) {
  return style.backgroundColor && style.backgroundColor !== "transparent" && !style.backgroundColor.endsWith(", 0)");
}

function hasVisibleElementChildren(element) {
  return Array.from(element.children).filter((child) => {
    if (!(child instanceof HTMLElement) || SKIPPED_TAGS.has(child.tagName)) return false;
    const style = window.getComputedStyle(child);
    return style.display !== "none" && style.visibility !== "hidden";
  }).length;
}

function isStructuralElement(element, canvas) {
  if (!(element instanceof HTMLElement) || element === canvas || SKIPPED_TAGS.has(element.tagName)) return false;
  if (element.closest(".sl-grid-overlay, .sl-dimension-overlay, .slide-note-source, .slide-page-number")) return false;
  const style = window.getComputedStyle(element);
  if (style.display === "none" || style.visibility === "hidden") return false;
  const rect = rectInCanvas(element, canvas);
  if (!rectIsInside(rect)) return false;

  const isLayout = ["grid", "inline-grid", "flex", "inline-flex"].includes(style.display);
  const hasBorder = ["top", "right", "bottom", "left"]
    .some((side) => Number.parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0);
  const hasSurface = nonTransparentBackground(style);
  const childCount = hasVisibleElementChildren(element);
  const gridCell = element.classList.contains("sl-grid-cell") || element.classList.contains("ph");

  // A meaningful construction region is either an authored layout container,
  // a card/bar with a visible boundary, or a container that divides into
  // several visible children. Plain text nodes deliberately do not qualify.
  if (!(gridCell || isLayout || hasBorder || hasSurface || childCount >= 2)) return false;
  return { element, rect, childCount, isLayout, hasBorder, hasSurface, gridCell };
}

function collectStructureBoxes(canvas) {
  const boxes = Array.from(canvas.querySelectorAll("*")).map((element) => isStructuralElement(element, canvas)).filter(Boolean);
  const unique = [];
  for (const box of boxes) {
    const duplicate = unique.find((other) =>
      Math.abs(other.rect.left - box.rect.left) < EPSILON &&
      Math.abs(other.rect.top - box.rect.top) < EPSILON &&
      Math.abs(other.rect.width - box.rect.width) < EPSILON &&
      Math.abs(other.rect.height - box.rect.height) < EPSILON,
    );
    if (!duplicate) {
      unique.push(box);
      continue;
    }
    // Prefer the more concrete/deeper implementation region over an outer
    // wrapper when two DOM nodes map to exactly the same drawing rectangle.
    if (box.element.contains(duplicate.element)) continue;
    if (duplicate.element.contains(box.element)) {
      unique.splice(unique.indexOf(duplicate), 1, box);
    }
  }
  return unique;
}

function primaryGridFrame(canvas) {
  const frame = canvas.querySelector(".sl-grid-overlay-frame");
  const rect = rectInCanvas(frame, canvas);
  return rectIsInside(rect)
    ? rect
    : { left: 0, top: 0, right: CANVAS_WIDTH, bottom: CANVAS_HEIGHT, width: CANVAS_WIDTH, height: CANVAS_HEIGHT };
}

function clusterCoordinates(values) {
  const clusters = [];
  [...values].sort((a, b) => a - b).forEach((value) => {
    const previous = clusters.at(-1);
    if (previous && Math.abs(previous.value - value) <= EPSILON) {
      previous.values.push(value);
      previous.value = previous.values.reduce((sum, entry) => sum + entry, 0) / previous.values.length;
    } else {
      clusters.push({ value, values: [value] });
    }
  });
  return clusters;
}

function structuralBreaks(boxes, frame, axis) {
  const start = axis === "x" ? frame.left : frame.top;
  const end = axis === "x" ? frame.right : frame.bottom;
  const size = axis === "x" ? "width" : "height";
  const low = axis === "x" ? "left" : "top";
  const high = axis === "x" ? "right" : "bottom";
  const viable = boxes.filter((box) => box.rect[size] >= 52 && box.rect[low] >= start - EPSILON && box.rect[high] <= end + EPSILON);
  const candidates = clusterCoordinates([start, end, ...viable.flatMap((box) => [box.rect[low], box.rect[high]])]);
  const endpoints = candidates.filter((entry) => Math.abs(entry.value - start) <= EPSILON || Math.abs(entry.value - end) <= EPSILON);
  const interiors = candidates
    .filter((entry) => entry.value > start + 20 && entry.value < end - 20)
    .map((entry) => ({
      ...entry,
      // Repeated alignment lines are much more useful than a single leaf
      // card edge. Large construction regions also get a small preference.
      weight: entry.values.length * 4 + viable.filter((box) => Math.abs(box.rect[low] - entry.value) <= EPSILON || Math.abs(box.rect[high] - entry.value) <= EPSILON)
        .reduce((total, box) => total + Math.min(3, box.rect[size] / (axis === "x" ? 180 : 100)), 0),
    }))
    .sort((a, b) => b.weight - a.weight);

  const selected = [...endpoints];
  for (const entry of interiors) {
    if (selected.length >= MAX_STRUCTURE_BREAKS) break;
    if (selected.every((chosen) => Math.abs(chosen.value - entry.value) >= 24)) selected.push(entry);
  }
  return selected.map(({ value }) => value).sort((a, b) => a - b);
}

function gridBreaks(canvas, frame, axis) {
  const selector = axis === "x" ? ".sl-grid-overlay-col" : ".sl-grid-overlay-row";
  const low = axis === "x" ? "left" : "top";
  const high = axis === "x" ? "right" : "bottom";
  const points = [frame[low], frame[high]];
  canvas.querySelectorAll(selector).forEach((track) => {
    const rect = rectInCanvas(track, canvas);
    if (rectIsInside(rect)) points.push(rect[low], rect[high]);
  });
  return clusterCoordinates(points).map((entry) => entry.value).sort((a, b) => a - b);
}

function segments(points, minimum = 13) {
  return points.slice(0, -1).map((start, index) => ({ start, end: points[index + 1] }))
    .filter(({ start, end }) => end - start >= minimum);
}

function line(x1, y1, x2, y2, className = "") {
  return `<line class="sl-dimension-line ${className}" x1="${round(x1)}" y1="${round(y1)}" x2="${round(x2)}" y2="${round(y2)}" />`;
}

function label(x, y, text, className = "") {
  return `<text class="sl-dimension-label ${className}" x="${round(x)}" y="${round(y)}">${text}</text>`;
}

function horizontalDimension({ start, end }, y, side) {
  const midpoint = (start + end) / 2;
  const labelY = side === "top" ? y + 8 : y - 4;
  const extension = side === "top" ? y + 4 : y - 4;
  return [
    line(start, y, end, y),
    line(start, y - 3, start, y + 3),
    line(end, y - 3, end, y + 3),
    line(start, y, start, extension, "sl-dimension-extension"),
    line(end, y, end, extension, "sl-dimension-extension"),
    label(midpoint, labelY, Math.round(end - start), "sl-dimension-horizontal"),
  ].join("");
}

function verticalDimension({ start, end }, x, side) {
  const midpoint = (start + end) / 2;
  const labelX = side === "left" ? x + 6 : x - 6;
  const extension = side === "left" ? x + 4 : x - 4;
  return [
    line(x, start, x, end),
    line(x - 3, start, x + 3, start),
    line(x - 3, end, x + 3, end),
    line(x, start, extension, start, "sl-dimension-extension"),
    line(x, end, extension, end, "sl-dimension-extension"),
    label(labelX, midpoint, Math.round(end - start), `sl-dimension-vertical sl-dimension-${side}`),
  ].join("");
}

function highlight(box) {
  if (!box) return "";
  const { left, top, width, height } = box.rect;
  const name = escapeSvgText(elementName(box.element));
  const widthLabelX = Math.min(CANVAS_WIDTH - 7, Math.max(7, left + width / 2));
  // The four outside rulers intentionally describe two different systems:
  // blue top/left = layout grid; orange bottom/right = detected structure.
  // A hovered DOM region is a structure, so its dimensions always project to
  // the orange pair instead of choosing the visually nearest canvas edge.
  const structureRulerY = CANVAS_HEIGHT + RULER_INSET;
  const structureRulerX = CANVAS_WIDTH + RULER_INSET;
  const widthLabelY = structureRulerY + 10;
  const heightLabelX = structureRulerX + 9;
  const heightLabelY = top + height / 2;
  return `
    <rect class="sl-dimension-highlight" x="${round(left)}" y="${round(top)}" width="${round(width)}" height="${round(height)}" />
    <line class="sl-dimension-selected-leader" x1="${round(left)}" y1="${round(top + height)}" x2="${round(left)}" y2="${round(structureRulerY)}" />
    <line class="sl-dimension-selected-leader" x1="${round(left + width)}" y1="${round(top + height)}" x2="${round(left + width)}" y2="${round(structureRulerY)}" />
    <line class="sl-dimension-selected-span" x1="${round(left)}" y1="${round(structureRulerY)}" x2="${round(left + width)}" y2="${round(structureRulerY)}" />
    <line class="sl-dimension-selected-tick" x1="${round(left)}" y1="${round(structureRulerY - 2.5)}" x2="${round(left)}" y2="${round(structureRulerY + 2.5)}" />
    <line class="sl-dimension-selected-tick" x1="${round(left + width)}" y1="${round(structureRulerY - 2.5)}" x2="${round(left + width)}" y2="${round(structureRulerY + 2.5)}" />
    <line class="sl-dimension-selected-leader" x1="${round(left + width)}" y1="${round(top)}" x2="${round(structureRulerX)}" y2="${round(top)}" />
    <line class="sl-dimension-selected-leader" x1="${round(left + width)}" y1="${round(top + height)}" x2="${round(structureRulerX)}" y2="${round(top + height)}" />
    <line class="sl-dimension-selected-span" x1="${round(structureRulerX)}" y1="${round(top)}" x2="${round(structureRulerX)}" y2="${round(top + height)}" />
    <line class="sl-dimension-selected-tick" x1="${round(structureRulerX - 2.5)}" y1="${round(top)}" x2="${round(structureRulerX + 2.5)}" y2="${round(top)}" />
    <line class="sl-dimension-selected-tick" x1="${round(structureRulerX - 2.5)}" y1="${round(top + height)}" x2="${round(structureRulerX + 2.5)}" y2="${round(top + height)}" />
    <text class="sl-dimension-selected" x="${round(widthLabelX)}" y="${round(widthLabelY)}">${Math.round(width)}</text>
    <text class="sl-dimension-selected sl-dimension-selected-height" x="${round(heightLabelX)}" y="${round(heightLabelY)}" transform="rotate(90 ${round(heightLabelX)} ${round(heightLabelY)})">${Math.round(height)}</text>
    <text class="sl-dimension-selected sl-dimension-selected-name" x="66" y="${-RULER_INSET - 15}">ELEMENT · ${name}</text>
  `;
}

function selectedHighlights(boxes) {
  return boxes.map((box, index) => {
    const { left, top, width, height } = box.rect;
    return `
      <rect class="sl-dimension-selection" x="${round(left)}" y="${round(top)}" width="${round(width)}" height="${round(height)}" />
      <text class="sl-dimension-selection-index" x="${round(left + 4)}" y="${round(top + 6)}">${index + 1}</text>
    `;
  }).join("");
}

function selectedBoxesFor(state, boxes) {
  const available = new Set(boxes.map((box) => box.element));
  state.selected = new Set([...state.selected].filter((element) => available.has(element)));
  return [...state.selected]
    .map((element) => boxes.find((box) => box.element === element))
    .filter(Boolean);
}

function renderOverlay(canvas, state) {
  const overlay = state.overlay;
  const frame = primaryGridFrame(canvas);
  const boxes = collectStructureBoxes(canvas);
  state.boxes = boxes;
  const gridX = gridBreaks(canvas, frame, "x");
  const gridY = gridBreaks(canvas, frame, "y");
  const structureX = structuralBreaks(boxes, frame, "x");
  const structureY = structuralBreaks(boxes, frame, "y");
  const activeBox = state.active && boxes.find((box) => box.element === state.active.element);
  const selectedBoxes = selectedBoxesFor(state, boxes);
  const selectionStatus = selectedBoxes.length
    ? `<text class="sl-dimension-selection-status" x="${CANVAS_WIDTH}" y="${-RULER_INSET - 15}">SELECTED · ${selectedBoxes.length}</text>`
    : "";

  overlay.innerHTML = `
    <g class="sl-dimension-ruler sl-dimension-ruler-grid">
      ${segments(gridX).map((segment) => horizontalDimension(segment, -RULER_INSET, "top")).join("")}
      ${segments(gridY).map((segment) => verticalDimension(segment, -RULER_INSET, "left")).join("")}
    </g>
    <g class="sl-dimension-ruler sl-dimension-ruler-structure">
      ${segments(structureX, 30).map((segment) => horizontalDimension(segment, CANVAS_HEIGHT + RULER_INSET, "bottom")).join("")}
      ${segments(structureY, 26).map((segment) => verticalDimension(segment, CANVAS_WIDTH + RULER_INSET, "right")).join("")}
    </g>
    <text class="sl-dimension-axis" x="0" y="${-RULER_INSET - 15}">GRID / px</text>
    ${selectedHighlights(selectedBoxes)}
    ${selectionStatus}
    ${highlight(activeBox)}
  `;
}

function smallestBoxAtPoint(boxes, canvas, event) {
  const canvasRect = canvas.getBoundingClientRect();
  const x = (event.clientX - canvasRect.left) * (CANVAS_WIDTH / canvasRect.width);
  const y = (event.clientY - canvasRect.top) * (CANVAS_HEIGHT / canvasRect.height);
  return boxes
    .filter(({ rect }) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)
    .sort((a, b) => a.rect.width * a.rect.height - b.rect.width * b.rect.height)[0] || null;
}

function createOverlay(canvas) {
  const overlay = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  overlay.classList.add("sl-dimension-overlay");
  overlay.setAttribute("viewBox", `-26 -26 ${CANVAS_WIDTH + 52} ${CANVAS_HEIGHT + 52}`);
  overlay.setAttribute("preserveAspectRatio", "none");
  overlay.setAttribute("aria-hidden", "true");
  canvas.append(overlay);
  return overlay;
}

function setupCanvas(canvas) {
  if (canvas.dataset.dimensionOverlayReady === "true") return;
  canvas.dataset.dimensionOverlayReady = "true";
  const state = { overlay: createOverlay(canvas), boxes: [], active: null, selected: new Set() };
  const refresh = () => renderOverlay(canvas, state);
  const isVisible = () => canvas.classList.contains("show-grid-overlay");

  canvas.addEventListener("pointermove", (event) => {
    if (!isVisible()) return;
    const next = smallestBoxAtPoint(state.boxes, canvas, event);
    if (next?.element === state.active?.element) return;
    state.active = next;
    refresh();
  });
  canvas.addEventListener("pointerleave", () => {
    if (!state.active) return;
    state.active = null;
    refresh();
  });

  canvas.addEventListener("click", (event) => {
    if (!isVisible()) return;
    const box = smallestBoxAtPoint(state.boxes, canvas, event);
    const additive = event.shiftKey || event.metaKey || event.ctrlKey;
    // In Grid mode a click is an authoring action, never a Reveal navigation
    // action. A plain click begins a new selection; modifier-click toggles a
    // box in the persistent multi-selection. The clipboard always mirrors
    // the whole selected set, in click order.
    event.preventDefault();
    event.stopPropagation();
    if (!box) {
      if (!additive && state.selected.size) {
        state.selected.clear();
        refresh();
      }
      return;
    }

    if (additive) {
      if (state.selected.has(box.element)) state.selected.delete(box.element);
      else state.selected.add(box.element);
    } else {
      state.selected = new Set([box.element]);
    }
    state.active = box;
    refresh();
    const selectedNames = [...state.selected].map(elementName);
    void copyInspectorName(selectedNames.join("\n"));
  }, true);

  new ResizeObserver(refresh).observe(canvas);
  new MutationObserver((records) => {
    if (records.some((record) => record.attributeName === "class")) refresh();
  }).observe(canvas, { attributes: true, attributeFilter: ["class"] });
  refresh();
}

// This deliberately reads the rendered DOM instead of layout definitions: it
// works for authored CSS, arbitrary nested structures, and every deck that
// uses the same runtime. Grid mode becomes a measuring instrument rather than
// a second source of layout truth.
export function installDimensionInspection(root = document) {
  root.querySelectorAll(".slide-canvas").forEach(setupCanvas);
}
