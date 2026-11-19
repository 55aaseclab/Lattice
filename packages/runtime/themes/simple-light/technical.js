/*
 * simple-light technical content blocks (M9).
 *
 * Versioned theme-level content primitives for technical teaching decks:
 * code blocks, terminal output, gridded memory layouts, annotations
 * (numbered markers + CSS arrows), warning callouts, and a compare-table
 * presentation. Blocks are presentation only — they never carry business
 * copy; every visible string arrives as an escaped parameter. Agents use
 * them as structured markup semantics; no hand-written inline styles.
 *
 * Styles live in ./styles.css under the `sl-tech-*` class namespace and are
 * driven by theme tokens. No syntax highlighting dependency: code renders
 * as escaped monospace text.
 */

export const TECHNICAL_BLOCKS_SCHEMA = "lattice.technical-blocks.v1";
export const TECHNICAL_BLOCKS_VERSION = 1;

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);

const nameAttr = (name) => (name ? ` data-inspector-name="${escapeHtml(name)}"` : "");

const revealAttr = (reveal) =>
  reveal ? ` data-lattice-reveal="${escapeHtml(reveal)}"` : "";

function requirePlainObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`[simple-light] ${name} must be an object`);
  }
}

function optionalText(value, name) {
  if (value === undefined || value === null) return "";
  return String(value);
}

function requiredText(value, name) {
  if (value === undefined || value === null || String(value).trim() === "") {
    throw new TypeError(`[simple-light] ${name} must be a non-empty string`);
  }
  return String(value);
}

function optionalReveal(value, name) {
  if (value === undefined || value === null || value === "") return "";
  const text = String(value);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(text)) {
    throw new TypeError(`[simple-light] ${name} must be a stable slug, got ${JSON.stringify(value)}`);
  }
  return text;
}

/**
 * Wrap markup in a stop-reveal group. The stop id must exist in the slide's
 * declared stops (validated by the timeline resolution).
 */
export function reveal({ stop, content }) {
  const stopId = optionalReveal(stop, "reveal.stop");
  if (!stopId) throw new TypeError("[simple-light] reveal.stop must be a stable slug");
  return `<div data-lattice-reveal="${stopId}">${content ?? ""}</div>`;
}

/**
 * Code block: escaped monospace code, optional language tag and caption.
 * `code` renders verbatim (escaped); no highlighting dependency.
 */
export function codeBlock({ code, language = "", caption = "", reveal: revealStop = "", name = "" } = {}) {
  requirePlainObject(arguments[0] ?? {}, "codeBlock");
  const codeText = requiredText(code, "codeBlock.code");
  const classes = ["sl-tech-code"];
  const languageTag = optionalText(language, "codeBlock.language");
  const captionText = optionalText(caption, "codeBlock.caption");
  const markup = [
    `<figure class="${classes.join(" ")}"${nameAttr(name)}${revealAttr(optionalReveal(revealStop, "codeBlock.reveal"))}>`,
    languageTag ? `<span class="sl-tech-lang">${escapeHtml(languageTag)}</span>` : "",
    captionText ? `<figcaption class="sl-tech-caption">${escapeHtml(captionText)}</figcaption>` : "",
    `<pre class="sl-tech-pre"><code>${escapeHtml(codeText)}</code></pre>`,
    `</figure>`,
  ].join("");
  return markup;
}

/**
 * Terminal output block: a window-chrome figure with an optional command
 * line (rendered with a prompt glyph) and escaped output text.
 */
export function terminalBlock({ command = "", output = "", caption = "", reveal: revealStop = "", name = "" } = {}) {
  requirePlainObject(arguments[0] ?? {}, "terminalBlock");
  const commandText = optionalText(command, "terminalBlock.command");
  const outputText = optionalText(output, "terminalBlock.output");
  if (!commandText && !outputText) {
    throw new TypeError("[simple-light] terminalBlock requires a command or output");
  }
  const captionText = optionalText(caption, "terminalBlock.caption");
  const lines = [];
  if (commandText) lines.push(`<span class="sl-tech-prompt">$</span> ${escapeHtml(commandText)}`);
  if (outputText) lines.push(escapeHtml(outputText));
  const markup = [
    `<figure class="sl-tech-terminal"${nameAttr(name)}${revealAttr(optionalReveal(revealStop, "terminalBlock.reveal"))}>`,
    `<span class="sl-tech-titlebar" aria-hidden="true"><i class="sl-tech-dot"></i><i class="sl-tech-dot"></i><i class="sl-tech-dot"></i></span>`,
    captionText ? `<figcaption class="sl-tech-caption">${escapeHtml(captionText)}</figcaption>` : "",
    `<pre class="sl-tech-pre sl-tech-terminal-pre">${lines.join("\n")}</pre>`,
    `</figure>`,
  ].join("");
  return markup;
}

const MEMORY_CELL_STATES = new Set(["free", "used", "target", "overflow", "header"]);

/**
 * Gridded memory layout: a CSS grid of labeled cells with semantic states
 * (free, used, target, overflow, header). `columns` sets the column count;
 * `span` (1-8) widens a cell across columns.
 */
export function memoryGrid({ columns = 8, cells = [], caption = "", reveal: revealStop = "", name = "" } = {}) {
  requirePlainObject(arguments[0] ?? {}, "memoryGrid");
  if (!Number.isInteger(columns) || columns < 1 || columns > 32) {
    throw new TypeError(`[simple-light] memoryGrid.columns must be an integer in [1, 32], got ${JSON.stringify(columns)}`);
  }
  if (!Array.isArray(cells)) {
    throw new TypeError("[simple-light] memoryGrid.cells must be an array");
  }
  const captionText = optionalText(caption, "memoryGrid.caption");
  const cellMarkup = cells
    .map((cell, index) => {
      if (cell === null || typeof cell !== "object" || Array.isArray(cell)) {
        throw new TypeError(`[simple-light] memoryGrid.cells[${index}] must be an object`);
      }
      const state = cell.state ?? "free";
      if (!MEMORY_CELL_STATES.has(state)) {
        throw new TypeError(
          `[simple-light] memoryGrid.cells[${index}].state must be one of ${[...MEMORY_CELL_STATES].join(", ")}, got ${JSON.stringify(state)}`,
        );
      }
      const span = cell.span ?? 1;
      if (!Number.isInteger(span) || span < 1 || span > 8) {
        throw new TypeError(`[simple-light] memoryGrid.cells[${index}].span must be an integer in [1, 8], got ${JSON.stringify(span)}`);
      }
      const classes = ["sl-tech-mem-cell", `sl-mem-${state}`, span > 1 ? `sl-mem-span-${span}` : ""]
        .filter(Boolean)
        .join(" ");
      const label = optionalText(cell.label, `memoryGrid.cells[${index}].label`);
      return `<div class="${classes}">${escapeHtml(label)}</div>`;
    })
    .join("");
  const markup = [
    `<figure class="sl-tech-memgrid"${nameAttr(name)}${revealAttr(optionalReveal(revealStop, "memoryGrid.reveal"))}>`,
    `<div class="sl-tech-mem-grid" style="--sl-mem-cols: ${columns}">${cellMarkup}</div>`,
    captionText ? `<figcaption class="sl-tech-caption">${escapeHtml(captionText)}</figcaption>` : "",
    `</figure>`,
  ].join("");
  return markup;
}

const ARROW_DIRECTIONS = new Set(["up", "down", "left", "right"]);
const ARROW_TONES = new Set(["ink", "accent", "danger"]);

/**
 * Annotation arrow: a CSS-drawn line + head pointing in one direction with
 * an optional label. `lengthPx` maps onto a theme custom property — this is
 * a primitive parameter, not an agent-written inline style.
 */
export function arrow({ direction = "right", lengthPx = 48, label = "", tone = "ink", reveal: revealStop = "" } = {}) {
  requirePlainObject(arguments[0] ?? {}, "arrow");
  if (!ARROW_DIRECTIONS.has(direction)) {
    throw new TypeError(`[simple-light] arrow.direction must be one of ${[...ARROW_DIRECTIONS].join(", ")}, got ${JSON.stringify(direction)}`);
  }
  if (!ARROW_TONES.has(tone)) {
    throw new TypeError(`[simple-light] arrow.tone must be one of ${[...ARROW_TONES].join(", ")}, got ${JSON.stringify(tone)}`);
  }
  if (!Number.isFinite(lengthPx) || lengthPx < 12 || lengthPx > 480) {
    throw new TypeError(`[simple-light] arrow.lengthPx must be a number in [12, 480], got ${JSON.stringify(lengthPx)}`);
  }
  const labelText = optionalText(label, "arrow.label");
  const classes = ["sl-tech-arrow", `sl-arrow-${direction}`, `sl-arrow-tone-${tone}`];
  const style = ` style="--sl-arrow-length: ${Math.round(lengthPx)}px"`;
  return [
    `<span class="${classes.join(" ")}"${style}${revealAttr(optionalReveal(revealStop, "arrow.reveal"))}>`,
    `<span class="sl-arrow-line" aria-hidden="true"></span>`,
    `<span class="sl-arrow-head" aria-hidden="true"></span>`,
    labelText ? `<span class="sl-arrow-label">${escapeHtml(labelText)}</span>` : "",
    `</span>`,
  ].join("");
}

/**
 * Numbered marker badge for step annotations.
 */
export function markerBadge({ number, tone = "ink", reveal: revealStop = "" } = {}) {
  requirePlainObject(arguments[0] ?? {}, "markerBadge");
  if (!Number.isInteger(number) || number < 0 || number > 99) {
    throw new TypeError(`[simple-light] markerBadge.number must be an integer in [0, 99], got ${JSON.stringify(number)}`);
  }
  if (!ARROW_TONES.has(tone)) {
    throw new TypeError(`[simple-light] markerBadge.tone must be one of ${[...ARROW_TONES].join(", ")}, got ${JSON.stringify(tone)}`);
  }
  return `<span class="sl-tech-marker sl-marker-tone-${tone}"${revealAttr(optionalReveal(revealStop, "markerBadge.reveal"))}>${number}</span>`;
}

const CALLOUT_TONES = new Set(["warning", "danger", "info"]);

/**
 * Warning callout: an emphasized aside with a tone (warning / danger /
 * info), optional title, and escaped body markup or text.
 */
export function warningCallout({ title = "", body, tone = "warning", reveal: revealStop = "", name = "" } = {}) {
  requirePlainObject(arguments[0] ?? {}, "warningCallout");
  const bodyMarkup = requiredText(body, "warningCallout.body");
  if (!CALLOUT_TONES.has(tone)) {
    throw new TypeError(`[simple-light] warningCallout.tone must be one of ${[...CALLOUT_TONES].join(", ")}, got ${JSON.stringify(tone)}`);
  }
  const titleText = optionalText(title, "warningCallout.title");
  const classes = ["sl-tech-callout", `sl-callout-${tone}`];
  const paragraphs = bodyMarkup.includes("<")
    ? bodyMarkup
    : `<p>${escapeHtml(bodyMarkup)}</p>`;
  return [
    `<aside class="${classes.join(" ")}"${nameAttr(name)}${revealAttr(optionalReveal(revealStop, "warningCallout.reveal"))}>`,
    `<span class="sl-tech-callout-badge" aria-hidden="true">${tone === "danger" ? "!" : "i"}</span>`,
    `<div class="sl-tech-callout-body">`,
    titleText ? `<strong class="sl-tech-callout-title">${escapeHtml(titleText)}</strong>` : "",
    paragraphs,
    `</div>`,
    `</aside>`,
  ].join("");
}

/**
 * Parse one column definition: a plain string label (always visible) or an
 * object `{ label, reveal }` whose optional `reveal` is the column's own
 * data-lattice-reveal stop key (issue 006 per-column reveal).
 */
function compareTableColumn(entry, index) {
  if (typeof entry === "string") return { label: entry, reveal: "" };
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new TypeError(`[simple-light] compareTable.head[${index}] must be a string or a { label, reveal } object`);
  }
  return {
    label: optionalText(entry.label, `compareTable.head[${index}].label`),
    reveal: optionalReveal(entry.reveal, `compareTable.head[${index}].reveal`),
  };
}

/**
 * Compare table: the shared .slide-table presentation plus a compare
 * variant — emphasized first (label) column, zebra rows, and an optional
 * highlighted data column (1-based across the data columns, so
 * highlightColumn: 1 highlights the first data column after the labels).
 *
 * Per-column reveal (issue 006): head entries may be `{ label, reveal }`
 * objects; a keyed column's header and body cells carry that stop's
 * data-lattice-reveal marker and reveal together when the stop fires.
 * Columns without a reveal key are always visible. Reveal keys must be
 * unique within the block. Unkeyed tables render byte-identical to the
 * single-reveal form.
 */
export function compareTable({ head = [], rows = [], caption = "", highlightColumn = 0, compact = false, reveal: revealStop = "", name = "" } = {}) {
  requirePlainObject(arguments[0] ?? {}, "compareTable");
  if (!Array.isArray(head)) throw new TypeError("[simple-light] compareTable.head must be an array");
  if (!Array.isArray(rows)) throw new TypeError("[simple-light] compareTable.rows must be an array");
  rows.forEach((row, index) => {
    if (!Array.isArray(row)) throw new TypeError(`[simple-light] compareTable.rows[${index}] must be an array`);
  });
  const columns = head.map(compareTableColumn);
  const revealOwner = new Map();
  columns.forEach((column, index) => {
    if (!column.reveal) return;
    if (revealOwner.has(column.reveal)) {
      throw new TypeError(
        `[simple-light] compareTable reveal key "${column.reveal}" is duplicated (head[${revealOwner.get(column.reveal)}] and head[${index}]); reveal keys must be unique within the block`,
      );
    }
    revealOwner.set(column.reveal, index);
  });
  if (!Number.isInteger(highlightColumn) || highlightColumn < 0 || highlightColumn >= head.length) {
    throw new TypeError(`[simple-light] compareTable.highlightColumn must be an integer in [0, ${Math.max(0, head.length - 1)}], got ${JSON.stringify(highlightColumn)}`);
  }
  const captionText = optionalText(caption, "compareTable.caption");
  const classes = ["slide-table", "slide-table-compare", compact ? "slide-table-compact" : ""]
    .filter(Boolean)
    .join(" ");
  const cell = (tag, value, columnIndex) => {
    const highlight = highlightColumn > 0 && columnIndex === highlightColumn + 1 ? ` class="${tag === "th" ? "sl-compare-highlight sl-compare-highlight-head" : "sl-compare-highlight"}"` : "";
    const reveal = revealAttr(columns[columnIndex - 1]?.reveal ?? "");
    return `<${tag}${highlight}${reveal}>${escapeHtml(optionalText(value, `compareTable cell`))}</${tag}>`;
  };
  const headMarkup = head.length
    ? `<thead><tr>${columns.map((column, index) => cell("th", column.label, index + 1)).join("")}</tr></thead>`
    : "";
  const bodyMarkup = `<tbody>${rows
    .map((row) => `<tr>${row.map((value, index) => cell("td", value, index + 1)).join("")}</tr>`)
    .join("")}</tbody>`;
  const captionMarkup = captionText ? `<caption>${escapeHtml(captionText)}</caption>` : "";
  return `<table class="${classes}"${nameAttr(name)}${revealAttr(optionalReveal(revealStop, "compareTable.reveal"))}>${captionMarkup}${headMarkup}${bodyMarkup}</table>`;
}

/**
 * The technical block vocabulary of this theme version. Machine-readable so
 * agents can discover the block semantics without reading the source.
 */
export const TECHNICAL_BLOCKS = Object.freeze({
  schema: TECHNICAL_BLOCKS_SCHEMA,
  theme: "simple-light",
  version: TECHNICAL_BLOCKS_VERSION,
  description:
    "Versioned technical content blocks for teaching decks: escaped monospace code, terminal output, gridded memory layouts, annotation markers and arrows, warning callouts, and a compare-table presentation (compareTable columns accept optional per-column reveal keys). Blocks carry presentation only; all copy arrives as escaped parameters.",
  blocks: Object.freeze([
    Object.freeze({ name: "codeBlock", params: ["code", "language", "caption", "reveal", "name"] }),
    Object.freeze({ name: "terminalBlock", params: ["command", "output", "caption", "reveal", "name"] }),
    Object.freeze({ name: "memoryGrid", params: ["columns", "cells", "caption", "reveal", "name"] }),
    Object.freeze({ name: "arrow", params: ["direction", "lengthPx", "label", "tone", "reveal"] }),
    Object.freeze({ name: "markerBadge", params: ["number", "tone", "reveal"] }),
    Object.freeze({ name: "warningCallout", params: ["title", "body", "tone", "reveal", "name"] }),
    Object.freeze({ name: "compareTable", params: ["head", "rows", "caption", "highlightColumn", "compact", "reveal", "name"] }),
    Object.freeze({ name: "reveal", params: ["stop", "content"] }),
  ]),
});
