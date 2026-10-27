// Machine-consumable source mapping for targeted canonical-source edits.
//
// `lattice edit` navigates a deck's content.js as an object-literal document:
// it locates the object literal carrying a stable slide id, walks a field path
// inside it, and returns exact character/byte spans so a patch can replace
// exactly the target value and nothing else. The scanner is intentionally
// conservative: strings (including template literals), comments, and regex
// literals are opaque; anything it cannot locate uniquely is a hard error so
// an agent never receives a silently wrong source map.

const PUNCTUATORS_BEFORE_REGEX = new Set([
  "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";",
  "+", "-", "*", "%", "<", ">", "~", "^",
]);

const KEYWORDS_STARTING_EXPRESSION = new Set([
  "return", "typeof", "instanceof", "in", "of", "new", "delete",
  "void", "case", "do", "else", "yield", "await", "throw",
]);

function isIdentifierStartChar(char) {
  return /[A-Za-z_$]/.test(char);
}

function isIdentifierChar(char) {
  return /[A-Za-z0-9_$]/.test(char);
}

/**
 * Scan a JS source string and return every object/array literal with the
 * character spans of its direct children.
 *
 * Object record: { kind: "object", start, end, properties: [{ name, keyStart, valueStart, valueEnd }] }
 * Array record:  { kind: "array", start, end, elements: [{ valueStart, valueEnd }] }
 *
 * Spans are half-open [start, end) over the source string (UTF-16 code units).
 * '…', "…", `…` (including ${…} bodies), comments, and heuristic regex
 * literals are opaque tokens.
 */
export function scanSource(source) {
  if (typeof source !== "string") {
    throw new TypeError("source must be a string");
  }
  const length = source.length;
  const stack = [];
  const records = [];
  let index = 0;
  let previousSignificant = "";
  let previousWord = "";

  const top = () => (stack.length ? stack[stack.length - 1] : null);

  // Shared handling for a consumed quoted string: it is an object KEY when it
  // directly follows "{" or "," at an object's depth and a ":" follows.
  const handleStringToken = (raw, quote, endIndex) => {
    const frame = top();
    let next = endIndex;
    while (next < length && /\s/.test(source[next])) next += 1;
    const isKeyCandidate =
      frame && frame.kind === "object" && frame.pendingKey === null &&
      (previousSignificant === "{" || previousSignificant === ",") &&
      source[next] === ":";
    if (isKeyCandidate) {
      let name = raw.slice(1, -1);
      if (quote === '"') {
        try {
          name = JSON.parse(raw);
        } catch {
          // Keep the raw interior when the literal is not strict JSON.
        }
      }
      frame.pendingKey = { name, keyStart: endIndex - raw.length, valueStart: -1, valueEnd: -1 };
      previousSignificant = '"';
      previousWord = "";
      return;
    }
    previousSignificant = '"';
    previousWord = "";
  };

  const pushFrame = (openChar, start) => {
    const frame = {
      kind: openChar === "{" ? "object" : openChar === "[" ? "array" : "paren",
      openChar,
      start,
      end: -1,
      properties: [],
      elements: [],
      pendingKey: null,
      openElement: null,
    };
    stack.push(frame);
    return frame;
  };

  const closePendingKey = (frame, endIndex) => {
    // The last property pushed without a value end is the innermost open
    // value at this frame's depth; a "," or closer at this depth ends it.
    for (let i = frame.properties.length - 1; i >= 0; i -= 1) {
      const property = frame.properties[i];
      if (property.valueStart >= 0 && property.valueEnd < 0) {
        property.valueEnd = endIndex;
        return;
      }
    }
  };

  const closeOpenElement = (frame, endIndex) => {
    if (frame.openElement && frame.openElement.valueEnd < 0) {
      frame.openElement.valueEnd = endIndex;
      frame.elements.push({ valueStart: frame.openElement.valueStart, valueEnd: frame.openElement.valueEnd });
      frame.openElement = null;
    }
  };

  while (index < length) {
    const char = source[index];

    if (char === "/" && source[index + 1] === "/") {
      while (index < length && source[index] !== "\n") index += 1;
      continue;
    }
    if (char === "/" && source[index + 1] === "*") {
      const close = source.indexOf("*/", index + 2);
      index = close === -1 ? length : close + 2;
      continue;
    }
    if (char === '"' || char === "'") {
      const stringEnd = skipQuotedString(source, index, char);
      const raw = source.slice(index, stringEnd);
      index = stringEnd;
      handleStringToken(raw, char, index);
      continue;
    }
    if (char === "`") {
      index = skipTemplateLiteral(source, index);
      previousSignificant = '"';
      previousWord = "";
      continue;
    }
    if (char === "/" && startsRegex(previousSignificant, previousWord)) {
      index = skipRegexLiteral(source, index);
      previousSignificant = "/";
      previousWord = "";
      continue;
    }

    // An array element starts whenever the top frame is an array and the
    // previous significant token was that array's "[" or a depth-0 ",".
    // Closing brackets and whitespace never begin an element.
    const frame = top();
    if (
      frame && frame.kind === "array" && frame.openElement === null &&
      (previousSignificant === "[" || previousSignificant === ",") &&
      char !== "]" && !/\s/.test(char)
    ) {
      frame.openElement = { valueStart: index, valueEnd: -1 };
    }

    if (char === "{" || char === "[" || char === "(") {
      pushFrame(char, index);
      previousSignificant = char;
      previousWord = "";
      index += 1;
      continue;
    }

    if (char === "," ) {
      const current = top();
      if (current) {
        // A shorthand key (no ":") can never be edited; drop it.
        if (current.pendingKey && current.pendingKey.valueStart < 0) current.pendingKey = null;
        closePendingKey(current, index);
        if (current.kind === "array") closeOpenElement(current, index);
      }
      previousSignificant = ",";
      previousWord = "";
      index += 1;
      continue;
    }

    if (char === "}" || char === "]" || char === ")") {
      const current = top();
      if (current && matchesOpen(current.openChar, char)) {
        if (current.pendingKey && current.pendingKey.valueStart < 0) current.pendingKey = null;
        closePendingKey(current, index);
        if (current.kind === "array") closeOpenElement(current, index);
        current.end = index + 1;
        if (current.kind === "object") {
          records.push({ kind: "object", start: current.start, end: current.end, properties: current.properties });
        } else if (current.kind === "array") {
          records.push({ kind: "array", start: current.start, end: current.end, elements: current.elements });
        }
        stack.pop();
      }
      previousSignificant = char;
      previousWord = "";
      index += 1;
      continue;
    }

    if (char === ":" && frame && frame.kind === "object" && frame.pendingKey && frame.pendingKey.valueStart < 0) {
      let valueStart = index + 1;
      while (valueStart < length && /\s/.test(source[valueStart])) valueStart += 1;
      frame.pendingKey.valueStart = valueStart;
      frame.properties.push(frame.pendingKey);
      frame.pendingKey = null;
      previousSignificant = ":";
      previousWord = "";
      index += 1;
      continue;
    }

    if (isIdentifierStartChar(char)) {
      const wordStart = index;
      let end = wordStart;
      while (end < length && isIdentifierChar(source[end])) end += 1;
      const word = source.slice(wordStart, end);
      index = end;
      let next = index;
      while (next < length && /\s/.test(source[next])) next += 1;
      const isKeyCandidate =
        frame && frame.kind === "object" && frame.pendingKey === null &&
        (previousSignificant === "{" || previousSignificant === ",") &&
        source[next] === ":";
      if (isKeyCandidate) {
        frame.pendingKey = { name: word, keyStart: wordStart, valueStart: -1, valueEnd: -1 };
      }
      previousSignificant = "word";
      previousWord = word;
      continue;
    }

    if (isDecimalDigit(char)) {
      let end = index;
      while (end < length && /[0-9a-zA-Z_.]/.test(source[end])) end += 1;
      index = end;
      previousSignificant = "0";
      previousWord = "";
      continue;
    }

    if (!/\s/.test(char)) {
      previousSignificant = char;
      previousWord = "";
    }
    index += 1;
  }

  if (stack.length) {
    throw Object.assign(new Error("source has unbalanced brackets; cannot build a source map"), {
      code: "unbalanced-source",
    });
  }
  return records;
}

function matchesOpen(openChar, closeChar) {
  return (
    (openChar === "{" && closeChar === "}") ||
    (openChar === "[" && closeChar === "]") ||
    (openChar === "(" && closeChar === ")")
  );
}

function skipQuotedString(source, start, quote) {
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === quote) return index + 1;
    if (char === "\n") return index;
    index += 1;
  }
  return index;
}

function skipTemplateLiteral(source, start) {
  let index = start + 1;
  let depth = 0;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (depth === 0 && char === "`") return index + 1;
    if (char === "$" && source[index + 1] === "{") {
      depth += 1;
      index += 2;
      continue;
    }
    if (depth > 0 && char === "}") {
      depth -= 1;
    }
    index += 1;
  }
  return index;
}

function startsRegex(previousSignificant, previousWord) {
  if (previousSignificant === "") return true;
  if (previousSignificant === "word") return KEYWORDS_STARTING_EXPRESSION.has(previousWord);
  if (previousSignificant === '"' || previousSignificant === "0" || previousSignificant === ")" || previousSignificant === "]") return false;
  return PUNCTUATORS_BEFORE_REGEX.has(previousSignificant);
}

function skipRegexLiteral(source, start) {
  let index = start + 1;
  let inClass = false;
  while (index < source.length) {
    const char = source[index];
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "[") inClass = true;
    else if (char === "]") inClass = false;
    else if (char === "/" && !inClass) {
      index += 1;
      while (index < source.length && /[a-z]/.test(source[index])) index += 1;
      return index;
    }
    if (char === "\n") return index;
    index += 1;
  }
  return index;
}

function isDecimalDigit(char) {
  return char >= "0" && char <= "9";
}

/**
 * Locate the object literal carrying a stable slide id.
 *
 * Canonical shape: an object with a direct `id: "<slideId>"` property.
 * Fallback (keyed shape, e.g. decks whose content maps slide ids to objects
 * directly): a direct property named `<slideId>` on the file's outermost
 * object literal. The fallback never fires when any `id:`-carrying object
 * matches, and it only considers root-level keys, never nested ones.
 *
 * Throws coded errors: slide-not-found / slide-ambiguous.
 */
export function findSlideObject(source, records, slideId) {
  const objects = records.filter((record) => record.kind === "object");
  const matches = [];
  for (const record of objects) {
    for (const property of record.properties) {
      if (property.name !== "id" || property.valueStart < 0 || property.valueEnd <= property.valueStart) continue;
      const raw = source.slice(property.valueStart, property.valueEnd).trim();
      if (raw === `"${escapeForExactMatch(slideId)}"` || raw === `'${slideId}'`) {
        matches.push({ record, idSpan: { start: property.valueStart, end: property.valueEnd } });
      }
    }
  }
  if (matches.length === 1) {
    return matches[0];
  }
  if (matches.length > 1) {
    const lines = matches.map((match) => lineOfOffset(source, match.record.start));
    throw Object.assign(
      new Error(`id "${slideId}" matches ${matches.length} object literals (lines ${lines.join(", ")}); a targeted edit requires a unique slide id`),
      { code: "slide-ambiguous", lines },
    );
  }

  // Keyed-shape fallback on the outermost object literal only.
  const outermost = objects.reduce((best, record) => (best === null || record.start < best.start ? record : best), null);
  if (outermost) {
    const keyed = outermost.properties.filter((property) => property.name === slideId && property.valueStart >= 0 && property.valueEnd > property.valueStart);
    if (keyed.length === 1) {
      const valueEnd = trimValueSpanEnd(source, keyed[0].valueStart, keyed[0].valueEnd);
      const valueRecord = objects.find((candidate) => candidate.start === keyed[0].valueStart && candidate.end <= valueEnd);
      if (!valueRecord) {
        throw Object.assign(
          new Error(`slide "${slideId}" is keyed but its value is not an object literal; field edits need an object slide`),
          { code: "slide-not-found" },
        );
      }
      return { record: valueRecord, keyedProperty: keyed[0] };
    }
    if (keyed.length > 1) {
      throw Object.assign(
        new Error(`key "${slideId}" occurs ${keyed.length} times on the root object literal; a targeted edit requires a unique slide id`),
        { code: "slide-ambiguous" },
      );
    }
  }
  throw Object.assign(new Error(`no object literal with id "${slideId}" found in source`), { code: "slide-not-found" });
}

function trimValueSpanEnd(source, valueStart, valueEnd) {
  let end = valueEnd;
  while (end > valueStart && /\s/.test(source[end - 1])) end -= 1;
  return end;
}

function escapeForExactMatch(slideId) {
  // Double-quoted string literals in the sources we scan are strict JSON
  // strings in practice; for an exact match we only need the escaped form of
  // the two characters JSON.stringify would escape inside a simple id slug.
  return slideId.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Walk `fieldPath` (dot-separated; numeric segments address array elements)
 * starting from the slide object record. Returns the target value span plus
 * the navigation chain for the source map.
 */
export function locateFieldPath(source, records, slideRecord, fieldPath) {
  const segments = String(fieldPath)
    .split(".")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw Object.assign(new Error("field path must not be empty"), { code: "invalid-field-path" });
  }

  const chain = [];
  let container = { kind: "object", record: slideRecord };
  for (let depth = 0; depth < segments.length; depth += 1) {
    const segment = segments[depth];
    const last = depth === segments.length - 1;
    if (container.kind === "object") {
      const property = findDirectProperty(source, container.record, segment);
      chain.push({ segment, kind: "property", keyStart: property.keyStart, valueStart: property.valueStart, valueEnd: property.valueEnd });
      if (last) {
        return finalizeTarget(source, { chain, keyStart: property.keyStart, ...trimValueSpan(source, property.valueStart, property.valueEnd) });
      }
      container = requireContainer(source, records, property, segments, depth);
    } else {
      const elementIndex = Number(segment);
      if (!Number.isInteger(elementIndex) || elementIndex < 0) {
        throw Object.assign(
          new Error(`field segment "${segment}" must be a non-negative integer array index`),
          { code: "invalid-array-index" },
        );
      }
      const element = findArrayElement(container.record, elementIndex, segments, depth);
      chain.push({ segment, kind: "element", valueStart: element.valueStart, valueEnd: element.valueEnd });
      if (last) {
        return finalizeTarget(source, { chain, keyStart: element.valueStart, ...trimValueSpan(source, element.valueStart, element.valueEnd) });
      }
      container = requireContainer(source, records, element, segments, depth);
    }
  }
  throw Object.assign(new Error("unreachable field path state"), { code: "invalid-field-path" });
}

function requireContainer(source, records, span, segments, depth) {
  const container = containerAt(records, span.valueStart, span.valueEnd);
  if (!container) {
    throw Object.assign(
      new Error(
        `field "${segments.slice(0, depth + 1).join(".")}" is not an object or array literal in source; cannot descend into "${segments[depth + 1]}"`,
      ),
      { code: "field-not-descendable" },
    );
  }
  return container;
}

// Trailing whitespace between a value and its trailing "," or "}" belongs to
// the file shape, not to the value: exclude it from the replacement span.
function trimValueSpan(source, valueStart, valueEnd) {
  return { valueStart, valueEnd: trimValueSpanEnd(source, valueStart, valueEnd) };
}

// Fail fast before patching when the value region is not a single plain JS
// value (comments or unbalanced brackets would make the replacement span
// untrustworthy).
function finalizeTarget(source, target) {
  assertPlainValueRegion(source, target.valueStart, target.valueEnd);
  return target;
}

function assertPlainValueRegion(source, start, end) {
  const text = source.slice(start, end);
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"' || char === "'" || char === "`") {
      index = char === "`" ? skipTemplateLiteral(text, index) : skipQuotedString(text, index, char);
      continue;
    }
    if (char === "/" && text[index + 1] === "/") {
      throw Object.assign(new Error("target value region contains a line comment; refusing an ambiguous edit"), { code: "unsupported-value-region" });
    }
    if (char === "/" && text[index + 1] === "*") {
      throw Object.assign(new Error("target value region contains a block comment; refusing an ambiguous edit"), { code: "unsupported-value-region" });
    }
    index += 1;
  }
  const stack = [];
  for (const char of text) {
    if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") {
      const open = stack.pop();
      if ((char === "}" && open !== "{") || (char === "]" && open !== "[")) {
        throw Object.assign(new Error("target value region has unbalanced brackets; refusing an ambiguous edit"), { code: "unsupported-value-region" });
      }
    }
  }
  if (stack.length > 0) {
    throw Object.assign(new Error("target value region has unbalanced brackets; refusing an ambiguous edit"), { code: "unsupported-value-region" });
  }
}

function findDirectProperty(source, record, name) {
  const matches = record.properties.filter(
    (property) => property.name === name && property.valueStart >= 0 && property.valueEnd > property.valueStart,
  );
  if (matches.length === 0) {
    throw Object.assign(new Error(`property "${name}" not found in the targeted object literal`), { code: "field-not-found" });
  }
  if (matches.length > 1) {
    const lines = matches.map((property) => lineOfOffset(source, property.keyStart));
    throw Object.assign(
      new Error(`property "${name}" occurs ${matches.length} times in the targeted object literal (lines ${lines.join(", ")}); refusing an ambiguous edit`),
      { code: "field-ambiguous", lines },
    );
  }
  return matches[0];
}

function findArrayElement(record, elementIndex, segments, depth) {
  if (elementIndex >= record.elements.length) {
    throw Object.assign(
      new Error(`array index ${elementIndex} out of range for "${segments.slice(0, depth).join(".")}" (array has ${record.elements.length} element(s))`),
      { code: "field-not-found" },
    );
  }
  return record.elements[elementIndex];
}

function containerAt(records, valueStart, valueEnd) {
  // A value span may carry trailing whitespace before its "," or "}", so the
  // record only has to start exactly at valueStart and fit inside the span.
  for (const record of records) {
    if (record.start === valueStart && record.end <= valueEnd) {
      return { kind: record.kind, record };
    }
  }
  return null;
}

export function lineOfOffset(source, offset) {
  let line = 1;
  const limit = Math.min(offset, source.length);
  for (let index = 0; index < limit; index += 1) {
    if (source[index] === "\n") line += 1;
  }
  return line;
}

export function columnOfOffset(source, offset) {
  let column = 1;
  for (let index = offset - 1; index >= 0; index -= 1) {
    if (source[index] === "\n") break;
    column += 1;
  }
  return column;
}

function utf8Offset(source, charOffset) {
  return Buffer.byteLength(source.slice(0, charOffset), "utf8");
}

/**
 * Serialize a JSON value as a deterministic JS literal. Objects and arrays
 * use 2-space JSON formatting, re-indented to align with `baseIndent` so a
 * replacement keeps the surrounding file shape.
 */
export function serializeJsValue(value, baseIndent = "") {
  if (value === undefined) {
    throw Object.assign(new Error("value must not be undefined; use null instead"), { code: "invalid-value" });
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw Object.assign(new Error("numeric values must be finite"), { code: "invalid-value" });
    }
    return JSON.stringify(value);
  }
  if (typeof value === "boolean" || value === null) return String(value);
  if (typeof value !== "object") {
    throw Object.assign(new Error(`unsupported value type: ${typeof value}`), { code: "invalid-value" });
  }
  const json = JSON.stringify(value, null, 2);
  if (baseIndent === "") return json;
  return json
    .split("\n")
    .map((line, lineIndex) => (lineIndex === 0 ? line : baseIndent + line))
    .join("\n");
}

/**
 * Build the patched source by replacing [valueStart, valueEnd) with `replacement`.
 * Returns the patched text plus span bookkeeping over the ORIGINAL source.
 */
export function buildPatch(source, { valueStart, valueEnd }, replacement) {
  const replaced = source.slice(valueStart, valueEnd);
  const patched = source.slice(0, valueStart) + replacement + source.slice(valueEnd);
  return {
    patched,
    replaced,
    span: {
      charRange: { start: valueStart, end: valueEnd },
      byteRange: { start: utf8Offset(source, valueStart), end: utf8Offset(source, valueEnd) },
      line: lineOfOffset(source, valueStart),
      column: columnOfOffset(source, valueStart),
    },
    replacedBytes: Buffer.byteLength(replaced, "utf8"),
    insertedBytes: Buffer.byteLength(replacement, "utf8"),
  };
}

export function canonicalJsonValue(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return "[" + value.map(canonicalJsonValue).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((key) => JSON.stringify(key) + ":" + canonicalJsonValue(value[key])).join(",") + "}";
}

export function jsonValuesEqual(a, b) {
  return canonicalJsonValue(a) === canonicalJsonValue(b);
}

export function lineIndentation(source, keyStart) {
  let lineStart = keyStart;
  while (lineStart > 0 && source[lineStart - 1] !== "\n") lineStart -= 1;
  let indentEnd = lineStart;
  while (indentEnd < keyStart && /\s/.test(source[indentEnd])) indentEnd += 1;
  return source.slice(lineStart, indentEnd);
}
