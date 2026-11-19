// Scaffold entry for the stage-table overview template.
//
// The layout skeleton is derived from a real (frozen) research-talk deck's
// overview slide: a Theme title-only layout whose body is a grid of stage
// cells, each carrying three text parts (kicker / title / summary). Only the
// structure is inherited — every string here is a generic placeholder, and no
// frozen deck text, data, notes, or assets appear in this template.
//
// Deterministic: the same vars always produce byte-identical files.

import { SLIDE_CANVAS } from "@55aaseclab/lattice-runtime/themes/simple-light";

const SLIDE_IDS = Object.freeze(["intro", "stages"]);

const ORDINALS = Object.freeze([
  "First", "Second", "Third", "Fourth", "Fifth", "Sixth", "Seventh", "Eighth",
]);

export function scaffold({ deckId, title, owner, presenter, description, stages }) {
  const stageCount = clampStageCount(stages);
  const safe = {
    deckId,
    title: title ?? deckId,
    owner: owner ?? "your-handle",
    presenter: presenter ?? "Your Name",
    description: description ?? "Scaffolded from the stage-table template",
  };

  const stagePlaceholders = Array.from({ length: stageCount }, (_, index) => ({
    kicker: `Stage ${String(index + 1).padStart(2, "0")}`,
    title: `${ORDINALS[index] ?? `Number ${index + 1}`} stage`,
    summary: "Describe what happens in this stage.",
  }));

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
    "content.js": contentModule(stagePlaceholders),
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

function clampStageCount(stages) {
  const parsed = Number.parseInt(String(stages ?? "3"), 10);
  if (Number.isNaN(parsed)) return 3;
  return Math.min(8, Math.max(1, parsed));
}

function pascal(deckId) {
  return deckId
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function contentModule(stagePlaceholders) {
  const stagesJson = JSON.stringify(stagePlaceholders, null, 2)
    .split("\n")
    .map((line, index) => (index === 0 ? line : `      ${line}`))
    .join("\n");
  return `export default {
  slides: [
    {
      id: "intro",
      layout: "title-slide",
      title: "Deck Title Goes Here",
      subtitle: "A one-line subtitle for this deck",
      stops: ["open"],
    },
    {
      id: "stages",
      layout: "stage-table",
      title: "Stage Overview",
      stages: ${stagesJson},
      stops: ["static"],
    },
  ],
};
`;
}

function slidesModule(deckId) {
  return `// Derived rendering: buildSlides() maps content.slides through a layout
// renderer table, so slide order, ids, and layouts are owned by content.js.
// Structural edits ("lattice edit --structure add|remove|reorder") never
// touch this file; every rendered slide stays Theme markup with zero
// hand-written CSS.
import { simpleLightLayouts } from "@55aaseclab/lattice-runtime/themes/simple-light";
import content from "./content.js";
import notes from "./notes.js";
import "./styles.css";

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

// One renderer per layout a content slide may declare. The "stage-table"
// layout is this template's derived overview pattern: one Theme title-only
// layout whose body is a grid of three-part stage cells (structure derived
// from a real deck's overview slide; all copy comes from canonical content
// placeholders).
const RENDERERS = {
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
  "stage-table": (slide) =>
    simpleLightLayouts.titleOnly({
      title: slide.title,
      body: renderStageTable(slide.stages ?? []),
      bodyClass: "stage-table-figure",
      footnote: slide.footnote ?? "",
    }),
  blank: () => simpleLightLayouts.blank(),
};

function renderStageTable(stages) {
  const cells = stages
    .map(
      (stage) => \`
        <article class="stage-cell">
          <p class="stage-cell-kicker">\${escapeHtml(stage.kicker)}</p>
          <p class="stage-cell-title">\${escapeHtml(stage.title)}</p>
          <p class="stage-cell-summary">\${escapeHtml(stage.summary)}</p>
        </article>
      \`,
    )
    .join("");

  return \`
    <div class="stage-grid">
      \${cells}
    </div>
  \`;
}

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
  return `export default {
  intro: "Introduce the deck and yourself.",
  stages: "Walk through the stages one cell at a time.",
};
`;
}

function stylesModule() {
  return `/* Deck-local presentation for the stage-table structure.
   Content lock note: classes and styles are presentation-only. */
.stage-table-figure .stage-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 16px;
  align-items: stretch;
}

.stage-cell {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 12px;
  border: 1px solid #dadce0;
  border-radius: 8px;
  background: #ffffff;
}

.stage-cell-kicker {
  font-size: 12px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: #5f6368;
}

.stage-cell-title {
  font-size: 16px;
  font-weight: 600;
  color: #202124;
}

.stage-cell-summary {
  font-size: 13px;
  color: #3c4043;
}
`;
}
