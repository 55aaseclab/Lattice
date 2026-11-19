import test from 'node:test';
import assert from 'node:assert/strict';
import { inputs, OPERATIONS } from '../src/business/schema.mjs';
import { v2DeckRegistry } from '../src/presentation-decks.js';
test('the public presentation registry begins empty', () => {
  assert.deepEqual(Object.keys(v2DeckRegistry), []);
});
test('managed authoring exports schemas for registered operations', () => {
  for (const name of Object.keys(inputs)) assert.ok(Object.hasOwn(OPERATIONS, name));
});
