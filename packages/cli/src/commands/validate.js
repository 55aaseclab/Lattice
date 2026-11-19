import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, resolveRuntimeRoot } from "../config/index.js";
import { createProjectModuleLoader } from "../deck-v2/project-module-loader.js";
import {
  DECK_SCHEMA,
  DECK_SCHEMA_V2,
  RUNTIME_VERSION,
  createValidationIssue,
  defineGrid,
  formatValidationIssue,
  validateAssets,
  validateDeckManifestV2,
  validateGridPlacements,
  validateLayoutGrids,
  validateManifest,
  validateSlideDefinitions,
} from "@55aaseclab/lattice-runtime";

export async function validateCommand({ args }) {
  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  const decksDir = path.resolve(cwd, config.decksDir);
  const runtimeRoot = resolveRuntimeRoot();
  const errors = [];
  const validatedSchemas = new Set();

  const gridReport = validateLayoutGrids();
  if (!gridReport.ok) errors.push(...gridReport.errors);

  // One shared vite module pipeline serves the registry and every v2 slide
  // entry import for this run.
  const moduleLoader = await createProjectModuleLoader(cwd);
  let validatedDeckCount = 0;
  try {
    const registry = await loadRegistry(cwd, config, errors, moduleLoader);
    const themeTemplates = await loadThemeTemplates(runtimeRoot, config.theme, errors);

    const deckIds = args.deck ? [args.deck] : listDeckIds(decksDir);
    for (const deckId of deckIds) {
      await validateDeck({ deckId, decksDir, registry, themeTemplates, runtimeRoot, config, errors, moduleLoader, validatedSchemas });
      validatedDeckCount += 1;
    }
  } finally {
    await moduleLoader.close();
  }

  if (errors.length > 0) {
    console.error(`[lattice] validation failed with ${errors.length} issue(s):`);
    for (const error of errors) console.error(`  - ${formatValidationIssue(error)}`);
    process.exit(1);
  }
  const schemaSummary = [...validatedSchemas].sort().join(", ") || DECK_SCHEMA;
  console.log(`[lattice] validation passed (${validatedDeckCount} deck(s), schemas ${schemaSummary}, runtime ${RUNTIME_VERSION})`);
}

function listDeckIds(decksDir) {
  if (!fs.existsSync(decksDir)) return [];
  return fs
    .readdirSync(decksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
}

async function loadRegistry(cwd, config, errors, moduleLoader) {
  if (!config.registry) return null;
  const registryPath = path.resolve(cwd, config.registry);
  if (!fs.existsSync(registryPath)) {
    errors.push(createValidationIssue({
      type: "missing-registry",
      element: "config.registry",
      message: `config.registry not found: ${config.registry}`,
    }));
    return null;
  }
  try {
    const module = await moduleLoader.load(registryPath);
    return module.deckRegistry ?? null;
  } catch (error) {
    errors.push(createValidationIssue({
      type: "registry-import-failed",
      element: "config.registry",
      message: `${config.registry}: ${error.message}`,
    }));
    return null;
  }
}

async function loadThemeTemplates(runtimeRoot, theme, errors) {
  const themeDir = path.join(runtimeRoot, "themes", theme);
  if (!fs.existsSync(path.join(themeDir, "index.js"))) {
    errors.push(createValidationIssue({
      type: "missing-theme",
      element: "config.theme",
      message: `theme not found in runtime: ${theme}`,
    }));
    return null;
  }
  try {
    const module = await import(pathToFileURL(path.join(themeDir, "index.js")).href);
    return module.simpleLightLayouts ?? null;
  } catch (error) {
    errors.push(createValidationIssue({
      type: "theme-import-failed",
      element: "config.theme",
      message: `theme ${theme}: ${error.message}`,
    }));
    return null;
  }
}

async function validateDeck({ deckId, decksDir, registry, themeTemplates, runtimeRoot, config, errors, moduleLoader, validatedSchemas }) {
  const deckDir = path.join(decksDir, deckId);
  const manifestPath = path.join(deckDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    errors.push(createValidationIssue({
      type: "missing-manifest",
      slide: deckId,
      element: "manifest",
      message: `deck "${deckId}" has no manifest.json`,
    }));
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    errors.push(createValidationIssue({
      type: "invalid-manifest",
      slide: deckId,
      element: "manifest",
      message: `deck "${deckId}": ${error.message}`,
    }));
    return;
  }

  const isV2 = manifest.schema === DECK_SCHEMA_V2;
  validatedSchemas.add(isV2 ? DECK_SCHEMA_V2 : DECK_SCHEMA);

  // Schema dispatch is explicit: v1 decks take the v1 validator, v2 decks take
  // the v2 validator. Neither path ever masquerades as the other.
  const manifestReport = isV2
    ? validateDeckManifestV2(manifest, { expectedId: deckId, runtimeVersion: RUNTIME_VERSION })
    : validateManifest(manifest, { expectedId: deckId, runtimeVersion: RUNTIME_VERSION });
  if (!manifestReport.ok) errors.push(...manifestReport.errors);

  for (const entryName of ["content", "layout", "notes"]) {
    const entryPath = path.join(deckDir, manifest.entry?.[entryName] ?? "");
    if (manifest.entry?.[entryName] && !fs.existsSync(entryPath)) {
      errors.push(createValidationIssue({
        type: "missing-entry",
        slide: deckId,
        element: `manifest.entry.${entryName}`,
        message: `deck "${deckId}": entry.${entryName} not found: ${manifest.entry[entryName]}`,
      }));
    }
  }

  if (isV2 && manifest.entry?.slides) {
    const slideEntryPath = path.join(deckDir, manifest.entry.slides);
    if (!fs.existsSync(slideEntryPath)) {
      errors.push(createValidationIssue({
        type: "missing-entry",
        slide: deckId,
        element: "manifest.entry.slides",
        message: `deck "${deckId}": entry.slides not found: ${manifest.entry.slides}`,
      }));
    }
  }

  const entries = {};
  for (const entryName of ["content", "layout", "notes"]) {
    if (!manifest.entry?.[entryName]) continue;
    const entryPath = path.join(deckDir, manifest.entry[entryName]);
    if (!fs.existsSync(entryPath)) continue;
    try {
      const module = await import(pathToFileURL(entryPath).href);
      entries[entryName] = module.default ?? module;
    } catch (error) {
      errors.push(createValidationIssue({
        type: "entry-import-failed",
        slide: deckId,
        element: `manifest.entry.${entryName}`,
        message: `deck "${deckId}": ${manifest.entry[entryName]}: ${error.message}`,
      }));
    }
  }

  if (isV2 && manifest.entry?.slides) {
    const slideEntryPath = path.join(deckDir, manifest.entry.slides);
    if (fs.existsSync(slideEntryPath)) {
      try {
        const slideModule = await moduleLoader.load(slideEntryPath);
        const slideDefinitions = slideModule?.slideDefinitions;
        if (!Array.isArray(slideDefinitions)) {
          errors.push(createValidationIssue({
            type: "invalid-slide-entry",
            slide: deckId,
            element: "manifest.entry.slides",
            message: `deck "${deckId}": ${manifest.entry.slides} must export a "slideDefinitions" array (lattice.deck.v2)`,
          }));
        } else {
          const report = validateSlideDefinitions(slideDefinitions);
          errors.push(...report.errors);
          const routeClosure = validateDeckManifestV2(manifest, {
            expectedId: deckId,
            slideIds: report.slideIds,
            runtimeVersion: RUNTIME_VERSION,
          });
          if (!routeClosure.ok) {
            for (const error of routeClosure.errors) {
              if (error.element?.startsWith("manifest.routes") || error.element?.startsWith("manifest.videoProfiles")) {
                errors.push(error);
              }
            }
          }
        }
      } catch (error) {
        errors.push(createValidationIssue({
          type: "entry-import-failed",
          slide: deckId,
          element: "manifest.entry.slides",
          message: `deck "${deckId}": ${manifest.entry.slides}: ${error.message}`,
        }));
      }
    }
  }

  validateDeclarativeLayout({ deckId, entries, themeTemplates, errors });

  if (registry) {
    const deck = registry[deckId];
    if (!deck || typeof deck.buildSlides !== "function") {
      errors.push(createValidationIssue({
        type: "missing-deck",
        slide: deckId,
        element: "registry.buildSlides",
        message: `registry has no buildSlides for deck "${deckId}"`,
      }));
    } else {
      const markupSlides = runBuildSlides(deck, deckId, errors);
      if (markupSlides) validateMarkupAssets({ deckId, deckDir, markupSlides, errors });
    }
  }
}

function runBuildSlides(deck, deckId, errors) {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => warnings.push(args.map(String).join(" "));
  try {
    const markupSlides = deck.buildSlides();
    for (const warning of warnings) {
      errors.push(createValidationIssue({
        type: "render-warning",
        slide: deckId,
        element: "buildSlides",
        message: `deck "${deckId}": ${warning}`,
      }));
    }
    return markupSlides;
  } catch (error) {
    errors.push(createValidationIssue({
      type: "build-slides-failed",
      slide: deckId,
      element: "buildSlides",
      message: `deck "${deckId}": ${error.message}`,
    }));
    return null;
  } finally {
    console.warn = originalWarn;
  }
}

function validateMarkupAssets({ deckId, deckDir, markupSlides, errors }) {
  const report = validateAssets(markupSlides, {
    exists: (url) => {
      const deckPrefix = `/decks/${deckId}/`;
      const relativeUrl = url.startsWith(deckPrefix) ? url.slice(deckPrefix.length) : url.replace(/^\.\//, "");
      const candidate = path.resolve(deckDir, relativeUrl);
      const isDeckPath = candidate === deckDir || candidate.startsWith(`${deckDir}${path.sep}`);
      return isDeckPath && fs.existsSync(candidate);
    },
  });
  errors.push(...report.errors.map((error) => ({
    ...error,
    message: `deck "${deckId}": ${error.message}`,
  })));
}

function validateDeclarativeLayout({ deckId, entries, themeTemplates, errors }) {
  const layout = entries.layout;
  if (!layout || typeof layout !== "object" || !Array.isArray(layout.slides)) return;
  const content = entries.content;
  const contentById = new Map(
    Array.isArray(content?.slides) ? content.slides.map((slide) => [slide.id, slide]) : [],
  );

  for (const slideLayout of layout.slides) {
    if (!slideLayout.grid || !Array.isArray(slideLayout.elements)) continue;
    const grid = defineGrid({ name: `${deckId}/${slideLayout.id || "slide"}`, ...slideLayout.grid });
    const placements = slideLayout.elements
      .filter((element) => element.placement)
      .map((element) => ({
        name: element.id || "",
        area: element.area || element.id || null,
        element: element.inspectorName || element.name || element.id || null,
        col: element.placement.column ?? element.placement.col ?? 1,
        row: element.placement.row ?? 1,
        colSpan: element.placement.columnSpan ?? element.placement.colSpan ?? 1,
        rowSpan: element.placement.rowSpan ?? 1,
      }));
    const report = validateGridPlacements(grid, placements, { slide: slideLayout.id || null });
    if (!report.ok) errors.push(...report.errors);

    if (themeTemplates && slideLayout.template) {
      const templateName = String(slideLayout.template).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      if (typeof themeTemplates[templateName] !== "function") {
        errors.push(createValidationIssue({
          type: "missing-template",
          slide: slideLayout.id || deckId,
          element: "layout.template",
          message: `deck "${deckId}": theme has no template "${slideLayout.template}"`,
        }));
      }
    }

    const slideContent = contentById.get(slideLayout.id);
    for (const element of slideLayout.elements) {
      if (!element.bind) continue;
      if (!slideContent || !(element.bind in slideContent)) {
        errors.push(createValidationIssue({
          type: "unresolved-binding",
          slide: slideLayout.id || deckId,
          area: element.area || element.id || null,
          element: element.inspectorName || element.name || element.id || null,
          binding: element.bind,
          message: `deck "${deckId}": slide "${slideLayout.id}" element "${element.id}" cannot bind "${element.bind}"`,
        }));
      }
    }
  }
}
