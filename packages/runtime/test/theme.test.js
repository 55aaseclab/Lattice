import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyThemeTokens,
  isDeckThemeEnabled,
  resolveTheme,
} from "../src/renderer/theme.js";
import { defaultPalette, palettes } from "../themes/simple-light/index.js";

const themes = [
  { id: "light", tokens: { canvas: "#fff", accentSoft: "#eee" } },
  { id: "dark", tokens: { canvas: "#111", accentSoft: "#333" } },
];

test("resolveTheme selects requested palette and falls back deterministically", () => {
  assert.equal(resolveTheme(themes, "dark", "light").id, "dark");
  assert.equal(resolveTheme(themes, "missing", "light").id, "light");
});

test("deck themes require only a selected deck and supplied palettes", () => {
  assert.equal(isDeckThemeEnabled({ id: "m1-test" }, themes), true);
  assert.equal(isDeckThemeEnabled({ id: "m1-test" }, []), false);
  assert.equal(isDeckThemeEnabled(null, themes), false);
});

test("simple-light exposes the generic palette contract", () => {
  assert.ok(palettes.length > 0);
  assert.equal(defaultPalette, palettes[0].id);
  assert.ok(palettes.every(({ id, tokens }) => id && tokens?.canvas && tokens?.ink));
});

test("applyThemeTokens writes semantic custom properties without deck-specific naming", () => {
  const properties = new Map();
  const root = {
    dataset: {},
    style: { setProperty: (name, value) => properties.set(name, value) },
  };
  applyThemeTokens(themes[0], { root });
  assert.equal(root.dataset.latticeTheme, "light");
  assert.equal(properties.get("--sl-theme-canvas"), "#fff");
  assert.equal(properties.get("--sl-theme-accent-soft"), "#eee");
});
