import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "vite";
import { loadConfig } from "../config/index.js";
import { DECK_SCHEMA, RUNTIME_VERSION, validateAssets, validateLayoutGrids, validateManifest } from "@lattice/runtime";

export async function exportCommand({ args }) {
  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  const deckId = args.deck;

  if (!deckId || deckId === true) {
    throw new Error("usage: lattice export --deck <deck-id> [--out <dir>] [--skip-build]");
  }

  const registry = await loadRegistry(cwd, config);
  const deck = registry?.[deckId];
  if (!deck) {
    const available = registry ? Object.keys(registry).join(", ") : "none";
    console.error(`[lattice] unknown deck id: ${deckId}`);
    console.error(`[lattice] available decks: ${available}`);
    process.exit(1);
  }

  const deckDir = path.resolve(cwd, config.decksDir, deckId);
  const manifestPath = path.join(deckDir, "manifest.json");
  if (fs.existsSync(manifestPath)) {
    const manifestReport = validateManifest(JSON.parse(fs.readFileSync(manifestPath, "utf8")), {
      expectedId: deckId,
      runtimeVersion: RUNTIME_VERSION,
    });
    if (!manifestReport.ok) {
      console.error(`[lattice] deck "${deckId}" manifest is invalid:`);
      for (const error of manifestReport.errors) console.error(`  - [${error.type}] ${error.message}`);
      process.exit(1);
    }
  }

  const gridReport = validateLayoutGrids();
  if (!gridReport.ok) {
    console.warn("[lattice] layout grid validation issues:", gridReport.errors);
  }

  const workDir = path.join(cwd, ".lattice-export", deckId);
  const buildDir = path.join(workDir, "dist");
  const outDir = path.resolve(args.out || path.join(cwd, config.outDir, "static-decks", deckId));

  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  writeStaticEntry(workDir, { deckId, theme: manifestTheme(deckDir, config.theme), styles: deckStylesPath(cwd, config, deckId) });

  console.log("[lattice] building static deck entry (vite build)...");
  await build({
    root: cwd,
    base: "./",
    publicDir: path.resolve(cwd, config.publicDir),
    build: {
      outDir: buildDir,
      emptyOutDir: true,
      rollupOptions: { input: path.join(workDir, "entry.html") },
    },
  });

  assembleOutput({ cwd, config, deckId, deck, deckDir, buildDir, outDir });
  fs.rmSync(workDir, { recursive: true, force: true });
}

async function loadRegistry(cwd, config) {
  if (!config.registry) return null;
  const registryPath = path.resolve(cwd, config.registry);
  if (!fs.existsSync(registryPath)) return null;
  const module = await import(pathToFileURL(registryPath).href);
  return module.deckRegistry ?? null;
}

function manifestTheme(deckDir, fallbackTheme) {
  const manifestPath = path.join(deckDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) return fallbackTheme;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8")).theme || fallbackTheme;
  } catch {
    return fallbackTheme;
  }
}

function deckStylesPath(cwd, config, deckId) {
  const stylesPath = path.join(cwd, config.decksDir, deckId, "styles.css");
  return fs.existsSync(stylesPath) ? stylesPath : "";
}

function writeStaticEntry(workDir, { theme, styles }) {
  const imports = [
    `import "@lattice/runtime/themes/${theme}/styles.css";`,
    ...(styles ? [`import ${JSON.stringify(path.relative(workDir, styles).split(path.sep).join("/"))};`] : []),
    `import { bootStaticDeck } from "@lattice/runtime/renderer";`,
    ``,
    `bootStaticDeck();`,
  ];

  fs.writeFileSync(
    path.join(workDir, "entry.js"),
    `${imports.join("\n")}\n`,
  );
  fs.writeFileSync(
    path.join(workDir, "entry.html"),
    `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Lattice Deck</title>
    <script type="module" src="./entry.js"></script>
  </head>
  <body>
    <div id="app"></div>
  </body>
</html>
`,
  );
}

function assembleOutput({ cwd, config, deckId, deck, deckDir, buildDir, outDir }) {
  const markupSlides = deck
    .buildSlides()
    .map((markup) => markup.replaceAll(`/decks/${deckId}/`, "./assets/"));

  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const assetsDir = path.join(outDir, "assets");
  fs.mkdirSync(assetsDir, { recursive: true });
  fs.cpSync(path.join(buildDir, "assets"), assetsDir, { recursive: true });

  const deckAssetsSource = path.join(cwd, config.publicDir, "decks", deckId);
  if (fs.existsSync(deckAssetsSource)) {
    fs.cpSync(deckAssetsSource, assetsDir, { recursive: true });
  }

  const slides = markupSlides.map((markup, index) => {
    const meta = extractSlideMeta(markup);
    return {
      slideNumber: meta["slide-number"] ?? String(index + 1),
      layout: meta.layout ?? "",
      font: meta.font ?? "",
      sizes: meta.sizes ?? "",
      html: markup,
    };
  });

  const notes = slides.map((slide) => extractNotes(slide.html));
  const layout = slides.map(({ slideNumber, layout: layoutName, font, sizes }) => ({
    slideNumber,
    layout: layoutName,
    font,
    sizes,
  }));

  const manifest = {
    schema: DECK_SCHEMA,
    id: deck.id,
    title: deck.title,
    runtime: RUNTIME_VERSION,
    theme: manifestTheme(deckDir, config.theme),
    entry: {
      content: "./content.json",
      layout: "./layout.json",
      notes: "./notes.json",
    },
    assets: "./assets/",
  };

  fs.writeFileSync(
    path.join(outDir, "content.json"),
    JSON.stringify({ id: deck.id, title: deck.title, description: deck.description, slides }, null, 2),
  );
  fs.writeFileSync(path.join(outDir, "layout.json"), JSON.stringify(layout, null, 2));
  fs.writeFileSync(path.join(outDir, "notes.json"), JSON.stringify(notes, null, 2));
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));
  fs.copyFileSync(path.join(buildDir, "entry.html"), path.join(outDir, "index.html"));

  const assetReport = validateAssets(markupSlides, {
    exists: (url) => fs.existsSync(path.join(outDir, url.replace(/^\.\//, ""))),
  });
  if (!assetReport.ok) {
    console.warn("[lattice] missing assets:", assetReport.errors);
  }

  console.log(`[lattice] exported deck "${deck.id}" to ${outDir}`);
  console.log(`[lattice] slides: ${slides.length}, assets checked: ${assetReport.assets.length}, missing: ${assetReport.errors.length}`);
}

function extractNotes(markup) {
  const match = markup.match(/<aside class="slide-note-source" hidden>([\s\S]*?)<\/aside>/);
  if (!match) return "";
  return match[1]
    .replace(/<p>/g, "")
    .replace(/<\/p>/g, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

function extractSlideMeta(markup) {
  const openTag = markup.match(/<section\s+([^>]*)>/);
  if (!openTag) return {};
  const attrs = {};
  const attrPattern = /data-([a-z-]+)="([^"]*)"/g;
  let match;
  while ((match = attrPattern.exec(openTag[1])) !== null) {
    attrs[match[1]] = match[2];
  }
  return attrs;
}
