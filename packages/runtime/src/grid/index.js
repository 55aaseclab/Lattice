export const SLIDE_CANVAS = Object.freeze({ width: 960, height: 540 });

export const gridSpacingTokens = Object.freeze({
  edge: 33,
  gap: 16,
  padding: 10,
  scale: Object.freeze({ xs: 4, sm: 8, md: 16, lg: 24, xl: 33 }),
});

const resolveSpacingValue = (value) => {
  if (typeof value === "string" && !value.endsWith("px") && !value.endsWith("fr")) {
    const token = gridSpacingTokens.scale[value];
    if (token !== undefined) return token;
  }
  return value;
};

const normalizeMargin = (margin = 0) => {
  if (typeof margin === "number") {
    return { top: margin, right: margin, bottom: margin, left: margin };
  }
  const x = resolveSpacingValue(margin.x);
  const y = resolveSpacingValue(margin.y);
  const { top = resolveSpacingValue(y) ?? 0, bottom = resolveSpacingValue(y) ?? 0, left = resolveSpacingValue(x) ?? 0, right = resolveSpacingValue(x) ?? 0 } = margin;
  return { top, right, bottom, left };
};

const normalizeGap = (gap = 0) => {
  const resolvedGap = resolveSpacingValue(gap);
  if (typeof resolvedGap === "number") {
    return { column: resolvedGap, row: resolvedGap };
  }
  const x = resolveSpacingValue(resolvedGap.x);
  const y = resolveSpacingValue(resolvedGap.y);
  const { column = resolveSpacingValue(x) ?? 0, row = resolveSpacingValue(y) ?? 0 } = resolvedGap;
  return { column, row };
};

const parseTrackSpec = (spec) => {
  if (typeof spec === "number") return { px: spec };
  if (typeof spec === "string") {
    if (spec.endsWith("fr")) return { fr: Number.parseFloat(spec) };
    if (spec.endsWith("px")) return { px: Number.parseFloat(spec) };
    throw new Error(`[lattice-grid] unsupported track spec: ${JSON.stringify(spec)}`);
  }
  if (spec && typeof spec === "object") {
    if (typeof spec.fr === "number") return { fr: spec.fr };
    if (typeof spec.px === "number") return { px: spec.px };
  }
  throw new Error(`[lattice-grid] unsupported track spec: ${JSON.stringify(spec)}`);
};

const parseAxis = (value, axisLabel) => {
  if (value === undefined || value === null) {
    throw new Error(`[lattice-grid] ${axisLabel} is required`);
  }
  if (typeof value === "number") {
    return Array.from({ length: value }, () => ({ fr: 1 }));
  }
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`[lattice-grid] ${axisLabel} must be a track count or a non-empty track array`);
  }
  return value.map(parseTrackSpec);
};

const normalizePlacement = (name, placement) => {
  const { col = 1, row = 1, colSpan = 1, rowSpan = 1 } = placement;
  return { name, col, row, colSpan, rowSpan };
};

export function defineGrid({
  name = "",
  columns,
  rows,
  gap = 0,
  margin = 0,
  areas = {},
  canvas = SLIDE_CANVAS,
} = {}) {
  const columnTracks = parseAxis(columns, "columns");
  const rowTracks = parseAxis(rows, "rows");
  const spacing = { ...normalizeGap(gap), ...normalizeMargin(margin) };
  const grid = {
    name,
    canvas,
    columns: columnTracks,
    rows: rowTracks,
    columnGap: spacing.column,
    rowGap: spacing.row,
    margin: { top: spacing.top, right: spacing.right, bottom: spacing.bottom, left: spacing.left },
    areas: new Map(Object.entries(areas).map(([areaName, placement]) => [areaName, normalizePlacement(areaName, placement)])),
  };
  return grid;
}

export function gridContentBox(grid) {
  const { canvas, margin } = grid;
  return {
    width: canvas.width - margin.left - margin.right,
    height: canvas.height - margin.top - margin.bottom,
  };
}

export function gridTrackSizes(grid, axis) {
  const tracks = axis === "columns" ? grid.columns : grid.rows;
  const gapTotal = (tracks.length - 1) * (axis === "columns" ? grid.columnGap : grid.rowGap);
  const { width, height } = gridContentBox(grid);
  const content = axis === "columns" ? width : height;
  const pxTotal = tracks.reduce((sum, track) => sum + (track.px ?? 0), 0);
  const frTotal = tracks.reduce((sum, track) => sum + (track.fr ?? 0), 0);
  const frUnit = frTotal > 0 ? (content - gapTotal - pxTotal) / frTotal : 0;
  return tracks.map((track) => (track.px ?? 0) + (track.fr ?? 0) * frUnit);
}

export const gridColumnSizes = (grid) => gridTrackSizes(grid, "columns");
export const gridRowSizes = (grid) => gridTrackSizes(grid, "rows");

export function gridTrackOffsets(grid, axis) {
  const sizes = gridTrackSizes(grid, axis);
  const gap = axis === "columns" ? grid.columnGap : grid.rowGap;
  const offsets = [];
  let cursor = 0;
  for (const size of sizes) {
    offsets.push(cursor);
    cursor += size + gap;
  }
  return offsets;
}

export function gridPlacementRect(grid, placement) {
  const { col, row, colSpan = 1, rowSpan = 1 } = placement;
  const columnOffsets = gridTrackOffsets(grid, "columns");
  const rowOffsets = gridTrackOffsets(grid, "rows");
  const columnSizes = gridColumnSizes(grid);
  const rowSizes = gridRowSizes(grid);
  const round = (value) => Math.round(value * 1000) / 1000;
  return {
    left: round(grid.margin.left + columnOffsets[col - 1]),
    top: round(grid.margin.top + rowOffsets[row - 1]),
    width: round(columnSizes.slice(col - 1, col - 1 + colSpan).reduce((sum, size) => sum + size, 0) + grid.columnGap * (colSpan - 1)),
    height: round(rowSizes.slice(row - 1, row - 1 + rowSpan).reduce((sum, size) => sum + size, 0) + grid.rowGap * (rowSpan - 1)),
  };
}

export function gridAreaRect(grid, areaName) {
  const placement = grid.areas.get(areaName);
  if (!placement) throw new Error(`[lattice-grid] unknown grid area: ${areaName}`);
  return gridPlacementRect(grid, placement);
}

export function gridCellRect(grid, { col, row, colSpan = 1, rowSpan = 1 }) {
  return gridPlacementRect(grid, { name: "", col, row, colSpan, rowSpan });
}

const trackCss = (track) => (track.px !== undefined ? `${track.px}px` : `${track.fr}fr`);

const axisCss = (tracks, count) => (tracks.length === count && tracks.every((t) => t.fr === 1)
  ? `repeat(${count}, 1fr)`
  : tracks.map(trackCss).join(" "));

export function gridTemplateAreasValue(grid) {
  if (grid.areas.size === 0) return "";
  const columnCount = grid.columns.length;
  const rowCount = grid.rows.length;
  const matrix = Array.from({ length: rowCount }, () => Array.from({ length: columnCount }, () => "."));
  for (const placement of grid.areas.values()) {
    for (let r = placement.row - 1; r < placement.row - 1 + placement.rowSpan; r += 1) {
      for (let c = placement.col - 1; c < placement.col - 1 + placement.colSpan; c += 1) {
        if (matrix[r]?.[c] !== undefined) matrix[r][c] = placement.name;
      }
    }
  }
  return matrix.map((row) => `'${row.join(" ")}'`).join(" ");
}

export function gridContainerStyle(grid) {
  const { margin, columnGap, rowGap } = grid;
  const declarations = [
    `grid-template-columns: ${axisCss(grid.columns, grid.columns.length)}`,
    `grid-template-rows: ${axisCss(grid.rows, grid.rows.length)}`,
    `column-gap: ${columnGap}px`,
    `row-gap: ${rowGap}px`,
    `padding: ${margin.top}px ${margin.right}px ${margin.bottom}px ${margin.left}px`,
  ];
  const areas = gridTemplateAreasValue(grid);
  if (areas) declarations.push(`grid-template-areas: ${areas}`);
  return declarations.join("; ");
}

export const gridAreaStyle = (areaName) => `grid-area: ${areaName}`;

export function gridPlacementStyle({ col, row, colSpan = 1, rowSpan = 1 }) {
  const columnEnd = colSpan > 1 ? `span ${colSpan}` : "";
  const rowEnd = rowSpan > 1 ? `span ${rowSpan}` : "";
  return `grid-column: ${col} ${columnEnd}; grid-row: ${row} ${rowEnd}`.replace(/\s+/g, " ").trim() + ";";
}

export function rectToGridPlacement(grid, rect) {
  const columnOffsets = gridTrackOffsets(grid, "columns");
  const rowOffsets = gridTrackOffsets(grid, "rows");
  const columnSizes = gridColumnSizes(grid);
  const rowSizes = gridRowSizes(grid);
  const findStart = (offsets, margin, position) => {
    let best = 0;
    for (let index = 0; index < offsets.length; index += 1) {
      if (margin + offsets[index] <= position + 0.5) best = index;
    }
    return best;
  };
  const findEnd = (offsets, sizes, margin, position) => {
    let best = 0;
    for (let index = 0; index < offsets.length; index += 1) {
      if (margin + offsets[index] + sizes[index] <= position + 0.5) best = index;
    }
    return best;
  };
  const colStart = findStart(columnOffsets, grid.margin.left, rect.x);
  const colEnd = findEnd(columnOffsets, columnSizes, grid.margin.left, rect.x + rect.w);
  const rowStart = findStart(rowOffsets, grid.margin.top, rect.y);
  const rowEnd = findEnd(rowOffsets, rowSizes, grid.margin.top, rect.y + rect.h);
  return {
    col: colStart + 1,
    row: rowStart + 1,
    colSpan: Math.max(1, colEnd - colStart + 1),
    rowSpan: Math.max(1, rowEnd - rowStart + 1),
  };
}

export function renderGridOverlay(grid, { label = true } = {}) {
  const { margin, columnGap, rowGap } = grid;
  const { width: contentWidth, height: contentHeight } = gridContentBox(grid);
  const columnSizes = gridColumnSizes(grid);
  const rowSizes = gridRowSizes(grid);
  const columnOffsets = gridTrackOffsets(grid, "columns");
  const rowOffsets = gridTrackOffsets(grid, "rows");
  const round = (value) => Math.round(value * 100) / 100;

  const columns = columnSizes
    .map(
      (size, index) =>
        `<div class="sl-grid-overlay-col" data-track="${index + 1}" style="left:${round(margin.left + columnOffsets[index])}px;top:${margin.top}px;width:${round(size)}px;height:${contentHeight}px"></div>`,
    )
    .join("");
  const rows = rowSizes
    .map(
      (size, index) =>
        `<div class="sl-grid-overlay-row" data-track="${index + 1}" style="left:${margin.left}px;top:${round(margin.top + rowOffsets[index])}px;width:${contentWidth}px;height:${round(size)}px"></div>`,
    )
    .join("");
  const areaMarkup = [...grid.areas.values()]
    .map((placement) => {
      const rect = gridPlacementRect(grid, placement);
      return `<div class="sl-grid-overlay-area" data-area="${placement.name}" style="left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px">${label ? `<span>${placement.name}</span>` : ""}</div>`;
    })
    .join("");

  return `
    <div class="sl-grid-overlay" aria-hidden="true">
      <div class="sl-grid-overlay-frame" style="left:${margin.left}px;top:${margin.top}px;width:${contentWidth}px;height:${contentHeight}px"></div>
      ${columns}
      ${rows}
      ${areaMarkup}
    </div>
  `;
}
