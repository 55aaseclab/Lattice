import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig, resolveRuntimeRoot } from "../config/index.js";
import {
  DECK_SCHEMA,
  RUNTIME_VERSION,
  defineGrid,
  isRuntimeCompatible,
  validateGridPlacements,
  validateLayoutGrids,
  validateManifest,
} from "@55aaseclab/lattice-runtime";

export async function validateCommand({ args }) {
  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  const decksDir = path.resolve(cwd, config.decksDir);
  const runtimeRoot = resolveRuntimeRoot();
  const errors = [];

  const gridReport = validateLayoutGrids();
  if (!gridReport.ok) errors.push(...gridReport.errors);

  const registry = await loadRegistry(cwd, config, errors);
  const themeTemplates = await loadThemeTemplates(runtimeRoot, config.theme, errors);

  const deckIds = args.deck ? [args.deck] : listDeckIds(decksDir);
  for (const deckId of deckIds) {
    await validateDeck({ deckId, decksDir, registry, themeTemplates, runtimeRoot, config, errors });
  }

  if (errors.length > 0) {
    console.error(`[lattice] validation failed with ${errors.length} issue(s):`);
    for (const error of errors) console.error(`  - [${error.type}] ${error.message}`);
    process.exit(1);
  }
  console.log(`[lattice] validation passed (${deckIds.length} deck(s), schema ${DECK_SCHEMA}, runtime ${RUNTIME_VERSION})`);
}

function listDeckIds(decksDir) {
  if (!fs.existsSync(decksDir)) return [];
  return fs
    .readdirSync(decksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
}

async function loadRegistry(cwd, config, errors) {
  if (!config.registry) return null;
  const registryPath = path.resolve(cwd, config.registry);
  if (!fs.existsSync(registryPath)) {
    errors.push({ type: "missing-registry", message: `config.registry not found: ${config.registry}` });
    return null;
  }
  try {
    const module = await import(pathToFileURL(registryPath).href);
    return module.deckRegistry ?? null;
  } catch (error) {
    errors.push({ type: "registry-import-failed", message: `${config.registry}: ${error.message}` });
    return null;
  }
}

async function loadThemeTemplates(runtimeRoot, theme, errors) {
  const themeDir = path.join(runtimeRoot, "themes", theme);
  if (!fs.existsSync(path.join(themeDir, "index.js"))) {
    errors.push({ type: "missing-theme", message: `theme not found in runtime: ${theme}` });
    return null;
  }
  try {
    const module = await import(pathToFileURL(path.join(themeDir, "index.js")).href);
    return module.simpleLightLayouts ?? null;
  } catch (error) {
    errors.push({ type: "theme-import-failed", message: `theme ${theme}: ${error.message}` });
    return null;
  }
}

async function validateDeck({ deckId, decksDir, registry, themeTemplates, runtimeRoot, config, errors }) {
  const deckDir = path.join(decksDir, deckId);
  const manifestPath = path.join(deckDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    errors.push({ type: "missing-manifest", message: `deck "${deckId}" has no manifest.json` });
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    errors.push({ type: "invalid-manifest", message: `deck "${deckId}": ${error.message}` });
    return;
  }

  const manifestReport = validateManifest(manifest, { expectedId: deckId, runtimeVersion: RUNTIME_VERSION });
  if (!manifestReport.ok) errors.push(...manifestReport.errors);

  for (const entryName of ["content", "layout", "notes"]) {
    const entryPath = path.join(deckDir, manifest.entry?.[entryName] ?? "");
    if (manifest.entry?.[entryName] && !fs.existsSync(entryPath)) {
      errors.push({ type: "missing-entry", message: `deck "${deckId}": entry.${entryName} not found: ${manifest.entry[entryName]}` });
    }
  }

  if (manifest.runtime && !isRuntimeCompatible(manifest.runtime, RUNTIME_VERSION)) {
    errors.push({ type: "runtime-incompatible", message: `deck "${deckId}": requires runtime ${manifest.runtime}, installed ${RUNTIME_VERSION}` });
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
      errors.push({ type: "entry-import-failed", message: `deck "${deckId}": ${manifest.entry[entryName]}: ${error.message}` });
    }
  }

  validateDeclarativeLayout({ deckId, entries, themeTemplates, errors });

  if (registry) {
    const deck = registry[deckId];
    if (!deck || typeof deck.buildSlides !== "function") {
      errors.push({ type: "missing-deck", message: `registry has no buildSlides for deck "${deckId}"` });
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
      errors.push({ type: "render-warning", message: `deck "${deckId}": ${warning}` });
    }
    return markupSlides;
  } catch (error) {
    errors.push({ type: "build-slides-failed", message: `deck "${deckId}": ${error.message}` });
    return null;
  } finally {
    console.warn = originalWarn;
  }
}

function validateMarkupAssets({ deckId, deckDir, markupSlides, errors }) {
  const assetPattern = /(?:src|href)="((?:\.\/|\.\.\/|\/)[^"]+\.(?:png|jpe?g|svg|gif|webp|avif|mp4|webm|json))"/gi;
  const seen = new Set();
  let match;
  for (const markup of markupSlides) {
    while ((match = assetPattern.exec(markup)) !== null) {
      const url = match[1];
      if (seen.has(url)) continue;
      seen.add(url);
      const deckPrefix = `/decks/${deckId}/`;
      const relativeUrl = url.startsWith(deckPrefix) ? url.slice(deckPrefix.length) : url.replace(/^\.\//, "");
      const candidate = path.resolve(deckDir, relativeUrl);
      const isDeckPath = candidate === deckDir || candidate.startsWith(`${deckDir}${path.sep}`);
      if (!isDeckPath || !fs.existsSync(candidate)) {
        errors.push({ type: "missing-asset", message: `deck "${deckId}": asset not found: ${url}` });
      }
    }
  }
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
        col: element.placement.column ?? element.placement.col ?? 1,
        row: element.placement.row ?? 1,
        colSpan: element.placement.columnSpan ?? element.placement.colSpan ?? 1,
        rowSpan: element.placement.rowSpan ?? 1,
      }));
    const report = validateGridPlacements(grid, placements);
    if (!report.ok) errors.push(...report.errors);

    if (themeTemplates && slideLayout.template) {
      const templateName = String(slideLayout.template).replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      if (typeof themeTemplates[templateName] !== "function") {
        errors.push({ type: "missing-template", message: `deck "${deckId}": theme has no template "${slideLayout.template}"` });
      }
    }

    const slideContent = contentById.get(slideLayout.id);
    for (const element of slideLayout.elements) {
      if (!element.bind) continue;
      if (!slideContent || !(element.bind in slideContent)) {
        errors.push({ type: "unresolved-binding", message: `deck "${deckId}": slide "${slideLayout.id}" element "${element.id}" cannot bind "${element.bind}"` });
      }
    }
  }
}
