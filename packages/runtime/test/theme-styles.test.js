import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { layoutGridSpecs } from "../src/layout/index.js";

const stylesUrl = new URL("../themes/simple-light/styles.css", import.meta.url);

test("simple-light title slide leaves room for a two-line subtitle", async () => {
  const styles = await readFile(stylesUrl, "utf8");

  assert.deepEqual(layoutGridSpecs.titleSlide.rows, [215, 96]);
  assert.deepEqual(layoutGridSpecs.titleSlide.margin, {
    top: 78,
    left: 33,
    right: 32,
    bottom: 146,
  });
  assert.match(styles, /--layout-title-slide-subtitle-height:\s*96px;/);
});

test("simple-light keeps the last table row border against Reveal defaults", async () => {
  const styles = await readFile(stylesUrl, "utf8");

  assert.match(
    styles,
    /\.reveal \.slide-table tbody tr:last-child td\s*\{\s*border-bottom:\s*1px solid var\(--table-border-color\);\s*\}/,
  );
});

test("simple-light table and figure styles are driven by theme variables", async () => {
  const styles = await readFile(stylesUrl, "utf8");

  for (const token of [
    "--table-font-size",
    "--table-caption-gap",
    "--table-cell-padding",
    "--table-border-color",
    "--table-header-bg",
    "--figure-caption-font-size",
    "--figure-caption-gap",
  ]) {
    assert.ok(styles.includes(`var(${token})`), `${token} should be consumed by primitive styles`);
  }
});

test("simple-light fit classes size content without positioning grid cells", async () => {
  const styles = await readFile(stylesUrl, "utf8");

  assert.match(styles, /\.sl-grid > :is\(\.ph, \.sl-grid-cell\):is\(\.slide-fit-contain, \.slide-fit-cover, \.slide-fit-stretch\)/);
  assert.match(styles, /\.slide-fit-contain[^{}]*\{\s*object-fit:\s*contain;/);
  assert.match(styles, /\.slide-fit-cover[^{}]*\{\s*object-fit:\s*cover;/);
  assert.match(styles, /\.slide-fit-stretch[^{}]*\{\s*object-fit:\s*fill;/);
  assert.doesNotMatch(styles, /\.slide-fit-(?:contain|cover|stretch)[^{}]*\{[^}]*position\s*:/);
  assert.doesNotMatch(styles, /\.sl-grid-cell\.sl-fit-(?:contain|cover|stretch)/);
});

test("simple-light resets Reveal image margins inside image primitives", async () => {
  const styles = await readFile(stylesUrl, "utf8");

  assert.match(styles, /\.slide-figure img\s*\{[^}]*margin:\s*0;/);
  assert.match(
    styles,
    /\.slide-figure\.slide-fit-stretch img\s*\{[^}]*max-width:\s*none;[^}]*max-height:\s*none;/,
  );
});
