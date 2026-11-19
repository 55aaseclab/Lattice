// M9 slide-level structural editing: plan minimal, auditable source patches
// for add/remove/reorder slide operations.
//
// The canonical deck shape (template-scaffolded, derived): slide order, ids,
// layouts, and stop ids live in the `slides` array of content.js; slides.js
// and slides.v2.js derive from it (renderer table / slideDefinitions map) and
// are therefore never patched by a structure edit. A structural edit patches:
//   content.js     — the slides array (insert/remove/reorder elements)
//   manifest.json  — routes.main (the route that mirrors the content order)
//   notes.js       — per-slide notes (add/remove entry)
// Every patch is a single contiguous span replacement located by the same
// conservative scanner field edits use, so provenance can carry an exact
// charRange/byteRange per file. Anything not exactly locatable is a hard
// error before a single byte is written.

import {
  buildPatch,
  containerAt,
  lineIndentation,
  lineOfOffset,
  locateFieldPath,
  scanSource,
  serializeJsValue,
  utf8Range,
} from "./source-map.js";

export const STRUCTURE_OPS = Object.freeze(["add", "remove", "reorder"]);

const SLIDE_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function structureError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

// ---- Shared literal-array location -----------------------------------------

function findRootObjectRecord(records) {
  const objects = records.filter((record) => record.kind === "object");
  if (objects.length === 0) {
    throw structureError("structure-shape-unsupported", "source contains no object literal to locate the slides array in");
  }
  // The root object is the one that contains every other object literal —
  // content modules may declare helpers (imports, factory calls) before the
  // canonical `export default { … }`, so "first seen" is not the root.
  return objects.reduce((best, record) => {
    const bestSpan = best.end - best.start;
    const recordSpan = record.end - record.start;
    if (recordSpan > bestSpan) return record;
    if (recordSpan === bestSpan && record.start < best.start) return record;
    return best;
  });
}

function locateArrayProperty(source, propertyName) {
  const records = scanSource(source);
  const rootRecord = findRootObjectRecord(records);
  const target = locateFieldPath(source, records, rootRecord, propertyName);
  const container = containerAt(records, target.valueStart, target.valueEnd);
  if (!container || container.kind !== "array") {
    throw structureError(
      "structure-shape-unsupported",
      `the "${propertyName}" value in the canonical source is not an array literal`,
    );
  }
  return {
    records,
    rootRecord,
    span: { valueStart: target.valueStart, valueEnd: target.valueEnd },
    arrayRecord: container.record,
    elements: container.record.elements,
  };
}

function elementText(source, element) {
  let end = element.valueEnd;
  while (end > element.valueStart && /\s/.test(source[end - 1])) end -= 1;
  return source.slice(element.valueStart, end);
}

function trailingCommaIndex(source, valueEnd) {
  let index = valueEnd;
  while (index < source.length && /\s/.test(source[index])) index += 1;
  return source[index] === "," ? index : null;
}

// Remove one array element/property line including its trailing comma and
// the preceding newline, so the previous line closes cleanly and no blank
// line is left behind. When the removed element has no trailing comma (a
// comma-less last element), the previous element's separator comma must be
// stripped too — otherwise a list keeps a dangling comma.
function planElementRemoval(source, valueStart, valueEnd) {
  const lineStart = source.lastIndexOf("\n", valueStart) + 1;
  const commaIndex = trailingCommaIndex(source, valueEnd);
  const removeEnd = (commaIndex ?? valueEnd) + (commaIndex === null ? 0 : 1);
  let removeStart = lineStart > 0 && source[lineStart - 1] === "\n" ? lineStart - 1 : lineStart;
  if (commaIndex === null && removeStart > 0) {
    let index = removeStart - 1;
    while (index >= 0 && /\s/.test(source[index])) index -= 1;
    if (source[index] === ",") removeStart = index;
  }
  return buildPatch(source, { valueStart: removeStart, valueEnd: removeEnd }, "");
}

// ---- slides array patches (content.js) --------------------------------------

/**
 * Insert the serialized slide object after `afterIndex` (or appended at the
 * end). Returns the patch plus the exact span bookkeeping for provenance.
 */
export function planSlideInsert(source, slideValue, { afterIndex = null } = {}) {
  const located = locateArrayProperty(source, "slides");
  const arrayIndent = lineIndentation(source, located.span.valueStart);
  let insertAt;
  let elementIndent;
  if (located.elements.length === 0) {
    if (afterIndex !== null) {
      throw structureError("structure-after-index-out-of-range", `--after references position ${afterIndex}, but the slides array is empty`);
    }
    elementIndent = `${arrayIndent}  `;
    insertAt = located.span.valueStart + 1;
    const serialized = serializeJsValue(slideValue, elementIndent);
    return buildPatch(
      source,
      { valueStart: insertAt, valueEnd: insertAt },
      `\n${elementIndent}${serialized},\n${arrayIndent}`,
    );
  }

  const anchorIndex = afterIndex === null ? located.elements.length - 1 : afterIndex;
  if (anchorIndex < 0 || anchorIndex >= located.elements.length) {
    throw structureError(
      "structure-after-index-out-of-range",
      `--after references position ${anchorIndex}, but the slides array has ${located.elements.length} element(s)`,
    );
  }
  const anchor = located.elements[anchorIndex];
  const commaIndex = trailingCommaIndex(source, anchor.valueEnd);
  elementIndent = lineIndentation(source, anchor.valueStart);
  insertAt = (commaIndex ?? anchor.valueEnd) + (commaIndex === null ? 0 : 1);
  const serialized = serializeJsValue(slideValue, elementIndent);
  const lead = commaIndex === null ? "," : "";
  return buildPatch(
    source,
    { valueStart: insertAt, valueEnd: insertAt },
    `\n${elementIndent}${serialized},${lead}`,
  );
}

/**
 * Remove the slide object at `index` from the slides array. Removing the last
 * remaining element collapses the array to `[]`.
 */
export function planSlideRemove(source, index) {
  const located = locateArrayProperty(source, "slides");
  if (index < 0 || index >= located.elements.length) {
    throw structureError("structure-slide-index-out-of-range", `slides array has ${located.elements.length} element(s); cannot remove position ${index}`);
  }
  if (located.elements.length === 1) {
    return buildPatch(source, located.span, "[]");
  }
  const element = located.elements[index];
  return planElementRemoval(source, element.valueStart, element.valueEnd);
}

/**
 * Reorder the slides array so its elements carry exactly `orderedTexts`
 * (the original source text of each element, in the new order). One span
 * replacement over the whole array keeps the operation atomic and provable.
 */
export function planSlideReorder(source, orderedTexts) {
  const located = locateArrayProperty(source, "slides");
  if (located.elements.length !== orderedTexts.length) {
    throw structureError(
      "structure-source-mismatch",
      `slides array has ${located.elements.length} element(s) but the reorder plan carries ${orderedTexts.length}`,
    );
  }
  const arrayIndent = lineIndentation(source, located.span.valueStart);
  const elementIndent = `${arrayIndent}  `;
  const serialized = `[\n${orderedTexts.map((text) => `${elementIndent}${text}`).join(",\n")},\n${arrayIndent}]`;
  return buildPatch(source, located.span, serialized);
}

// ---- manifest.json routes.main patches --------------------------------------

export function locateRoutesMainArray(manifestSource) {
  const located = locateArrayProperty(manifestSource, "routes.main");
  return located;
}

export function planRouteInsert(manifestSource, slideId, { afterId = null } = {}) {
  const located = locateRoutesMainArray(manifestSource);
  let anchorIndex = null;
  if (afterId !== null) {
    anchorIndex = located.elements.findIndex((element) => JSON.parse(elementText(manifestSource, element)) === afterId);
  }
  if (anchorIndex === null || anchorIndex < 0) {
    anchorIndex = located.elements.length - 1;
  }
  if (located.elements.length === 0) {
    const arrayIndent = lineIndentation(manifestSource, located.span.valueStart);
    const elementIndent = `${arrayIndent}  `;
    return buildPatch(
      manifestSource,
      { valueStart: located.span.valueStart + 1, valueEnd: located.span.valueStart + 1 },
      `\n${elementIndent}${serializeJsValue(slideId)},\n${arrayIndent}`,
    );
  }
  const anchor = located.elements[anchorIndex];
  const commaIndex = trailingCommaIndex(manifestSource, anchor.valueEnd);
  const elementIndent = lineIndentation(manifestSource, anchor.valueStart);
  const insertAt = (commaIndex ?? anchor.valueEnd) + (commaIndex === null ? 0 : 1);
  // manifest.json is strict JSON. Middle insert: the new element needs its
  // own trailing comma (more elements follow). End insert: the comma-less
  // anchor gains the separating comma, the new element stays comma-free.
  const text = commaIndex === null
    ? `,\n${elementIndent}${serializeJsValue(slideId)}`
    : `\n${elementIndent}${serializeJsValue(slideId)},`;
  return buildPatch(
    manifestSource,
    { valueStart: insertAt, valueEnd: insertAt },
    text,
  );
}

export function planRouteRemove(manifestSource, slideId) {
  const located = locateRoutesMainArray(manifestSource);
  const index = located.elements.findIndex((element) => {
    try {
      return JSON.parse(elementText(manifestSource, element)) === slideId;
    } catch {
      return false;
    }
  });
  if (index < 0) return null;
  if (located.elements.length === 1) {
    return buildPatch(manifestSource, located.span, "[]");
  }
  const element = located.elements[index];
  return planElementRemoval(manifestSource, element.valueStart, element.valueEnd);
}

export function planRouteReorder(manifestSource, orderedIds) {
  const located = locateRoutesMainArray(manifestSource);
  const texts = located.elements.map((element) => elementText(manifestSource, element));
  const textById = new Map(texts.map((text) => [JSON.parse(text), text]));
  const orderedTexts = orderedIds.map((id) => {
    const text = textById.get(id);
    if (text === undefined) {
      throw structureError("structure-route-id-missing", `routes.main does not carry slide id ${JSON.stringify(id)}`);
    }
    return text;
  });
  // manifest.json is strict JSON: no trailing comma.
  const arrayIndent = lineIndentation(manifestSource, located.span.valueStart);
  const elementIndent = `${arrayIndent}  `;
  const serialized = `[\n${orderedTexts.map((text) => `${elementIndent}${text}`).join(",\n")}\n${arrayIndent}]`;
  return buildPatch(manifestSource, located.span, serialized);
}

// ---- notes.js patches --------------------------------------------------------

export function locateNotesRoot(notesSource) {
  const records = scanSource(notesSource);
  return { records, rootRecord: findRootObjectRecord(records) };
}

export function planNotesInsert(notesSource, slideId, noteText) {
  const { rootRecord } = locateNotesRoot(notesSource);
  if (rootRecord.properties.some((property) => property.name === slideId)) {
    throw structureError("structure-note-exists", `notes.js already carries a note for slide "${slideId}"`);
  }
  const openBrace = rootRecord.start;
  if (rootRecord.properties.length === 0) {
    const rootIndent = lineIndentation(notesSource, rootRecord.start);
    const propertyIndent = `${rootIndent}  `;
    return buildPatch(
      notesSource,
      { valueStart: openBrace + 1, valueEnd: openBrace + 1 },
      `\n${propertyIndent}${JSON.stringify(slideId)}: ${serializeJsValue(noteText)},\n${rootIndent}`,
    );
  }
  const last = rootRecord.properties[rootRecord.properties.length - 1];
  const commaIndex = trailingCommaIndex(notesSource, last.valueEnd);
  const propertyIndent = lineIndentation(notesSource, last.keyStart);
  const insertAt = (commaIndex ?? last.valueEnd) + (commaIndex === null ? 0 : 1);
  const lead = commaIndex === null ? "," : "";
  return buildPatch(
    notesSource,
    { valueStart: insertAt, valueEnd: insertAt },
    `\n${propertyIndent}${JSON.stringify(slideId)}: ${serializeJsValue(noteText)},${lead}`,
  );
}

export function planNotesRemove(notesSource, slideId) {
  const { rootRecord } = locateNotesRoot(notesSource);
  const property = rootRecord.properties.find((candidate) => candidate.name === slideId);
  if (!property) return null;
  return planElementRemoval(notesSource, property.keyStart, property.valueEnd);
}

// ---- Derived-shape guards ----------------------------------------------------

export function assertDerivedStructureShape({ slidesSource, slidesV2Source }) {
  if (!slidesSource || !slidesV2Source) {
    throw structureError(
      "structure-shape-unsupported",
      "structural edits require the derived deck shape (slides.js and slides.v2.js)",
    );
  }
  if (!slidesSource.includes("content.slides.map(")) {
    throw structureError(
      "structure-shape-unsupported",
      'slides.js is not derived from content.slides; structural edits require the renderer-table shape (buildSlides() maps content.slides). Re-scaffold or convert the deck before using "lattice edit --structure".',
    );
  }
  const v2Derived = /import\s+content\s+from\s+"\.\/content\.js";/.test(slidesV2Source) &&
    /import\s+\{\s*buildSlides\s*\}\s+from\s+"\.\/slides\.js";/.test(slidesV2Source);
  if (!v2Derived) {
    throw structureError(
      "structure-shape-unsupported",
      'slides.v2.js is not derived from content.slides; structural edits require the derived slideDefinitions shape (ids, timing, and stops derived from the content array). Re-scaffold or convert the deck before using "lattice edit --structure".',
    );
  }
}

// ---- Source↔view cross-check --------------------------------------------------

/**
 * Cross-check the scanned slides-array elements against the in-memory deck
 * view so a structural patch can never target a stale or reordered source.
 * Returns the ordered slide ids and the per-index element texts.
 */
export function crossCheckSlidesSource(source, contentSlides) {
  const located = locateArrayProperty(source, "slides");
  if (located.elements.length !== contentSlides.length) {
    throw structureError(
      "structure-source-mismatch",
      `content.js scans ${located.elements.length} slides array element(s) but the deck view carries ${contentSlides.length}; refusing an ambiguous structural edit`,
    );
  }
  const ids = [];
  const texts = [];
  located.elements.forEach((element, index) => {
    const text = elementText(source, element);
    const elementRecord = located.records.find(
      (candidate) => candidate.kind === "object" && candidate.start === element.valueStart,
    );
    const idProperty = elementRecord?.properties.find(
      (property) => property.name === "id" && property.valueStart >= 0 && property.valueEnd > property.valueStart,
    );
    let sourceId = null;
    if (idProperty) {
      try {
        sourceId = JSON.parse(source.slice(idProperty.valueStart, idProperty.valueEnd));
      } catch {
        sourceId = null;
      }
    }
    const viewId = contentSlides[index]?.id ?? null;
    if (sourceId === null || sourceId !== viewId) {
      throw structureError(
        "structure-source-mismatch",
        `content.js slides[${index}] scans as id ${JSON.stringify(sourceId)} but the deck view carries ${JSON.stringify(viewId)}; refusing an ambiguous structural edit`,
      );
    }
    ids.push(sourceId);
    texts.push(text);
  });
  return { ids, texts, elements: located.elements, span: located.span };
}

export { lineOfOffset, utf8Range };
