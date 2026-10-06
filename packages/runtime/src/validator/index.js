import { SLIDE_CANVAS, gridPlacementRect } from "../grid/index.js";

const normalizeRect = (rect) => ({
  x: rect.x ?? rect.left ?? 0,
  y: rect.y ?? rect.top ?? 0,
  w: rect.w ?? rect.width ?? 0,
  h: rect.h ?? rect.height ?? 0,
});

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

export function validateGridPlacements(grid, placements = [...grid.areas.values()], { allowOverlap = false } = {}) {
  const errors = [];
  const columnCount = grid.columns.length;
  const rowCount = grid.rows.length;
  for (const placement of placements) {
    if (
      placement.col < 1 ||
      placement.row < 1 ||
      placement.col + placement.colSpan - 1 > columnCount ||
      placement.row + placement.rowSpan - 1 > rowCount
    ) {
      errors.push({
        type: "out-of-bounds",
        area: placement.name,
        message: `${grid.name || "grid"}: placement ${placement.name || `col ${placement.col} row ${placement.row}`} exceeds grid bounds (${columnCount}x${rowCount})`,
      });
    }
  }
  if (!allowOverlap) {
    for (let i = 0; i < placements.length; i += 1) {
      for (let j = i + 1; j < placements.length; j += 1) {
        const a = gridPlacementRect(grid, placements[i]);
        const b = gridPlacementRect(grid, placements[j]);
        if (rectsOverlap(a, b)) {
          errors.push({
            type: "overlap",
            areas: [placements[i].name, placements[j].name],
            message: `${grid.name || "grid"}: placements ${placements[i].name || i + 1} and ${placements[j].name || j + 1} overlap`,
          });
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export function validateGrids(grids) {
  const errors = [];
  for (const grid of grids) {
    const report = validateGridPlacements(grid);
    errors.push(...report.errors);
  }
  return { ok: errors.length === 0, errors };
}

export function validateRects(rects, { bounds = SLIDE_CANVAS, allowOverlap = true, boundsTolerance = 0.5 } = {}) {
  const errors = [];
  rects.forEach((rect, index) => {
    const label = rect.label ?? `rect ${index + 1}`;
    if (
      rect.x < -boundsTolerance ||
      rect.y < -boundsTolerance ||
      rect.x + rect.w > bounds.width + boundsTolerance ||
      rect.y + rect.h > bounds.height + boundsTolerance
    ) {
      errors.push({
        type: "out-of-bounds",
        item: label,
        message: `${label}: rect (${rect.x}, ${rect.y}, ${rect.w}x${rect.h}) exceeds ${bounds.width}x${bounds.height} canvas bounds`,
      });
    }
  });
  if (!allowOverlap) {
    for (let i = 0; i < rects.length; i += 1) {
      for (let j = i + 1; j < rects.length; j += 1) {
        if (rectsOverlap(rects[i], rects[j])) {
          errors.push({
            type: "overlap",
            items: [rects[i].label ?? i + 1, rects[j].label ?? j + 1],
            message: `${rects[i].label ?? i + 1} and ${rects[j].label ?? j + 1} overlap`,
          });
        }
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

export function validateAssets(slides, { exists } = {}) {
  const errors = [];
  const seen = new Set();
  const assetPattern = /(?:src|href)="((?:\.\/|\.\.\/|\/)[^"]+\.(?:png|jpe?g|svg|gif|webp|avif|mp4|webm|json))"/gi;
  for (const markup of slides) {
    let match;
    while ((match = assetPattern.exec(markup)) !== null) {
      const url = match[1];
      if (seen.has(url)) continue;
      seen.add(url);
      if (exists && !exists(url)) {
        errors.push({ type: "missing-asset", url, message: `asset not found: ${url}` });
      }
    }
  }
  return { ok: errors.length === 0, errors, assets: [...seen] };
}

