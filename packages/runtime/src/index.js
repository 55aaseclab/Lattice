export { DECK_SCHEMA, RUNTIME_VERSION, isRuntimeCompatible, validateManifest, loadDeckPackage } from "./deck/index.js";
export {
  SLIDE_CANVAS,
  gridSpacingTokens,
  defineGrid,
  gridContentBox,
  gridTrackSizes,
  gridColumnSizes,
  gridRowSizes,
  gridTrackOffsets,
  gridPlacementRect,
  gridAreaRect,
  gridCellRect,
  gridTemplateAreasValue,
  gridAreaStyle,
  gridPlacementStyle,
  gridContainerStyle,
  rectToGridPlacement,
  renderGridOverlay,
} from "./grid/index.js";
export {
  layoutGridSpecs,
  layoutGrids,
  blueprintGrid,
  layoutNames,
  validateLayoutGrids,
  createSlideAssembler,
} from "./layout/index.js";
export { createPrimitives } from "./primitives/index.js";
export {
  rectsOverlap,
  validateGridPlacements,
  validateGrids,
  validateRects,
  validateAssets,
} from "./validator/index.js";
