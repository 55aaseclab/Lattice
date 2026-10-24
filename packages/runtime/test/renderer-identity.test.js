import assert from "node:assert/strict";
import { test } from "node:test";
import { applyDeckIdentity } from "../src/renderer/core.js";

const fakeRoot = () => ({ dataset: {} });

test("applyDeckIdentity stamps the active deck id on the app root", () => {
  const container = fakeRoot();
  const applied = applyDeckIdentity(container, "demo");
  assert.equal(applied, "demo");
  assert.equal(container.dataset.latticeDeck, "demo");
});

test("applyDeckIdentity overwrites a previous deck id", () => {
  const container = fakeRoot();
  container.dataset.latticeDeck = "demo";
  applyDeckIdentity(container, "m1-test");
  assert.equal(container.dataset.latticeDeck, "m1-test");
});

test("applyDeckIdentity clears the hook when the deck id is absent", () => {
  const container = fakeRoot();
  container.dataset.latticeDeck = "demo";
  assert.equal(applyDeckIdentity(container, null), null);
  assert.equal("latticeDeck" in container.dataset, false);
  assert.equal(applyDeckIdentity(container, ""), null);
  assert.equal("latticeDeck" in container.dataset, false);
});

test("applyDeckIdentity tolerates a missing container", () => {
  assert.equal(applyDeckIdentity(null, "demo"), null);
});
