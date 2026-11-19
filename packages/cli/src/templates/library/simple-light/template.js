// Scaffold entry for the simple-light starter template.
//
// Deterministic: the same vars always produce byte-identical files. The
// scaffolded deck consumes the shared simple-light Theme through the runtime
// package subpath; no Theme file is read, copied, or modified, and no
// business copy, data, notes, or assets are embedded here.
//
// M9 derived structure: slides.js and slides.v2.js are derived from
// content.slides (the canonical content array). Slide order, ids, layouts,
// and stop ids all live in content.js, so `lattice edit --structure`
// add/remove/reorder propagates through the whole deck without touching the
// derived modules.

import { SLIDE_CANVAS } from "@55aaseclab/lattice-runtime/themes/simple-light";

const SLIDE_IDS = Object.freeze(["intro", "overview", "wrap-up"]);

export function scaffold({ deckId, title, owner, presenter, description }) {
  const safe = {
    deckId,
    title: title ?? deckId,
    owner: owner ?? "your-handle",
    presenter: presenter ?? "Your Name",
    description: description ?? `Scaffolded from the simple-light template`,
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

function contentModule() {
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
      id: "overview",
      layout: "title-body",
      title: "Overview",
      body: "Replace this paragraph with the one idea this slide should carry.",
      stops: ["static"],
    },
    {
      id: "wrap-up",
      layout: "main-point",
      title: "Wrap-Up",
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

// One renderer per layout a content slide may declare. Fields ending in
// "Html" carry pre-composed Theme-primitive markup built in content.js;
// plain fields are escaped here.
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
  return `export default {
  intro: "Introduce the deck and yourself.",
  overview: "Walk through the one idea on this slide.",
  "wrap-up": "Close with the single takeaway.",
};
`;
}
