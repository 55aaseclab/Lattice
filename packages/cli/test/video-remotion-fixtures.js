import { mkdirSync, writeFileSync, copyFileSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { compileVideoPlan, bakeVideoPlanProvenance } from "@55aaseclab/lattice-runtime/video-plan";
import { computeBundleIdentityHash } from "../src/video/bundle.js";

const fixturesDir = fileURLToPath(new URL("./fixtures", import.meta.url));
const themeCssPath = join(fixturesDir, "..", "..", "..", "runtime", "themes", "simple-light", "styles.css");

export const CONFORMANCE_SLIDES_MODULE = join(fixturesDir, "video-conformance-project", "decks", "conformance", "slides.v2.js");

export async function loadConformanceSlideDefinitions() {
  const module = await import(CONFORMANCE_SLIDES_MODULE);
  return module.slideDefinitions;
}

export function sha256OfBytes(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Deterministic SHA-256 over a regular-file tree, hashed as
 * `<relPath>\0<bytes>\0` in sorted path order — the same identity scheme the
 * canonical VideoPlan provenance uses for deck sources.
 */
export function hashTree(rootDir, { skip = [] } = {}) {
  const files = [];
  const walk = (dir, relPrefix) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      const rel = relPrefix === "" ? entry.name : `${relPrefix}/${entry.name}`;
      if (skip.some((candidate) => rel === candidate || rel.startsWith(`${candidate}/`))) continue;
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`unexpected symlink in tree: ${rel}`);
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        files.push({ rel, full });
      }
    }
  };
  walk(rootDir, "");
  const hash = createHash("sha256");
  for (const { rel, full } of files) {
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(full));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * A real Slide Web Bundle assembled from the conformance fixture's canonical
 * slide definitions and the real simple-light theme stylesheet — the same
 * bundle contract that "lattice export" produces, without a vite build.
 */
export function makeConformanceBundle(projectRoot, { deckId = "conformance", slideDefinitions } = {}) {
  const bundleDir = join(projectRoot, "dist", "static-decks", deckId);
  mkdirSync(join(bundleDir, "assets"), { recursive: true });

  const themeCss = readFileSync(themeCssPath, "utf8");
  writeFileSync(
    join(bundleDir, "index.html"),
    [
      "<!doctype html>",
      "<html lang=\"en\">",
      "  <head>",
      "    <meta charset=\"UTF-8\" />",
      `    <title>${deckId}</title>`,
      "    <script type=\"module\" crossorigin src=\"./assets/entry-fixture.js\"></script>",
      "    <link rel=\"stylesheet\" crossorigin href=\"./assets/theme.css\">",
      "  </head>",
      "  <body><div id=\"app\"></div></body>",
      "</html>",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(join(bundleDir, "assets", "theme.css"), themeCss, "utf8");
  copyFileSync(
    join(fixturesDir, "video-conformance-project", "decks", "conformance", "assets", "lattice-conformance.svg"),
    join(bundleDir, "assets", "lattice-conformance.svg"),
  );

  const slides = slideDefinitions.map((slide, index) => ({
    slideNumber: String(index + 1),
    layout: "",
    font: "Arial",
    sizes: "",
    html: typeof slide.html === "function" ? slide.html() : slide.html,
  }));
  writeFileSync(
    join(bundleDir, "manifest.json"),
    JSON.stringify({
      schema: "lattice.deck.v1",
      id: deckId,
      title: "Video Conformance Fixture",
      theme: "simple-light",
      entry: { content: "./content.json", layout: "./layout.json", notes: "./notes.json" },
      assets: "./assets/",
    }),
    "utf8",
  );
  writeFileSync(join(bundleDir, "content.json"), JSON.stringify({ id: deckId, title: "Video Conformance Fixture", slides }, null, 2), "utf8");
  writeFileSync(join(bundleDir, "layout.json"), JSON.stringify(slides.map((s) => ({ slideNumber: s.slideNumber, layout: s.layout, font: s.font, sizes: s.sizes }))), "utf8");
  writeFileSync(join(bundleDir, "notes.json"), JSON.stringify(slides.map(() => "")), "utf8");

  return bundleDir;
}

/** A complete baked plan whose provenance names the real bundle. */
export function makeConformancePlan({ bundleDir, deckId = "conformance", slideDefinitions } = {}) {
  const routes = { main: slideDefinitions.map((slide) => slide.id) };
  const result = compileVideoPlan({
    deckId,
    routeId: "main",
    routes,
    slides: slideDefinitions.map((slide) => ({
      id: slide.id,
      durationFrames: slide.durationFrames,
      inputProps: {},
    })),
    width: 960,
    height: 540,
    fps: 30,
  });
  if (!result.ok) throw new Error(`plan compile failed: ${result.reason}`);
  return bakeVideoPlanProvenance(result.plan, {
    deckHash: sha256OfBytes(Buffer.from("conformance-deck-source")),
    bundleHash: computeBundleIdentityHash(bundleDir),
    inputPropsHash: sha256OfBytes(Buffer.from("conformance-input-props")),
  });
}

export { dirname };
