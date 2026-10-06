import {
  SLIDE_CANVAS,
  gridSpacingTokens,
  defineGrid,
  gridContainerStyle,
  gridAreaStyle,
  gridPlacementStyle,
  gridPlacementRect,
  gridAreaRect,
  gridCellRect,
  gridColumnSizes,
  gridRowSizes,
  gridContentBox,
  gridTrackOffsets,
  rectToGridPlacement,
  renderGridOverlay,
} from "../grid/index.js";
import { validateGridPlacements, validateGrids, validateRects, rectsOverlap, validateAssets } from "../validator/index.js";

export {
  SLIDE_CANVAS,
  gridSpacingTokens,
  defineGrid,
  gridContainerStyle,
  gridAreaStyle,
  gridPlacementStyle,
  gridPlacementRect,
  gridAreaRect,
  gridCellRect,
  gridColumnSizes,
  gridRowSizes,
  gridContentBox,
  gridTrackOffsets,
  rectToGridPlacement,
  renderGridOverlay,
  rectsOverlap,
  validateGridPlacements,
  validateGrids,
  validateRects,
  validateAssets,
};

export const layoutGridSpecs = {
  titleSlide: {
    columns: [895],
    rows: [215, 83],
    gap: { y: 5 },
    margin: { top: 78, left: 33, right: 32, bottom: 159 },
    areas: {
      title: { col: 1, row: 1 },
      subtitle: { col: 1, row: 2 },
    },
  },
  sectionHeader: {
    columns: [895],
    rows: [88],
    margin: { top: 226, left: 33, right: 32, bottom: 226 },
    areas: { title: { col: 1, row: 1 } },
  },
  titleBody: {
    columns: [895],
    rows: [60, 359],
    gap: { y: 14 },
    margin: { top: 47, left: 33, right: 32, bottom: 60 },
    areas: {
      title: { col: 1, row: 1 },
      body: { col: 1, row: 2 },
    },
  },
  titleBodySplit: {
    columns: [420, 420],
    rows: [60, 359],
    gap: { x: 55, y: 14 },
    margin: { top: 47, left: 33, right: 32, bottom: 60 },
    areas: {
      title: { col: 1, row: 1, colSpan: 2 },
      "body-left": { col: 1, row: 2 },
      "body-right": { col: 2, row: 2 },
    },
  },
  titleBodySplitOneThirdTwoThirds: {
    columns: [293, 586],
    rows: [60, 359],
    gap: { x: 16, y: 14 },
    margin: { top: 47, left: 33, right: 32, bottom: 60 },
    areas: {
      title: { col: 1, row: 1, colSpan: 2 },
      "body-left": { col: 1, row: 2 },
      "body-right": { col: 2, row: 2 },
    },
  },
  titleTwoColumns: {
    columns: [420, 420],
    rows: [60, 359],
    gap: { x: 55, y: 14 },
    margin: { top: 47, left: 33, right: 32, bottom: 60 },
    areas: {
      title: { col: 1, row: 1, colSpan: 2 },
      "col-left": { col: 1, row: 2 },
      "col-right": { col: 2, row: 2 },
    },
  },
  titleOnly: {
    columns: [895],
    rows: [60, 359],
    gap: { y: 14 },
    margin: { top: 47, left: 33, right: 32, bottom: 60 },
    areas: {
      title: { col: 1, row: 1 },
      body: { col: 1, row: 2 },
    },
  },
  oneColumnText: {
    columns: [295],
    rows: [79, 334],
    gap: { y: 9 },
    margin: { top: 58, left: 33, right: 632, bottom: 60 },
    areas: {
      title: { col: 1, row: 1 },
      body: { col: 1, row: 2 },
    },
  },
  mainPoint: {
    columns: [668],
    rows: [430],
    margin: { top: 47, left: 52, right: 240, bottom: 63 },
    areas: { title: { col: 1, row: 1 } },
  },
  sectionTitleDescription: {
    columns: [425, 65, 403],
    rows: [54, 155, 10, 130, 39],
    margin: { top: 76, left: 28, right: 39, bottom: 76 },
    areas: {
      title: { col: 1, row: 2 },
      subtitle: { col: 1, row: 4 },
      body: { col: 3, row: 1, rowSpan: 5 },
    },
  },
  caption: {
    columns: [630],
    rows: [64],
    margin: { top: 444, left: 33, right: 297, bottom: 32 },
    areas: { body: { col: 1, row: 1 } },
  },
  bigNumber: {
    columns: [895],
    rows: [206, 137],
    gap: { y: 9 },
    margin: { top: 116, left: 33, right: 32, bottom: 72 },
    areas: {
      title: { col: 1, row: 1 },
      body: { col: 1, row: 2 },
    },
  },
};

export const layoutGrids = Object.fromEntries(
  Object.entries(layoutGridSpecs).map(([layoutName, spec]) => [
    layoutName,
    defineGrid({ name: `simple-light/${layoutName}`, ...spec }),
  ]),
);

export const blueprintGrid = defineGrid({
  name: "simple-light/blueprint",
  columns: 12,
  rows: 9,
  gap: gridSpacingTokens.gap,
  margin: { x: gridSpacingTokens.edge, y: gridSpacingTokens.edge },
});

export function validateLayoutGrids() {
  return validateGrids([...Object.values(layoutGrids), blueprintGrid]);
}

export const layoutNames = [
  "Title slide",
  "Section header",
  "Title and body",
  "Title and body split",
  "Title and body split 1/3 2/3",
  "Title and two columns",
  "Title only",
  "One column text",
  "Main point",
  "Section title and description",
  "Caption",
  "Big number",
  "Blank",
];

export const defaultSlideTheme = {
  canvasClass: "slide-canvas",
  footnoteClass: "slide-textbox slide-footnote",
  pageNumberClass: "slide-page-number",
};

export function createSlideAssembler(theme = defaultSlideTheme) {
  const { canvasClass, footnoteClass, pageNumberClass } = theme;

  const metaAttrs = (meta = {}) =>
    Object.entries(meta)
      .map(([key, value]) => `data-${key}="${String(value).replaceAll('"', "&quot;")}"`)
      .join(" ");

  const wrap = (className, content = "", meta = {}, footnote = "") => `
    <section class="${canvasClass} ${className}" ${metaAttrs(meta)}>
      ${content}
      ${footnote === null ? "" : `<div class="${footnoteClass}">${footnote}</div>`}
      <div class="${pageNumberClass}" aria-hidden="true"></div>
    </section>
  `;

  const gridContainer = (grid, cells) => `
    <div class="sl-grid" ${grid.name ? `data-grid="${grid.name}"` : ""} style="${gridContainerStyle(grid)}">
      ${cells.join("")}
      ${renderGridOverlay(grid)}
    </div>
  `;

  const gridSlot = (area, className, content = "") => `
    <div class="${className}" style="${gridAreaStyle(area)}">
      ${content}
    </div>
  `;

  return { wrap, gridContainer, gridSlot, metaAttrs };
}
