export { SLIDE_CANVAS } from "../grid/index.js";
export {
  renderSlides,
  applyDeckIdentity,
  createRevealDeck,
  updateCanvasSlideNumbers,
  createDeckSync,
} from "./core.js";
export { renderDeckApp } from "./deck-app.js";
export { renderPresenterApp } from "./presenter-app.js";
// The M2 presentation surface is intentionally NOT exported here: it depends
// on the slide runtime (and deck-v2), and a static re-export would pull that
// graph into every v1 deck page. Import the dedicated subpath instead:
//   "@55aaseclab/lattice-runtime/renderer/presentation-app"
export { bootStaticDeck } from "./static.js";
export { initInteractiveTrendCharts, initInteractiveAnnotations } from "./interactive.js";
export { initSlideEditor } from "./editor.js";
export { renderFrameMode } from "./motion.js";
export { exportDeckAsPptx, parseViewBox, parseSvgPathData, isSimpleSvgPathSet } from "./pptx.js";
export { createPdfExportUrl, exportDeckAsPdf, installPdfExportRenderer } from "./pdf.js";
export { installFullscreenFit } from "./fullscreen.js";
export { bootDeckPortal, renderDeckLauncher, installDismissibleMenus } from "./portal.js";
export { installDimensionInspection } from "../inspect/dimension-overlay.js";
export { installRenderedInspection, waitForRenderReadiness, RenderReadinessError } from "../inspect/index.js";
export {
  resolveTheme,
  applyThemeTokens,
  createThemeController,
  installThemePicker,
} from "./theme.js";
