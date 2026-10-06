import assert from "node:assert/strict";
import { test } from "node:test";
import { DECK_SCHEMA, RUNTIME_VERSION, isRuntimeCompatible, validateManifest } from "../src/deck/index.js";

const validManifest = {
  schema: DECK_SCHEMA,
  id: "demo",
  title: "Demo Deck",
  runtime: "^0.1.0",
  theme: "simple-light",
  entry: {
    content: "./content.js",
    layout: "./layout.js",
    notes: "./notes.js",
  },
  assets: "./assets/",
};

test("isRuntimeCompatible handles caret ranges on 0.x", () => {
  assert.equal(isRuntimeCompatible("^0.1.0", "0.1.0"), true);
  assert.equal(isRuntimeCompatible("^0.1.0", "0.1.5"), true);
  assert.equal(isRuntimeCompatible("^0.1.0", "0.2.0"), false);
  assert.equal(isRuntimeCompatible("^1.2.0", "1.2.3"), true);
  assert.equal(isRuntimeCompatible("^1.2.0", "2.0.0"), false);
  assert.equal(isRuntimeCompatible("~0.1.0", "0.1.9"), true);
  assert.equal(isRuntimeCompatible("~0.1.0", "0.2.0"), false);
  assert.equal(isRuntimeCompatible("*", "9.9.9"), true);
  assert.equal(isRuntimeCompatible("not-a-version", "0.1.0"), false);
});

test("validateManifest accepts a valid manifest", () => {
  assert.deepEqual(validateManifest(validManifest), { ok: true, errors: [] });
});

test("validateManifest rejects unsupported schemas", () => {
  const report = validateManifest({ ...validManifest, schema: "lattice.deck.v2" });
  assert.equal(report.ok, false);
  assert.equal(report.errors[0].type, "schema-mismatch");
});

test("validateManifest rejects runtime mismatches", () => {
  const report = validateManifest({ ...validManifest, runtime: "^9.0.0" });
  assert.equal(report.ok, false);
  assert.equal(report.errors[0].type, "runtime-incompatible");
});

test("validateManifest flags id mismatches and missing entries", () => {
  const report = validateManifest(
    { ...validManifest, id: "other", entry: { content: "./content.js" } },
    { expectedId: "demo" },
  );
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((error) => error.type === "invalid-manifest"));
});
