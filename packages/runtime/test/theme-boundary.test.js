import assert from "node:assert/strict";
import { test } from "node:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/*
 * A12 — Theme boundary.
 *
 * simple-light is the first formal Theme and must live in the shared runtime
 * Theme directory. A Theme is a cross-project visual contract: it may never
 * absorb Project/business content (deck copy, research data, deck asset
 * paths, deck-specific markup), and it may not reach outside the runtime
 * package.
 */

const runtimeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const themeDir = join(runtimeRoot, "themes", "simple-light");

function listThemeFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(themeDir);
  return files.sort();
}

test("simple-light lives in the shared runtime Theme directory", () => {
  const stat = statSync(themeDir);
  assert.equal(stat.isDirectory(), true);
  const files = listThemeFiles();
  assert.ok(files.some((file) => file.endsWith("index.js")), "theme must expose index.js");
  assert.ok(files.some((file) => file.endsWith("styles.css")), "theme must expose styles.css");
  assert.ok(files.some((file) => file.endsWith("palettes.js")), "theme must expose palettes.js");
});

test("runtime package.json publishes the theme under the shared themes/ subpath", () => {
  const manifest = JSON.parse(readFileSync(join(runtimeRoot, "package.json"), "utf8"));
  for (const subpath of [
    "./themes/simple-light",
    "./themes/simple-light/palettes",
    "./themes/simple-light/styles.css",
  ]) {
    assert.ok(manifest.exports[subpath], `missing export subpath ${subpath}`);
  }
});

test("Theme sources contain no Project content: no deck asset paths, no business markup", () => {
  for (const file of listThemeFiles()) {
    const source = readFileSync(file, "utf8");
    const relative = file.slice(themeDir.length + 1);
    assert.ok(
      !/\/decks\//.test(source),
      `${relative} must not reference business deck asset paths (/decks/...)`,
    );
    assert.ok(
      !/data-lattice-id|slide-note-source|postdoc|vibe-research|m1-test/i.test(source) || relative === "styles.css",
      `${relative} must not carry deck-specific business markup`,
    );
    // The theme's own page-number/note classes are generic presentation
    // primitives; deck copy, deck ids, and presenter identity must not appear.
    assert.ok(
      !/Qiang Liu|Looking Back|Postdoctoral Reflections/i.test(source),
      `${relative} must not contain business copy`,
    );
  }
});

test("Theme sources only import from within the runtime package boundary", () => {
  const runtimeSrc = resolve(runtimeRoot, "src");
  const importPattern = /(?:^|[\s;])import\s+[^;]*?from\s+["']([^"']+)["']/g;
  for (const file of listThemeFiles()) {
    if (!file.endsWith(".js")) continue;
    const source = readFileSync(file, "utf8");
    let match;
    while ((match = importPattern.exec(source)) !== null) {
      const spec = match[1];
      const insideRuntime =
        spec.startsWith(".") ||
        spec.startsWith("@55aaseclab/lattice-runtime") ||
        spec === "katex" || spec === "reveal.js" || spec.startsWith("d3-");
      assert.ok(
        insideRuntime,
        `${file.slice(themeDir.length + 1)} imports "${spec}" which is outside the runtime Theme boundary`,
      );
      if (spec.startsWith("@55aaseclab/lattice-runtime")) {
        assert.ok(
          !spec.includes("/themes/"),
          "theme files import the runtime core directly, not through theme subpaths",
        );
      }
    }
  }
  void runtimeSrc;
});
