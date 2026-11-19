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
  createValidationIssue,
  formatValidationIssue,
  rectsOverlap,
  validateGridPlacements,
  validateGrids,
  validateRects,
  validateAssets,
  layoutGrids,
  blueprintGrid,
  layoutNames,
  validateLayoutGrids,
  createSlideAssembler,
} from "../../src/layout/index.js";
import { createPrimitives } from "../../src/primitives/index.js";
import {
  TECHNICAL_BLOCKS,
  TECHNICAL_BLOCKS_SCHEMA,
  TECHNICAL_BLOCKS_VERSION,
  arrow,
  codeBlock,
  compareTable,
  markerBadge,
  memoryGrid,
  reveal,
  terminalBlock,
  warningCallout,
} from "./technical.js";
export { palettes, defaultPalette } from "./palettes.js";

// Theme change discipline: the simple-light type scale is versioned like the
// theme's other vocabularies. v1 shipped through M9; v2 (issue 001,
// 2026-10-28) reduces the title and body sizes for dense technical decks
// (titles 28pt→25pt, body 18pt→14pt, title family scaled by 25/28); v3
// (issue 001 metadata half, 2026-11-02) aligns the layout `sizes` metadata
// strings with the CSS the v2 scale actually renders — the defaults had
// kept their v1 wording (28pt/18pt/52pt) because deck-source string pins
// and the A13 migration digests depended on them. Presentation-only:
// data-sizes is excluded from the content lock.
export const THEME_VERSION = 3;

// M9 technical content blocks (lattice.technical-blocks.v1): versioned,
// presentation-only primitives for technical teaching decks.
export {
  TECHNICAL_BLOCKS,
  TECHNICAL_BLOCKS_SCHEMA,
  TECHNICAL_BLOCKS_VERSION,
  arrow,
  codeBlock,
  compareTable,
  markerBadge,
  memoryGrid,
  reveal,
  terminalBlock,
  warningCallout,
};

const simpleLightTechnical = {
  arrow,
  codeBlock,
  compareTable,
  markerBadge,
  memoryGrid,
  reveal,
  terminalBlock,
  warningCallout,
};
export { simpleLightTechnical };

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
  createValidationIssue,
  formatValidationIssue,
  rectsOverlap,
  validateGridPlacements,
  validateGrids,
  validateRects,
  validateAssets,
  layoutGrids,
  blueprintGrid,
  layoutNames,
  validateLayoutGrids,
};

const slide = createSlideAssembler({
  canvasClass: "slide-canvas",
  footnoteClass: "slide-textbox slide-footnote",
  pageNumberClass: "slide-page-number",
});

const primitives = createPrimitives({
  textboxClass: "slide-textbox",
  groupClass: "slide-group",
});

export const simpleLightBlocks = primitives;

export const simpleLightLayouts = {
  titleSlide({ title, subtitle = "", sizes = "Title 46pt, Subtitle 25pt" }) {
    const grid = layoutGrids.titleSlide;
    return slide.wrap(
      "layout-title-slide",
      slide.gridContainer(grid, [
        slide.gridSlot("title", "ph title center-bottom", `<h1>${title}</h1>`),
        slide.gridSlot("subtitle", "ph subtitle center-top", `<p>${subtitle}</p>`),
      ]),
      {
        layout: "Title slide",
        font: "Arial",
        sizes,
      },
      null,
    );
  },

  sectionHeader({ title, footnote = "" }) {
    const grid = layoutGrids.sectionHeader;
    return slide.wrap(
      "layout-section-header",
      slide.gridContainer(grid, [slide.gridSlot("title", "ph title center-middle", `<h2>${title}</h2>`)]),
      {
        layout: "Section header",
        font: "Arial",
        sizes: "Title 32pt",
      },
      footnote,
    );
  },

  titleBody({ title, body, bodyClass = "", footnote = "", overlay = "" }) {
    const grid = layoutGrids.titleBody;
    const bodyClasses = ["ph", "body", "padded", "positioning-context", "body-region-full", bodyClass]
      .filter(Boolean)
      .join(" ");

    return slide.wrap(
      "layout-title-body",
      slide.gridContainer(grid, [
        slide.gridSlot("title", "ph title", `<h2>${title}</h2>`),
        slide.gridSlot("body", bodyClasses, `${body}${overlay}`),
      ]),
      {
        layout: "Title and body",
        font: "Arial",
        sizes: "Title 25pt, Body 14pt",
      },
      footnote,
    );
  },

  titleBodySplit({ title, left = "", right = "", bodyClass = "", splitClass = "", footnote = "", overlay = "" }) {
    const grid = layoutGrids.titleBodySplit;
    const layoutClasses = ["layout-title-body-split", splitClass].filter(Boolean).join(" ");
    const leftClasses = ["ph", "body", "body-left", "padded", "top-left", bodyClass]
      .filter(Boolean)
      .join(" ");
    const rightClasses = ["ph", "body", "body-right", "padded", "top-left", bodyClass]
      .filter(Boolean)
      .join(" ");

    return slide.wrap(
      layoutClasses,
      slide.gridContainer(grid, [
        slide.gridSlot("title", "ph title", `<h2>${title}</h2>`),
        slide.gridSlot("body-left", leftClasses, `${left}`),
        slide.gridSlot("body-right", rightClasses, `${right}`),
        overlay,
      ]),
      {
        layout: "Title and body split",
        font: "Arial",
        sizes: "Title 25pt, Body 14pt",
      },
      footnote,
    );
  },

  titleBodySplitOneThirdTwoThirds({
    title,
    left = "",
    right = "",
    footnote = "",
    overlay = "",
  }) {
    const grid = layoutGrids.titleBodySplitOneThirdTwoThirds;
    return slide.wrap(
      "layout-title-body-split-one-third-two-thirds",
      slide.gridContainer(grid, [
        slide.gridSlot("title", "ph title", `<h2>${title}</h2>`),
        slide.gridSlot("body-left", "ph body body-left padded", left),
        slide.gridSlot("body-right", "ph body body-right padded", right),
        overlay,
      ]),
      {
        layout: "Title and body split 1/3 2/3",
        font: "Arial",
        sizes: "Title 25pt, Body 14pt",
      },
      footnote,
    );
  },

  titleTwoColumns({ title, left, right, footnote = "" }) {
    const grid = layoutGrids.titleTwoColumns;
    return slide.wrap(
      "layout-title-two-columns",
      slide.gridContainer(grid, [
        slide.gridSlot("title", "ph title", `<h2>${title}</h2>`),
        slide.gridSlot("col-left", "ph body col-left padded", left),
        slide.gridSlot("col-right", "ph body col-right padded", right),
      ]),
      {
        layout: "Title and two columns",
        font: "Arial",
        sizes: "Title 25pt, Body 14pt",
      },
      footnote,
    );
  },

  titleOnly({ title, footnote = "", body = "", bodyClass = "", overlay = "" }) {
    const grid = layoutGrids.titleOnly;
    const bodyCell = body
      ? slide.gridSlot("body", ["sl-grid-cell", bodyClass].filter(Boolean).join(" "), `${body}${overlay}`)
      : "";
    return slide.wrap(
      "layout-title-only",
      slide.gridContainer(grid, [
        slide.gridSlot("title", "ph title", `<h2>${title}</h2>`),
        bodyCell,
      ]),
      {
        layout: "Title only",
        font: "Arial",
        sizes: "Title 25pt",
      },
      footnote,
    );
  },

  oneColumnText({ title, body, footnote = "" }) {
    const grid = layoutGrids.oneColumnText;
    return slide.wrap(
      "layout-one-column",
      slide.gridContainer(grid, [
        slide.gridSlot("title", "ph title", `<h2>${title}</h2>`),
        slide.gridSlot("body", "ph body padded positioning-context body-region-full", body),
      ]),
      {
        layout: "One column text",
        font: "Arial",
        sizes: "Title 25pt, Body 14pt",
      },
      footnote,
    );
  },

  mainPoint({ title, footnote = "" }) {
    const grid = layoutGrids.mainPoint;
    return slide.wrap(
      "layout-main-point",
      slide.gridContainer(grid, [slide.gridSlot("title", "ph title center-middle", `<h2>${title}</h2>`)]),
      {
        layout: "Main point",
        font: "Arial",
        sizes: "Title 25pt",
      },
      footnote,
    );
  },

  sectionTitleDescription({ title, subtitle, body, footnote = "" }) {
    const grid = layoutGrids.sectionTitleDescription;
    return slide.wrap(
      "layout-section-description",
      [
        '<div class="panel-right"></div>',
        slide.gridContainer(grid, [
          slide.gridSlot("title", "ph title center-bottom", `<h2>${title}</h2>`),
          slide.gridSlot("subtitle", "ph subtitle center-top", `<p>${subtitle}</p>`),
          slide.gridSlot("body", "ph body padded", body),
        ]),
      ].join(""),
      {
        layout: "Section title and description",
        font: "Arial",
        sizes: "Title 42pt, Subtitle 18pt, Body 14pt",
      },
      footnote,
    );
  },

  caption({ body, footnote = "" }) {
    const grid = layoutGrids.caption;
    return slide.wrap(
      "layout-caption",
      slide.gridContainer(grid, [slide.gridSlot("body", "ph body caption-text", body)]),
      {
        layout: "Caption",
        font: "Arial",
        sizes: "Caption 14pt",
      },
      footnote,
    );
  },

  bigNumber({ title, body = "", footnote = "" }) {
    const grid = layoutGrids.bigNumber;
    return slide.wrap(
      "layout-big-number",
      slide.gridContainer(grid, [
        slide.gridSlot("title", "ph title center-bottom", `<h2>${title}</h2>`),
        slide.gridSlot("body", "ph body center-top", `<p>${body}</p>`),
      ]),
      {
        layout: "Big number",
        font: "Arial",
        sizes: "Number 120pt, Body 14pt",
      },
      footnote,
    );
  },

  blank({ footnote = "" } = {}) {
    return slide.wrap("layout-blank", slide.gridContainer(blueprintGrid, []), {
      layout: "Blank",
      font: "Arial",
      sizes: "None",
    }, footnote);
  },
};
