import assert from "node:assert/strict";
import { test } from "node:test";
import { createPdfExportUrl } from "../src/renderer/pdf.js";

test("createPdfExportUrl isolates Reveal print mode from authoring state", () => {
  const location = { href: "https://slides.example.test/?deck=old&motion=1&grid=1#/4" };
  assert.equal(
    createPdfExportUrl({ location, deckId: "demo" }),
    "/?deck=demo&export=pdf-renderer&print-pdf=1",
  );
});
