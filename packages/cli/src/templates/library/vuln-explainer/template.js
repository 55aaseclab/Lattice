// Scaffold entry for the vuln-explainer genre template (M14).
//
// Eight page archetypes for vulnerability-explainer decks — hook, concept,
// mechanism, evidence, impact, score, fix-status, takeaways — distilled from
// the page patterns of the delivered explainer decks and their
// audience-review lessons. Each archetype renders through
// the simple-light Theme's layouts and technical content blocks (codeBlock,
// memoryGrid, compareTable, warningCallout, terminalBlock, markerBadge,
// reveal); this template owns the genre structure only and never duplicates
// a Theme primitive.
//
// The scaffolded content.js carries slot-guidance data: what each page
// must cover and its depth budget, so the production guidance ships with the
// deck itself (the per-prototype spec lives in
// skills/slides-vuln-explainer/SKILL.md).
//
// Zero business content: every string below is a generic genre placeholder —
// no frozen deck text, data, notes, or assets appear in this template.
//
// Deterministic: the same vars always produce byte-identical files.

import { SLIDE_CANVAS } from "@55aaseclab/lattice-runtime/themes/simple-light";

const SLIDE_IDS = Object.freeze([
  "hook",
  "concept",
  "mechanism",
  "evidence",
  "impact",
  "score",
  "fix-status",
  "takeaways",
]);

export function scaffold({ deckId, title, owner, presenter, description }) {
  const safe = {
    deckId,
    title: title ?? deckId,
    owner: owner ?? "your-handle",
    presenter: presenter ?? "Your Name",
    description: description ?? "Scaffolded from the vuln-explainer template",
  };

  const manifest = {
    schema: "lattice.deck.v2",
    id: safe.deckId,
    title: safe.title,
    owner: safe.owner,
    presenter: safe.presenter,
    runtime: "^0.2.0",
    theme: "simple-light",
    canvas: { width: SLIDE_CANVAS.width, height: SLIDE_CANVAS.height },
    fps: 30,
    entry: {
      slides: "./slides.v2.js",
      content: "./content.js",
      notes: "./notes.js",
    },
    publication: { audience: "private" },
    routes: { main: [...SLIDE_IDS] },
  };

  const files = {
    "manifest.json": `${JSON.stringify(manifest, null, 2)}\n`,
    "content.js": contentModule(),
    "slides.js": slidesModule(safe.deckId),
    "slides.v2.js": slidesV2Module(safe.deckId),
    "notes.js": notesModule(),
    "styles.css": stylesModule(),
  };

  const registryEntry = [
    `  "${safe.deckId}": {`,
    `    id: "${safe.deckId}",`,
    `    title: ${JSON.stringify(safe.title)},`,
    `    owner: ${JSON.stringify(safe.owner)},`,
    `    presenter: ${JSON.stringify(safe.presenter)},`,
    `    description: ${JSON.stringify(safe.description)},`,
    `    buildSlides: build${pascal(safe.deckId)}Slides,`,
    `  },`,
  ].join("\n");

  const registryImport = `import { buildSlides as build${pascal(safe.deckId)}Slides } from "./${safe.deckId}/slides.js";`;

  return { files, registryEntry, registryImport };
}

function pascal(deckId) {
  return deckId
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

// The canonical content module. The per-page slot guidance ships inside
// content.js as a root-level `guidance` object keyed by slide id — the
// production spec travels with the deck and sits next to the content it
// governs. It is DATA, not comments, on purpose: "lattice edit --structure"
// refuses any edit whose target region contains comments (the M9 source-map
// contract, assertPlainValueRegion), and structure edits replace the whole
// slides array span. Guidance is a sibling of `slides`, so reorder/remove of
// slides never orphans or trips over it.
function contentModule() {
  return `// Canonical content for this vulnerability-explainer deck.
//
// HOW TO READ THIS FILE
// \`guidance\` below is the per-page production spec: each page's job, its
// must-cover list, and its depth budget. Depth budgets are floors and
// ceilings, not suggestions — an under-filled page reads as "not detailed
// enough" and an over-filled page drowns the causal chain (both were R1
// findings in the M12/M13 deck reviews). The full per-prototype spec lives
// in skills/slides-vuln-explainer/SKILL.md; this file is the per-slot
// reminder of it. Keep \`guidance\` in sync when you add a page.
//
// STRUCTURE DISCIPLINE
// The slides array is pure data — no comments inside it. Structural edits
// ("lattice edit --structure add|remove|reorder") replace this array's
// source span verbatim and reject comment-bearing regions; guidance stays a
// sibling key so those edits always apply cleanly.
//
// STOP DISCIPLINE
// One idea per stop; every enumerated item gets its own stop; stop ids are
// stable slugs shared with the reveal markers the renderer emits. The
// narration (notes.js) walks the stops in the same order — narration
// ordinals ("First… Second…") align one-to-one with the stop sequence,
// each landing at or just before its stop frame.
// NUMERAL DISCIPLINE
// On-screen enumeration numbers are Arabic digits only (1/2/3 — what
// markerBadge renders from its integer parameter). Circled numeral
// characters (①②③, U+2460…, and any other precomposed number glyphs) are
// banned on screen: TTS reads them as stray tokens and the genre review
// rejects them (the M12 rebuild review precedent). Spoken ordinals stay
// written words ("First…", "第一……") in notes.js.
//
// FACT DISCIPLINE
// Every id, score, date, version, and count on these pages must come from a
// verified source, and the page that shows the number carries the source
// (footnote, caption, or callout body). If sources disagree, show both and
// say so on the page — never drop a contradiction.
//
// ANALOGY DISCIPLINE
// Pick one analogy on the concept page, reuse it verbatim deck-wide, and
// say where it stops matching.

export default {
  guidance: {
    hook: {
      job: "Make a stranger care in one breath, and anchor the vulnerability to its verifiable identity.",
      mustCover: [
        "the vulnerability's id (CVE or equivalent) with its source",
        "the severity score with its source; badge label matches the cited advisory byte for byte",
        "who is exposed; why this matters now",
      ],
      budget: "1-2 badges; hook = one sentence (15-40 words); no body paragraphs; narration floor 2-3 spoken sentences (>= 40 words / >= 60 zh characters)",
    },
    concept: {
      job: "Give a newcomer the background the mechanism page assumes, and fix the deck's vocabulary before any technical page uses it.",
      mustCover: [
        "the analogy — named here, reused verbatim deck-wide, with its limit stated",
        "a term table with EVERY term the deck uses later, each in one plain sentence (a term introduced elsewhere without a row here is a review finding)",
      ],
      budget: "2-3 analogy paragraphs (each <= 60 zh characters / <= 45 words); 3-6 term rows; narration floor >= 3 spoken sentences (>= 60 words / >= 90 zh characters)",
    },
    mechanism: {
      job: "The causal chain, revealed step by stop — this is the page the deck exists for.",
      mustCover: [
        "each step's trigger and consequence",
        "WHERE each new fact comes from (a step that introduces a fact without naming its origin is a review finding)",
      ],
      budget: "3-6 steps; each step 1-3 sentences (25-80 zh characters / 15-50 words); at most one memoryGrid per step, <= 16 cells; whole-page screen budget <= 260 zh characters / <= 170 words; one stop per step in causal order (steps[].stop equals slide.stops in order); step numbers on screen are Arabic digits (markerBadge 1..N), never circled numeral characters",
    },
    evidence: {
      job: "Prove the story with artifacts — logs, advisories, or a reproduction run — in chronological order.",
      mustCover: [
        "each event's time anchor and its verifiable source",
        "no invented timestamps, no reconstructed quotes",
      ],
      budget: "2-5 events; each event one terminal block (command or output non-empty) plus a time label; one stop per event in chronological order",
    },
    impact: {
      job: "Consequences for real people, bounded by the evidence.",
      mustCover: [
        "exactly one callout carrying the worst CREDIBLE case — the source must support it; inflation is a review finding",
        "who is affected and how, one concrete sentence per point",
      ],
      budget: "1 callout + 2-4 points; each point 1-2 sentences (20-60 zh characters / 12-40 words); narration floor >= 3 spoken sentences (>= 60 words / >= 90 zh characters); one stop per point; point numbers on screen are Arabic digits (markerBadge 1..N), never circled numeral characters",
    },
    score: {
      job: "Show the severity scoring landscape honestly, including disagreement.",
      mustCover: [
        "one row per source that published a score, with the scale each score uses",
        "if sources disagree, the note callout is REQUIRED — one sentence on who published what and which number this deck uses",
      ],
      budget: "2-4 rows; note body 1-2 sentences; highlightColumn points at the score this deck adopts; every number carries its source in the caption or footnote",
    },
    "fix-status": {
      job: "The patch map — what is fixed where, what is not, and what that gap means.",
      mustCover: [
        "one row per affected branch/version with the EXACT fixed version",
        "if end-of-life versions exist, the EOL callout is REQUIRED on its own stop, states the boundary as the source states it, and gives the three honest options (upgrade, retire, isolate)",
        "the bridge between 'affects all versions' and 'only these branches got fixes'",
      ],
      budget: "2-6 rows; callout body 1-2 sentences; footnote carries the exposure bridge",
    },
    takeaways: {
      job: "Close with actions, not a summary wall.",
      mustCover: [
        "verb-first actions the audience can actually take",
        "each item keyed to its own stop and spoken with its ordinal ('First…', 'Second…') — an enumeration the narration promises but the slide never reveals is a review finding",
      ],
      budget: "3-5 items; each item 1-2 sentences (20-60 zh characters / 12-40 words); one stop per item, revealed in spoken order, each stop at or just before its narration ordinal; item numbers on screen are Arabic digits (markerBadge 1..N), never circled numeral characters",
    },
  },
  slides: [
    {
      id: "hook",
      layout: "hook",
      title: "The Vulnerability In One Line",
      badgeNumber: 1,
      badgeLabel: "CVE-YYYY-NNNNN · CVSS 9.8 Critical (vendor advisory)",
      hook: "One sentence that makes a stranger care: what is at risk, and for whom.",
      footnote: "One line of fine print: who is exposed, with its source.",
      stops: ["open"],
    },
    {
      id: "concept",
      layout: "concept",
      title: "The Idea Behind The Bug",
      analogyStop: "analogy",
      termsStop: "terms",
      analogy: [
        "Paragraph one: name the everyday analogy and walk one round trip through it.",
        "Paragraph two: say exactly where the analogy stops matching the real thing.",
      ],
      terms: {
        caption: "Every term this deck uses, in plain words",
        head: ["Term", "Plain words"],
        rows: [
          ["Term one", "One plain sentence a newcomer can repeat back."],
          ["Term two", "One plain sentence a newcomer can repeat back."],
          ["Term three", "One plain sentence a newcomer can repeat back."],
        ],
      },
      footnote: "",
      stops: ["analogy", "terms"],
    },
    {
      id: "mechanism",
      layout: "mechanism",
      title: "How It Works, Step By Step",
      steps: [
        {
          stop: "setup",
          text: "Step one: the state before anything goes wrong, and why that state is normal.",
          grid: {
            columns: 8,
            caption: "The state before the bug runs",
            cells: [
              { label: "input", state: "used" },
              { label: "guard", state: "free" },
              { label: "target", state: "target", span: 2 },
            ],
          },
        },
        {
          stop: "trigger",
          text: "Step two: the exact input or event that trips the bug, from the cited source.",
        },
        {
          stop: "effect",
          text: "Step three: what the attacker gains once it trips — no stronger a claim than the source supports.",
        },
      ],
      footnote: "",
      stops: ["setup", "trigger", "effect"],
    },
    {
      id: "evidence",
      layout: "evidence",
      title: "What Actually Happened",
      events: [
        {
          stop: "reproduce",
          time: "Day 0",
          command: "./reproduce --target lab-host",
          output: "behavior confirmed under controlled conditions",
          caption: "Controlled reproduction (cite the run or write-up)",
        },
        {
          stop: "disclosure",
          time: "Day 2",
          command: "",
          output: "vendor acknowledges; patch scheduled",
          caption: "Disclosure timeline (cite the advisory)",
        },
      ],
      footnote: "Every event cites its source (log, advisory, or reproduce run).",
      stops: ["reproduce", "disclosure"],
    },
    {
      id: "impact",
      layout: "impact",
      title: "Why It Matters",
      callout: {
        stop: "worst-case",
        title: "Worst credible case",
        body: "The worst outcome the cited source actually supports — stated once, not repeated for drama.",
        tone: "danger",
      },
      points: [
        { stop: "who", text: "Who is exposed, in one concrete sentence." },
        { stop: "how-bad", text: "How bad, with the number and its source." },
      ],
      footnote: "",
      stops: ["worst-case", "who", "how-bad"],
    },
    {
      id: "score",
      layout: "score",
      title: "The Score, And The Argument",
      tableReveal: "table",
      caption: "Severity as published, per source",
      head: ["Source", "Score", "Scale"],
      rows: [
        ["Vendor advisory", "9.8", "CVSS v3.1"],
        ["National database", "7.5", "CVSS v3.1"],
      ],
      highlightColumn: 1,
      note: {
        title: "When sources disagree, say so here",
        body: "One sentence: who published what, and which number this deck uses and why.",
        tone: "info",
      },
      footnote: "Every number carries its source.",
      stops: ["table"],
    },
    {
      id: "fix-status",
      layout: "fix-status",
      title: "Fixed Where, Exposed Where",
      tableReveal: "table",
      caption: "Patch status per affected branch",
      head: ["Branch", "Fixed in", "Status"],
      rows: [
        ["Current", "X.Y.Z", "Supported"],
        ["Previous", "X.Y.Z", "Security-only"],
      ],
      highlightColumn: 0,
      callout: {
        stop: "eol",
        title: "End-of-life versions get no patch",
        body: "State the EOL boundary exactly as the source states it — upgrade, retire, or isolate.",
        tone: "danger",
      },
      footnote: "Bridge the gap between \\"affects all versions\\" and \\"only these branches got fixes\\".",
      stops: ["table", "eol"],
    },
    {
      id: "takeaways",
      layout: "takeaways",
      title: "Three Things To Take Away",
      items: [
        { stop: "first", text: "First: the action, verb-first, with its concrete target." },
        { stop: "second", text: "Second: the action, verb-first, with its concrete target." },
        { stop: "third", text: "Third: the action, verb-first, with its concrete target." },
      ],
      footnote: "",
      stops: ["first", "second", "third"],
    },
  ],
};
`;
}

function slidesModule(deckId) {
  return `// Derived rendering: buildSlides() maps content.slides through a layout
// renderer table, so slide order, ids, and layouts are owned by content.js.
// Structural edits ("lattice edit --structure add|remove|reorder") never
// touch this file. Genre layouts compose the Theme's layouts and technical
// content blocks (simpleLightTechnical) — no hand-written CSS beyond the
// deck-local presentation classes in styles.css.
import {
  simpleLightLayouts,
  simpleLightTechnical,
} from "@55aaseclab/lattice-runtime/themes/simple-light";
import content from "./content.js";
import notes from "./notes.js";
import "./styles.css";

const { compareTable, markerBadge, memoryGrid, reveal, terminalBlock, warningCallout } = simpleLightTechnical;

const DECK_ID = ${JSON.stringify(deckId)};

function withSlideNumber(slideNumber, slideMarkup, note = "") {
  return slideMarkup
    .replace('<section class="slide-canvas ', \`<section data-slide-number="\${slideNumber}" class="slide-canvas \`)
    .replace(
      "</section>",
      \`\${note ? \`<aside class="slide-note-source" hidden>\${note}</aside>\` : ""}</section>\`,
    );
}

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);

const paragraph = (text) => \`<p>\${escapeHtml(text)}</p>\`;

const optionalReveal = (stop, markup) => (stop ? reveal({ stop, content: markup }) : markup);

const calloutMarkup = (callout) =>
  callout
    ? optionalReveal(
        callout.stop,
        warningCallout({
          title: callout.title ?? "",
          body: callout.body ?? "",
          tone: callout.tone ?? "warning",
          name: callout.stop ? \`callout-\${callout.stop}\` : "callout",
        }),
      )
    : "";

// One renderer per layout a content slide may declare. The eight genre
// layouts are this template's derived page archetypes; the plain Theme
// layouts stay available so structural edits can add ordinary pages.
const RENDERERS = {
  // hook: the genre's dedicated opener lockup, not a title-body grid —
  // severity badge row (markerBadge + cited id/score label), then the page's
  // display title, then the one-sentence hook at display scale. The body
  // cell is a centered statement block: the hook budget allows no body
  // paragraphs, so nothing else renders on this page.
  hook: (slide) =>
    simpleLightLayouts.titleOnly({
      title: \`<span class="ve-hook-title">\${slide.title}</span>\`,
      body: [
        \`<div class="ve-hook-badges">\`,
        markerBadge({ number: Number.isInteger(slide.badgeNumber) ? slide.badgeNumber : 1, tone: slide.badgeTone ?? "danger" }),
        \`<span class="ve-hook-label">\${escapeHtml(slide.badgeLabel ?? "")}</span>\`,
        \`</div>\`,
        \`<p class="ve-hook-line">\${escapeHtml(slide.hook ?? "")}</p>\`,
      ].join(""),
      bodyClass: "ve-hook",
      footnote: slide.footnote ?? "",
    }),

  // concept: analogy paragraphs + term compare table.
  concept: (slide) => {
    const analogy = (slide.analogy ?? []).map((text) => \`<p>\${escapeHtml(text)}</p>\`).join("");
    const table = slide.terms
      ? compareTable({
          head: slide.terms.head ?? [],
          rows: slide.terms.rows ?? [],
          caption: slide.terms.caption ?? "",
          compact: true,
        })
      : "";
    return simpleLightLayouts.titleBody({
      title: slide.title,
      body: [
        optionalReveal(slide.analogyStop, \`<div class="ve-concept-analogy">\${analogy}</div>\`),
        optionalReveal(slide.termsStop, table),
      ].join(""),
      bodyClass: "ve-concept",
      footnote: slide.footnote ?? "",
    });
  },

  // mechanism: numbered steps revealed stop by stop, each step optionally
  // carrying a memoryGrid of state cells.
  mechanism: (slide) => {
    const steps = (slide.steps ?? [])
      .map((step, index) => {
        const grid = step.grid
          ? memoryGrid({
              columns: step.grid.columns ?? 8,
              cells: step.grid.cells ?? [],
              caption: step.grid.caption ?? "",
            })
          : "";
        const markup = [
          \`<div class="ve-mech-step">\`,
          markerBadge({ number: index + 1, tone: "ink" }),
          \`<div class="ve-mech-step-text"><p>\${escapeHtml(step.text ?? "")}</p>\${grid}</div>\`,
          \`</div>\`,
        ].join("");
        return optionalReveal(step.stop, markup);
      })
      .join("");
    return simpleLightLayouts.titleBody({
      title: slide.title,
      body: steps,
      bodyClass: "ve-mechanism",
      footnote: slide.footnote ?? "",
    });
  },

  // evidence: chronological event timeline of terminal blocks.
  evidence: (slide) => {
    const events = (slide.events ?? [])
      .map((event) =>
        optionalReveal(
          event.stop,
          [
            \`<div class="ve-evidence-event">\`,
            \`<p class="ve-evidence-time">\${escapeHtml(event.time ?? "")}</p>\`,
            terminalBlock({
              command: event.command ?? "",
              output: event.output ?? "",
              caption: event.caption ?? "",
              name: event.stop ? \`evidence-\${event.stop}\` : "evidence-event",
            }),
            \`</div>\`,
          ].join(""),
        ),
      )
      .join("");
    return simpleLightLayouts.titleBody({
      title: slide.title,
      body: events,
      bodyClass: "ve-evidence",
      footnote: slide.footnote ?? "",
    });
  },

  // impact: one warning callout (worst credible case) + impact points.
  impact: (slide) => {
    const points = (slide.points ?? [])
      .map((point, index) =>
        optionalReveal(
          point.stop,
          \`<div class="ve-impact-point">\${markerBadge({ number: index + 1, tone: "ink" })}<p>\${escapeHtml(point.text ?? "")}</p></div>\`,
        ),
      )
      .join("");
    return simpleLightLayouts.titleBody({
      title: slide.title,
      body: [calloutMarkup(slide.callout), \`<div class="ve-impact-points">\${points}</div>\`].join(""),
      bodyClass: "ve-impact",
      footnote: slide.footnote ?? "",
    });
  },

  // score: per-source severity table + required divergence note.
  score: (slide) => {
    const inner = [
      compareTable({
        head: slide.head ?? [],
        rows: slide.rows ?? [],
        caption: slide.caption ?? "",
        highlightColumn: slide.highlightColumn ?? 0,
      }),
      calloutMarkup(slide.note ?? null),
    ].join("");
    return simpleLightLayouts.titleBody({
      title: slide.title,
      body: optionalReveal(slide.tableReveal, inner),
      bodyClass: "ve-score",
      footnote: slide.footnote ?? "",
    });
  },

  // fix-status: patch matrix + end-of-life callout on its own stop.
  "fix-status": (slide) => {
    const inner = [
      compareTable({
        head: slide.head ?? [],
        rows: slide.rows ?? [],
        caption: slide.caption ?? "",
        highlightColumn: slide.highlightColumn ?? 0,
      }),
      calloutMarkup(slide.callout),
    ].join("");
    return simpleLightLayouts.titleBody({
      title: slide.title,
      body: optionalReveal(slide.tableReveal, inner),
      bodyClass: "ve-fix-status",
      footnote: slide.footnote ?? "",
    });
  },

  // takeaways: numbered closing actions, one stop per item; falls back to
  // the Theme main-point layout when no items are declared.
  takeaways: (slide) => {
    const items = slide.items ?? [];
    if (items.length === 0) {
      return simpleLightLayouts.mainPoint({ title: slide.title, footnote: slide.footnote ?? "" });
    }
    const markup = items
      .map((item, index) =>
        optionalReveal(
          item.stop,
          \`<div class="ve-takeaway">\${markerBadge({ number: index + 1, tone: "ink" })}<p>\${escapeHtml(item.text ?? "")}</p></div>\`,
        ),
      )
      .join("");
    return simpleLightLayouts.titleBody({
      title: slide.title,
      body: markup,
      bodyClass: "ve-takeaways",
      footnote: slide.footnote ?? "",
    });
  },

  "title-slide": (slide) =>
    simpleLightLayouts.titleSlide({
      title: slide.title,
      subtitle: slide.subtitle ?? "",
    }),
  "title-body": (slide) =>
    simpleLightLayouts.titleBody({
      title: slide.title,
      body: slide.bodyHtml ?? paragraph(slide.body ?? ""),
      footnote: slide.footnote ?? "",
    }),
  "title-body-split": (slide) =>
    simpleLightLayouts.titleBodySplit({
      title: slide.title,
      left: slide.leftHtml ?? paragraph(slide.left ?? ""),
      right: slide.rightHtml ?? paragraph(slide.right ?? ""),
      footnote: slide.footnote ?? "",
    }),
  "title-two-columns": (slide) =>
    simpleLightLayouts.titleTwoColumns({
      title: slide.title,
      left: slide.leftHtml ?? paragraph(slide.left ?? ""),
      right: slide.rightHtml ?? paragraph(slide.right ?? ""),
      footnote: slide.footnote ?? "",
    }),
  "one-column": (slide) =>
    simpleLightLayouts.oneColumnText({
      title: slide.title,
      body: slide.bodyHtml ?? paragraph(slide.body ?? ""),
      footnote: slide.footnote ?? "",
    }),
  "main-point": (slide) => simpleLightLayouts.mainPoint({ title: slide.title }),
  "section-header": (slide) => simpleLightLayouts.sectionHeader({ title: slide.title, footnote: slide.footnote ?? "" }),
  blank: () => simpleLightLayouts.blank(),
};

function renderSlide(slide) {
  const render = RENDERERS[slide.layout];
  if (!render) {
    throw new Error(
      \`deck "\${DECK_ID}": slide "\${slide.id}" declares unknown layout \${JSON.stringify(slide.layout ?? null)} (known: \${Object.keys(RENDERERS).join(", ")})\`,
    );
  }
  return render(slide);
}

export function buildSlides() {
  return content.slides.map((slide, index) =>
    withSlideNumber(index + 1, renderSlide(slide), notes[slide.id] || ""),
  );
}
`;
}

function slidesV2Module(deckId) {
  return `// Derived lattice.deck.v2 wrapper: slide order, ids, and stop ids all come
// from content.slides, so structural edits via "lattice edit --structure"
// propagate without touching this file. Stop frames here are integer
// placeholders; the deck's lattice.timeline.v1 assigns the real frames.
import { buildSlides } from "./slides.js";
import content from "./content.js";

const DECK_ID = ${JSON.stringify(deckId)};

const DEFAULT_STOPS = Object.freeze(["static"]);

function stopDefinitions(slide) {
  const ids = Array.isArray(slide.stops) && slide.stops.length > 0 ? slide.stops : [...DEFAULT_STOPS];
  return ids.map((id, frame) => ({ id, frame }));
}

const outputs = buildSlides();
if (outputs.length !== content.slides.length) {
  throw new Error(
    \`deck "\${DECK_ID}": slide count \${outputs.length} does not match content.slides length \${content.slides.length}\`,
  );
}

export const slideDefinitions = outputs.map((html, index) => {
  const slide = content.slides[index];
  if (typeof slide?.id !== "string" || slide.id === "") {
    throw new Error(\`deck "\${DECK_ID}": content.slides[\${index}] must carry a non-empty string id\`);
  }
  const stops = stopDefinitions(slide);
  // Static placeholder timing: every placeholder frame must be a legal
  // integer frame of the slide, so the duration covers all of them
  // (frame 0 .. count-1, strictly increasing). A declared lattice.timeline.v1
  // overrides both the duration and the frames.
  return {
    id: slide.id,
    html,
    durationFrames: Math.max(1, stops.length),
    stops,
  };
});
`;
}

function notesModule() {
  return `// Narration notes: spoken prose, first person, addressed to the audience.
// Register contract (V2.0.19): the TTS engine reads these aloud verbatim —
// never stage directions, no hex dumps, expand abbreviations on first
// mention. Enumeration ordinals in the narration must match the slide's
// stop sequence one-to-one. Depth floors per page are stated in the
// content.js guidance comments and in skills/slides-vuln-explainer.
export default {
  hook: "Open with the hook sentence itself — the same one sentence the slide shows — then name who is exposed and why now.",
  concept: "Tell the analogy in spoken prose, name where it stops matching, then walk the term table row by row.",
  mechanism: "Walk the steps one at a time; say the step number as each stop fires, and say where each new fact comes from.",
  evidence: "Narrate the timeline in order; give each event its date and its source out loud.",
  impact: "State the worst credible case first, then walk who is affected and how bad, with the number and its source.",
  score: "Read the scores with their sources; when sources disagree, say which number this deck uses and why.",
  "fix-status": "Name what is fixed and where, then the end-of-life boundary, then what the exposure gap means.",
  takeaways: "Say First, Second, Third exactly as the stops reveal them; one action per stop.",
};
`;
}

function stylesModule() {
  return `/* Deck-local presentation for the vuln-explainer genre structure.
   Content lock note: classes and styles are presentation-only. The
   technical primitives (code blocks, memory grids, tables, callouts,
   terminals, badges) carry the Theme's own styles under sl-tech-*; these
   ve-* rules only lay out the genre's derived shapes, and every font size
   resolves a Theme token where one exists — the ve-hook display sizes are
   this genre's own scale, defined here and nowhere else. */

/* M14 phase-3 (AI-audience visual loop): the genre body stacks center
   vertically (safe center — falls back to start when a page overflows) so
   early stops of a cumulative reveal do not leave the body card hollow
   below the revealed items, the recurring balance complaint across every
   reviewed deck. */
.ve-concept,
.ve-mechanism,
.ve-evidence,
.ve-impact,
.ve-score,
.ve-fix-status,
.ve-takeaways {
  display: flex;
  flex-direction: column;
  justify-content: safe center;
}

/* M14 phase-3: the genre's itemized message content (steps, impact points,
   takeaways, analogy paragraphs) carries the frame's point — it renders in
   the title ink instead of the muted body gray, which the visual review
   read as "the actual message is visually subordinate". Two-class
   selectors so the rule wins the cascade over the Theme's .ph p. */
.ve-concept .ve-concept-analogy p,
.ve-mechanism .ve-mech-step-text p,
.ve-impact .ve-impact-point p,
.ve-takeaways .ve-takeaway p {
  color: var(--title-color, #000000);
}

/* Hook: the genre opener's dedicated lockup — severity stamp, display
   title, one-sentence hook — centered as one poster block in the body
   region (M14 phase-3: horizontal centering joins the phase-1 vertical
   centering; the left-hugging lockup left the right half hollow). */
.ve-hook-title {
  display: block;
  text-align: center;
  font-weight: 700;
}

.ve-hook {
  display: flex;
  flex-direction: column;
  justify-content: center;
  align-items: center;
  text-align: center;
  gap: 24px;
}

/* M14 phase-3 (visual loop R3): the hook's fine print joins the centered
   poster lockup — the section footnote stays a footnote but centers on this
   page only; the visual review flagged the single left-anchored element on
   an otherwise centered opener as a stranded corner. */
.layout-title-only:has(.ve-hook) .slide-footnote {
  left: 50%;
  transform: translateX(-50%);
  text-align: center;
}

.ve-hook-badges {
  display: flex;
  gap: 14px;
  align-items: center;
  margin: 0;
}

.ve-hook-label {
  font-family: var(--sl-tech-mono-font, monospace);
  font-size: var(--sl-tech-code-font-size, 13px);
  font-weight: 600;
  color: var(--title-color, #000000);
}

.ve-hook-line {
  margin: 0;
  max-width: 30em;
  font-size: 26px;
  line-height: 1.5;
  color: var(--title-color, #000000);
}

.ve-concept-analogy {
  margin-bottom: 14px;
}

.ve-mech-step {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  margin-bottom: 12px;
}

.ve-mech-step-text {
  flex: 1;
  min-width: 0;
}

.ve-mech-step-text figure {
  margin-top: 8px;
}

.ve-evidence-event {
  margin-bottom: 12px;
}

/* Two classes so the label wins the cascade over the Theme's .ph p rule
   (a single-class ve-* declaration loses to .ph p's class+type specificity). */
.ve-evidence .ve-evidence-time {
  font-size: var(--figure-caption-font-size, 13px);
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--body-color, #595959);
  margin-bottom: 4px;
}

.ve-impact-point {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  margin-bottom: 10px;
}

.ve-impact-points {
  margin-top: 12px;
}

.ve-score table,
.ve-fix-status table {
  margin-bottom: 14px;
}

.ve-takeaway {
  display: flex;
  gap: 12px;
  align-items: flex-start;
  margin-bottom: 12px;
}
`;
}
