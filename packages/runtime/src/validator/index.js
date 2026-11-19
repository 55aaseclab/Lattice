import { SLIDE_CANVAS, gridPlacementRect } from "../grid/index.js";

const ASSET_EXTENSIONS = "png|jpe?g|svg|gif|webp|avif|mp4|webm|json";
const ASSET_URL_PATTERN = new RegExp(`^(?:\\./|\\.\\./|/).+\\.(?:${ASSET_EXTENSIONS})(?:[?#].*)?$`, "i");
const VOID_ELEMENTS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

const normalizeRect = (rect) => ({
  x: rect.x ?? rect.left ?? 0,
  y: rect.y ?? rect.top ?? 0,
  w: rect.w ?? rect.width ?? 0,
  h: rect.h ?? rect.height ?? 0,
});

const normalizeLocation = (value) => (value === undefined ? null : value);

/**
 * Create the stable issue envelope consumed by humans, CI, and coding agents.
 * Check-specific fields may be added, but these five keys are always present.
 */
export function createValidationIssue({
  type,
  slide = null,
  area = null,
  element = null,
  message,
  ...details
}) {
  return {
    type,
    slide: normalizeLocation(slide),
    area: normalizeLocation(area),
    element: normalizeLocation(element),
    ...details,
    message,
  };
}

export function formatValidationIssue(issue) {
  const location = [
    issue.slide !== null && issue.slide !== undefined ? `slide=${issue.slide}` : "",
    issue.area ? `area=${issue.area}` : "",
    issue.element ? `element=${issue.element}` : "",
    Array.isArray(issue.areas) ? `areas=${issue.areas.filter(Boolean).join(",")}` : "",
    Array.isArray(issue.elements) ? `elements=${issue.elements.filter(Boolean).join(",")}` : "",
  ].filter(Boolean).join(" ");
  return `[${issue.type}]${location ? ` ${location}` : ""} ${issue.message}`;
}

export function rectsOverlap(a, b, epsilon = 0.5) {
  a = normalizeRect(a);
  b = normalizeRect(b);
  return (
    a.x < b.x + b.w - epsilon &&
    b.x < a.x + a.w - epsilon &&
    a.y < b.y + b.h - epsilon &&
    b.y < a.y + a.h - epsilon
  );
}

const placementArea = (placement) => placement.area ?? placement.name ?? null;
const placementElement = (placement) =>
  placement.element ?? placement.inspectorName ?? placement.id ?? placement.name ?? null;

export function validateGridPlacements(
  grid,
  placements = [...grid.areas.values()],
  { allowOverlap = false, slide = null } = {},
) {
  const errors = [];
  const columnCount = grid.columns.length;
  const rowCount = grid.rows.length;
  for (const placement of placements) {
    const area = placementArea(placement);
    const element = placementElement(placement);
    if (
      placement.col < 1 ||
      placement.row < 1 ||
      placement.col + placement.colSpan - 1 > columnCount ||
      placement.row + placement.rowSpan - 1 > rowCount
    ) {
      errors.push(createValidationIssue({
        type: "out-of-bounds",
        slide,
        area,
        element,
        message: `${grid.name || "grid"}: placement ${area || `col ${placement.col} row ${placement.row}`} exceeds grid bounds (${columnCount}x${rowCount})`,
      }));
    }
  }
  if (!allowOverlap) {
    for (let i = 0; i < placements.length; i += 1) {
      for (let j = i + 1; j < placements.length; j += 1) {
        const a = gridPlacementRect(grid, placements[i]);
        const b = gridPlacementRect(grid, placements[j]);
        if (rectsOverlap(a, b)) {
          const areas = [placementArea(placements[i]), placementArea(placements[j])];
          const elements = [placementElement(placements[i]), placementElement(placements[j])];
          errors.push(createValidationIssue({
            type: "overlap",
            slide,
            areas,
            elements,
            message: `${grid.name || "grid"}: placements ${areas[0] || i + 1} and ${areas[1] || j + 1} overlap`,
          }));
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export function validateGrids(grids, { slide = null } = {}) {
  const errors = [];
  for (const entry of grids) {
    const grid = entry?.grid ?? entry;
    const entrySlide = entry?.grid ? (entry.slide ?? slide) : slide;
    const report = validateGridPlacements(grid, [...grid.areas.values()], { slide: entrySlide });
    errors.push(...report.errors);
  }
  return { ok: errors.length === 0, errors };
}

export function validateRects(
  rects,
  {
    bounds = SLIDE_CANVAS,
    allowOverlap = true,
    boundsTolerance = 0.5,
    slide = null,
  } = {},
) {
  const errors = [];
  rects.forEach((rect, index) => {
    const element = rect.element ?? rect.label ?? `rect ${index + 1}`;
    const area = rect.area ?? null;
    if (
      rect.x < -boundsTolerance ||
      rect.y < -boundsTolerance ||
      rect.x + rect.w > bounds.width + boundsTolerance ||
      rect.y + rect.h > bounds.height + boundsTolerance
    ) {
      errors.push(createValidationIssue({
        type: "out-of-bounds",
        slide: rect.slide ?? slide,
        area,
        element,
        message: `${element}: rect (${rect.x}, ${rect.y}, ${rect.w}x${rect.h}) exceeds ${bounds.width}x${bounds.height} canvas bounds`,
      }));
    }
  });
  if (!allowOverlap) {
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        if (rectsOverlap(rects[i], rects[j])) {
          const elements = [
            rects[i].element ?? rects[i].label ?? `rect ${i + 1}`,
            rects[j].element ?? rects[j].label ?? `rect ${j + 1}`,
          ];
          const areas = [rects[i].area ?? null, rects[j].area ?? null];
          errors.push(createValidationIssue({
            type: "overlap",
            slide: rects[i].slide ?? rects[j].slide ?? slide,
            areas,
            elements,
            message: `${elements[0]} and ${elements[1]} overlap`,
          }));
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

const parseAttributes = (source) => {
  const attributes = {};
  const pattern = /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let match;
  while ((match = pattern.exec(source)) !== null) {
    attributes[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attributes;
};

const classSelector = (value) => {
  const className = String(value || "").trim().split(/\s+/).find(Boolean);
  return className ? `.${className}` : "";
};

const tagDescriptor = (tagName, attributes) =>
  attributes["data-inspector-name"] ||
  attributes["aria-label"] ||
  (attributes.id ? `#${attributes.id}` : "") ||
  `${tagName}${classSelector(attributes.class)}`;

/**
 * Scan HTML markup without a browser and retain enough ancestry to associate
 * an asset with the nearest authored inspector name (for example image()'s
 * named <figure> wrapping its <img>).
 */
export function collectMarkupAssets(markup) {
  const assets = [];
  const stack = [];
  const tags = /<\/?([a-zA-Z][\w:-]*)([^>]*)>/g;
  let match;
  while ((match = tags.exec(String(markup))) !== null) {
    const source = match[0];
    const tagName = match[1].toLowerCase();
    const closing = source.startsWith("</");
    if (closing) {
      const index = stack.map((entry) => entry.tagName).lastIndexOf(tagName);
      if (index >= 0) stack.splice(index);
      continue;
    }

    const attributes = parseAttributes(match[2]);
    const ownDescriptor = tagDescriptor(tagName, attributes);
    const namedAncestor = [...stack].reverse().find((entry) => entry.named);
    for (const attribute of ["src", "href"]) {
      const url = attributes[attribute];
      if (!url || !ASSET_URL_PATTERN.test(url)) continue;
      assets.push({
        url,
        element: attributes["data-inspector-name"] || namedAncestor?.descriptor || ownDescriptor,
        tag: tagName,
        attribute,
      });
    }

    const selfClosing = source.endsWith("/>") || VOID_ELEMENTS.has(tagName);
    if (!selfClosing) {
      stack.push({
        tagName,
        descriptor: ownDescriptor,
        named: Boolean(attributes["data-inspector-name"] || attributes["aria-label"] || attributes.id),
      });
    }
  }
  return assets;
}

const slideFromMarkup = (markup, index) => {
  const match = String(markup).match(/\bdata-slide-(?:id|number)\s*=\s*["']([^"']+)["']/i);
  return match?.[1] ?? index + 1;
};

export function validateAssets(slides, { exists } = {}) {
  const errors = [];
  const assets = new Set();
  const reported = new Set();
  slides.forEach((entry, index) => {
    const markup = typeof entry === "string" ? entry : entry.markup;
    const slide = typeof entry === "string"
      ? slideFromMarkup(markup, index)
      : (entry.slide ?? slideFromMarkup(markup, index));
    for (const asset of collectMarkupAssets(markup)) {
      assets.add(asset.url);
      if (!exists || exists(asset.url, { ...asset, slide })) continue;
      const reportKey = `${slide}\u0000${asset.element}\u0000${asset.url}`;
      if (reported.has(reportKey)) continue;
      reported.add(reportKey);
      errors.push(createValidationIssue({
        type: "missing-asset",
        slide,
        element: asset.element,
        url: asset.url,
        message: `asset not found: ${asset.url}`,
      }));
    }
  });
  return { ok: errors.length === 0, errors, assets: [...assets] };
}
