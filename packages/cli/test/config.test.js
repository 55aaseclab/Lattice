import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_CONFIG, loadConfig } from "../src/config/index.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

test("DEFAULT_CONFIG provides lattice defaults", () => {
  assert.equal(DEFAULT_CONFIG.theme, "simple-light");
  assert.equal(DEFAULT_CONFIG.decksDir, "decks");
  assert.equal(DEFAULT_CONFIG.dev.port, 4666);
});

test("loadConfig merges user config over defaults", async () => {
  const fixture = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "project");
  const config = await loadConfig(fixture);
  assert.equal(config.title, "Fixture Slides");
  assert.equal(config.dev.port, 4777);
  assert.equal(config.theme, "simple-light");
  assert.equal(config.registry, "./decks/registry.js");
});
