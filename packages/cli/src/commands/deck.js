// lattice deck — deck-scoped deterministic judges.
//
// "lattice deck budget" is the mechanical referee for template depth budgets
// (V2.0.31): it loads a deck's content and notes, resolves the library
// template the deck was built from by its slide layouts, measures every page
// against that template's machine-readable `budgets` object, and emits one
// JSON report with per-page pass/violation findings and the exact shortfall
// or excess. Hand-counting a budget table only after authoring is the
// failure mode this retires — the judge runs at authoring time,
// deterministically, and agents consume it by exit code.
//
// Bounds carry both measurement calibers from the genre skill: zh decks are
// judged on character counts (default unit "zh"), en decks on word counts
// (--unit en). A template without a `budgets` object is never blocked: the
// command prints an explanation and exits 0.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "../config/index.js";
import { listTemplates } from "../templates/library/index.js";

const BUDGETS_SCHEMA = "lattice.budgets.v1";

const DECK_USAGE = `Usage: lattice deck budget --deck <deckId> [--unit zh|en] [--help]

Measure a deck's content and notes against its template's machine-readable
depth budgets. The command resolves the library template by the deck's
slide layouts, measures every page (narration floors, per-item text bounds,
screen-text ceilings, term-table row counts, stop alignment), and prints one
JSON report: per-page pass/violation with the exact shortfall or excess.

--unit zh measures zh character counts (default); --unit en measures English
word counts. Both calibers come from the template's budgets object, which is
transcribed from the genre skill's depth-budget table.

Exit codes: 0 every page passes, or the deck's template declares no budgets
(non-genre decks are never blocked); 1 at least one violation; 2
configuration or infrastructure failure (unknown deck, unreadable content,
unsupported budgets schema, unknown budget check).`;

function fail(payload, exitCode = 1) {
  process.stderr.write(`${JSON.stringify({ ok: false, command: "deck", ...payload }, null, 2)}\n`);
  process.exit(exitCode);
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify({ ok: true, command: "deck", ...payload }, null, 2)}\n`);
}

// zh caliber: glyph count without whitespace (the skill's 字数); en caliber:
// whitespace-split word count.
function countUnits(text, unit) {
  const value = String(text ?? "");
  if (unit === "en") return value.split(/\s+/).filter(Boolean).length;
  return value.replace(/\s+/g, "").length;
}

// Sentence count for "1-2 sentences" bounds: zh/en sentence terminators
// (。！？!?) plus a non-empty unterminated remainder. ASCII periods are
// deliberately not terminators so decimals ("9.8") cannot split a sentence.
function countSentences(text) {
  const value = String(text ?? "");
  const terminators = (value.match(/[。！？!?]/g) ?? []).length;
  const remainder = value.replace(/[。！？!?]/g, "").trim();
  return terminators + (remainder.length > 0 ? 1 : 0);
}

function resolveBound(bound, unit) {
  if (bound === undefined || bound === null) return null;
  if (typeof bound === "number") return bound;
  return typeof bound[unit] === "number" ? bound[unit] : null;
}

// Whole-page screen text for the mechanism archetype: title, footnote, step
// texts, and every memoryGrid caption and cell label the page renders.
function mechanismScreenUnits(slide, unit) {
  let total = countUnits(slide.title, unit) + countUnits(slide.footnote, unit);
  for (const step of slide.steps ?? []) {
    total += countUnits(step.text, unit);
    if (step.grid) {
      total += countUnits(step.grid.caption, unit);
      for (const cell of step.grid.cells ?? []) total += countUnits(cell.label, unit);
    }
  }
  return total;
}

// One extractor per budget check. Each returns a list of { label, value }
// measurements; a check whose spec bounds a whole page returns one entry, a
// per-item check returns one entry per item so findings name the offender.
const CHECKS = {
  narrationMin: {
    extract: (slide, ctx) => [{ label: "notes", value: countUnits(ctx.notes[slide.id] ?? "", ctx.unit) }],
  },
  hookSentence: {
    extract: (slide, ctx) => [{ label: "hook", value: countUnits(slide.hook, ctx.unit) }],
  },
  badges: {
    // The genre schema carries one badge slot (badgeNumber + badgeLabel):
    // presence measures as 1, which the 1-2 badge budget judges from below.
    extract: (slide) => [
      {
        label: "badges",
        value: (slide.badgeNumber ?? null) !== null || String(slide.badgeLabel ?? "") !== "" ? 1 : 0,
      },
    ],
  },
  analogyParagraphs: {
    extract: (slide) => [{ label: "analogy[]", value: (slide.analogy ?? []).length }],
  },
  analogyParagraphMax: {
    extract: (slide, ctx) =>
      (slide.analogy ?? []).map((text, index) => ({ label: `analogy[${index}]`, value: countUnits(text, ctx.unit) })),
  },
  termRows: {
    extract: (slide) => [{ label: "terms.rows", value: (slide.terms?.rows ?? []).length }],
  },
  steps: {
    extract: (slide) => [{ label: "steps", value: (slide.steps ?? []).length }],
  },
  stepText: {
    extract: (slide, ctx) =>
      (slide.steps ?? []).map((step, index) => ({ label: `steps[${index}].text`, value: countUnits(step.text, ctx.unit) })),
  },
  screenMax: {
    extract: (slide, ctx) => [{ label: "screen", value: mechanismScreenUnits(slide, ctx.unit) }],
  },
  gridCellsMax: {
    extract: (slide) =>
      (slide.steps ?? [])
        .map((step, index) => ({ index, grid: step.grid }))
        .filter(({ grid }) => grid)
        .map(({ index, grid }) => ({ label: `steps[${index}].grid.cells`, value: (grid.cells ?? []).length })),
  },
  events: {
    extract: (slide) => [{ label: "events", value: (slide.events ?? []).length }],
  },
  eventTerminal: {
    extract: (slide) =>
      (slide.events ?? [])
        .map((event, index) => ({ index, event }))
        .filter(({ event }) => !String(event.command ?? "").trim() && !String(event.output ?? "").trim())
        .map(({ index }) => ({ label: `events[${index}]`, value: 1 })),
  },
  callouts: {
    extract: (slide) => [{ label: "callout", value: slide.callout ? 1 : 0 }],
  },
  points: {
    extract: (slide) => [{ label: "points", value: (slide.points ?? []).length }],
  },
  pointText: {
    extract: (slide, ctx) =>
      (slide.points ?? []).map((point, index) => ({ label: `points[${index}].text`, value: countUnits(point.text, ctx.unit) })),
  },
  rows: {
    extract: (slide) => [{ label: "rows", value: (slide.rows ?? []).length }],
  },
  noteBodySentencesMax: {
    extract: (slide) => [{ label: "note.body", value: slide.note ? countSentences(slide.note.body) : 0 }],
  },
  calloutBodySentencesMax: {
    extract: (slide) => [{ label: "callout.body", value: slide.callout ? countSentences(slide.callout.body) : 0 }],
  },
  items: {
    extract: (slide) => [{ label: "items", value: (slide.items ?? []).length }],
  },
  itemText: {
    extract: (slide, ctx) =>
      (slide.items ?? []).map((item, index) => ({ label: `items[${index}].text`, value: countUnits(item.text, ctx.unit) })),
  },
  stops: {
    extract: (slide) => [{ label: "stops", value: (slide.stops ?? []).length }],
  },
};

// Equality checks (the "one stop per step / event / item" rules): declared
// as `true` in a budgets object, judged as stops count === governing item
// count.
const EQUALITY_CHECKS = {
  stopsPerStep: (slide) => ({
    label: "stops",
    actual: (slide.stops ?? []).length,
    expected: (slide.steps ?? []).length,
  }),
  stopsPerEvent: (slide) => ({
    label: "stops",
    actual: (slide.stops ?? []).length,
    expected: (slide.events ?? []).length,
  }),
  stopsPerItem: (slide) => ({
    label: "stops",
    actual: (slide.stops ?? []).length,
    expected: (slide.items ?? []).length,
  }),
  stopsPerCalloutAndPoints: (slide) => ({
    label: "stops",
    actual: (slide.stops ?? []).length,
    expected: (slide.points ?? []).length + (slide.callout?.stop ? 1 : 0),
  }),
};

// Spec shapes: a number is a plain ceiling; `true` is zero-tolerance; a
// {min,max} object is taken as-is; a bare {zh,en} caliber object takes its
// side from the check key (…Min = floor, …Max = ceiling).
function normalizeSpec(key, spec) {
  if (typeof spec === "number") return { max: spec };
  if (spec === true) return { max: 0 };
  if (spec && (spec.min !== undefined || spec.max !== undefined)) return spec;
  if (key.endsWith("Min")) return { min: spec };
  if (key.endsWith("Max")) return { max: spec };
  return spec ?? {};
}

function evaluateCheck(key, spec, slide, ctx) {
  const equality = EQUALITY_CHECKS[key];
  if (equality) {
    const pair = equality(slide);
    if (pair.actual === pair.expected) {
      return { measured: { [pair.label]: pair.actual }, findings: [] };
    }
    return {
      measured: { [pair.label]: pair.actual },
      findings: [
        {
          check: key,
          target: pair.label,
          expected: pair.expected,
          actual: pair.actual,
          message: `${pair.label}: one stop per item requires ${pair.expected}, found ${pair.actual}`,
        },
      ],
    };
  }
  const check = CHECKS[key];
  if (!check) {
    throw Object.assign(new Error(`unknown budget check "${key}"`), { code: "unknown-budget-check" });
  }
  const normalized = normalizeSpec(key, spec);
  const unitName = ctx.unit === "en" ? "words" : "zh chars";
  const measured = {};
  const findings = [];
  for (const { label, value } of check.extract(slide, ctx)) {
    measured[label] = value;
    const min = resolveBound(normalized.min, ctx.unit);
    if (min !== null && value < min) {
      findings.push({
        check: key,
        target: label,
        side: "min",
        expected: min,
        actual: value,
        underBy: min - value,
        message: `${label}: ${value} ${unitName} is below the floor of ${min} (short by ${min - value})`,
      });
    }
    const max = resolveBound(normalized.max, ctx.unit);
    if (max !== null && value > max) {
      findings.push({
        check: key,
        target: label,
        side: "max",
        expected: max,
        actual: value,
        overBy: value - max,
        message: `${label}: ${value} ${unitName} exceeds the ceiling of ${max} (over by ${value - max})`,
      });
    }
  }
  return { measured, findings };
}

// Resolve the library template a deck was built from, by slide layouts:
// the template whose archetype set matches the most of the deck's layouts
// wins (genre layouts are unique to their template, so a single genre page
// outvotes any theme starter; ties go to the template with the longer slots
// list, then to the lexicographically smaller id).
function resolveTemplate(deckLayouts) {
  const scored = listTemplates()
    .map(({ meta }) => {
      const archetypes = new Set((meta.slots ?? []).map((slot) => slot.template).filter(Boolean));
      const matched = deckLayouts.filter((layout) => archetypes.has(layout)).length;
      return { meta, matched };
    })
    .filter(({ matched }) => matched > 0);
  if (scored.length === 0) return null;
  scored.sort(
    (a, b) =>
      b.matched - a.matched ||
      (b.meta.slots?.length ?? 0) - (a.meta.slots?.length ?? 0) ||
      a.meta.id.localeCompare(b.meta.id),
  );
  return scored[0].meta;
}

async function importDefaultModule(filePath, code, what) {
  try {
    return (await import(pathToFileURL(filePath).href)).default ?? {};
  } catch (error) {
    fail({ error: { code, message: `${what}: ${error.message}` } }, 2);
  }
}

export async function deckCommand({ args, cwd = process.cwd(), rest = [] }) {
  if (args.help) {
    console.log(DECK_USAGE);
    return;
  }
  const subcommand = rest[0];
  if (subcommand !== "budget") {
    fail({ error: { code: "unknown-subcommand", message: "usage: lattice deck budget --deck <deckId> [--unit zh|en] (see --help)" } }, 2);
  }
  const unit = args.unit === undefined ? "zh" : args.unit;
  if (unit !== "zh" && unit !== "en") {
    fail({ error: { code: "invalid-unit", message: `--unit must be "zh" (character counts) or "en" (word counts), got ${JSON.stringify(unit)}` } }, 2);
  }
  if (!args.deck || typeof args.deck !== "string") {
    fail({ error: { code: "missing-argument", message: "--deck <deckId> is required" } }, 2);
  }
  const deckId = args.deck;

  let config;
  try {
    config = await loadConfig(cwd);
  } catch (error) {
    fail({ error: { code: "config-not-found", message: error.message } }, 2);
  }
  const deckDir = path.resolve(cwd, config.decksDir, deckId);
  const manifestPath = path.join(deckDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    fail({ error: { code: "deck-not-found", message: `deck "${deckId}" has no manifest.json under ${config.decksDir}/` } }, 2);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    fail({ error: { code: "invalid-manifest", message: `deck "${deckId}": ${error.message}` } }, 2);
  }

  const contentRel = manifest.entry?.content;
  if (!contentRel || !fs.existsSync(path.join(deckDir, contentRel))) {
    emit({
      action: "budget",
      deck: deckId,
      template: null,
      unit,
      budgets: null,
      pass: true,
      violations: 0,
      pages: [],
      message: "deck has no content entry to measure; nothing to judge",
    });
    return;
  }
  const content = await importDefaultModule(path.join(deckDir, contentRel), "content-import-failed", `deck "${deckId}": ${contentRel}`);
  const slides = Array.isArray(content?.slides) ? content.slides : [];
  const notesRel = manifest.entry?.notes;
  const notes =
    notesRel && fs.existsSync(path.join(deckDir, notesRel))
      ? await importDefaultModule(path.join(deckDir, notesRel), "notes-import-failed", `deck "${deckId}": ${notesRel}`)
      : {};

  const template = resolveTemplate(slides.map((slide) => slide.layout));
  const budgets = template?.budgets ?? null;
  if (!budgets) {
    emit({
      action: "budget",
      deck: deckId,
      template: template?.id ?? null,
      unit,
      budgets: null,
      pass: true,
      violations: 0,
      pages: [],
      message: template
        ? `template "${template.id}" declares no machine-readable budgets; nothing to judge`
        : "no library template matches this deck's layouts; nothing to judge",
    });
    return;
  }
  if (budgets.schema !== BUDGETS_SCHEMA || typeof budgets.pages !== "object" || budgets.pages === null) {
    fail({ error: { code: "unsupported-budgets-schema", message: `template "${template.id}": budgets must be a ${BUDGETS_SCHEMA} object with a pages map` } }, 2);
  }

  const ctx = { notes: notes ?? {}, unit };
  const pages = [];
  let violations = 0;
  for (const slide of slides) {
    const pageBudgets = budgets.pages[slide.layout] ?? budgets.pages[slide.id] ?? null;
    if (!pageBudgets) {
      pages.push({
        slide: slide.id ?? null,
        layout: slide.layout ?? null,
        pass: true,
        note: `no budget for layout ${JSON.stringify(slide.layout ?? null)}`,
        measured: {},
        findings: [],
      });
      continue;
    }
    const measured = {};
    const findings = [];
    for (const [key, spec] of Object.entries(pageBudgets)) {
      let result;
      try {
        result = evaluateCheck(key, spec, slide, ctx);
      } catch (error) {
        if (error.code === "unknown-budget-check") {
          fail({ error: { code: "unknown-budget-check", message: `template "${template.id}" budgets for ${JSON.stringify(slide.layout)}: ${error.message}` } }, 2);
        }
        throw error;
      }
      Object.assign(measured, result.measured);
      findings.push(...result.findings);
    }
    violations += findings.length;
    pages.push({ slide: slide.id ?? null, layout: slide.layout ?? null, pass: findings.length === 0, measured, findings });
  }

  emit({
    action: "budget",
    deck: deckId,
    template: template.id,
    unit,
    budgets: budgets.source ?? null,
    pass: violations === 0,
    violations,
    pages,
  });
  if (violations > 0) {
    process.exitCode = 1;
  }
}
