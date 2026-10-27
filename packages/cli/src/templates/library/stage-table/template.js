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
    "slides.js": slidesModule(),
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
      title: "Deck Title Goes Here",
      subtitle: "A one-line subtitle for this deck",
    },
    {
      id: "stages",
      title: "Stage Overview",
      stages: ${stagesJson},
    },
  ],
};
`;
}

function slidesModule() {
  return `import { simpleLightLayouts } from "@55aaseclab/lattice-runtime/themes/simple-light";
import content from "./content.js";
import notes from "./notes.js";
import "./styles.css";

function withSlideNumber(slideNumber, slideMarkup, note = "") {
  return slideMarkup
    .replace('<section class="slide-canvas ', \`<section data-slide-number="\${slideNumber}" class="slide-canvas \`)
    .replace(
      "</section>",
      \`\${note ? \`<aside class="slide-note-source" hidden>\${note}</aside>\` : ""}</section>\`,
    );
}

// Stage-table skeleton: one Theme title-only layout whose body is a grid of
// three-part stage cells. Structure derived from a real deck's overview
// slide; all copy comes from canonical content placeholders.
function renderStageTable(stages) {
  const cells = stages
    .map(
      (stage) => \`
        <article class="stage-cell">
          <p class="stage-cell-kicker">\${stage.kicker}</p>
          <p class="stage-cell-title">\${stage.title}</p>
          <p class="stage-cell-summary">\${stage.summary}</p>
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

export function buildSlides() {
  const byId = Object.fromEntries(content.slides.map((slide) => [slide.id, slide]));
  const note = (slideId) => notes[slideId] || "";

  return [
    withSlideNumber(
      1,
      simpleLightLayouts.titleSlide({
        title: byId.intro.title,
        subtitle: byId.intro.subtitle,
      }),
      note("intro"),
    ),
    withSlideNumber(
      2,
      simpleLightLayouts.titleOnly({
        title: byId.stages.title,
        body: renderStageTable(byId.stages.stages),
        bodyClass: "stage-table-figure",
      }),
      note("stages"),
    ),
  ];
}
`;
}

function slidesV2Module(deckId) {
  return `// Generated by \`lattice template scaffold\` under the lattice.deck.v2
// canonical contract: structural timing only. Slide content stays in
// ./slides.js; this module wraps each buildSlides() output with its stable
// slide id and integer-frame timing. Regenerating is deterministic; edit the
// deck's own sources, not this wrapper.
import { buildSlides } from "./slides.js";

const SLIDE_IDS = [
  "intro",
  "stages",
];

const STATIC_TIMING = Object.freeze({
  durationFrames: 1,
  stops: Object.freeze([{ id: "static", frame: 0, navigation: "jump" }]),
});

const outputs = buildSlides();
if (outputs.length !== SLIDE_IDS.length) {
  throw new Error(
    \`deck "${deckId}": slide count \${outputs.length} does not match SLIDE_IDS length \${SLIDE_IDS.length}; rerun lattice template scaffold\`,
  );
}

export const slideDefinitions = outputs.map((html, index) => ({
  id: SLIDE_IDS[index],
  html,
  durationFrames: STATIC_TIMING.durationFrames,
  stops: STATIC_TIMING.stops.map((stop) => ({ ...stop })),
}));
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
