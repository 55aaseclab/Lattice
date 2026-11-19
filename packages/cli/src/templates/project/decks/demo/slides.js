import { simpleLightLayouts } from "@55aaseclab/lattice-runtime/themes/simple-light";
import content from "./content.js";
import notes from "./notes.js";

function withSlideNumber(slideNumber, slideMarkup, note = "") {
  return slideMarkup
    .replace('<section class="slide-canvas ', `<section data-slide-number="${slideNumber}" class="slide-canvas `)
    .replace(
      "</section>",
      `${note ? `<aside class="slide-note-source" hidden>${note}</aside>` : ""}</section>`,
    );
}

function renderImageTextFigure(figureUrl) {
  return `
    <div class="demo-figure">
      <img src="${figureUrl}" alt="Lattice 12x8 grid diagram" />
    </div>
  `;
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
      simpleLightLayouts.titleBody({
        title: byId.grid.title,
        body: `<p>${byId.grid.body}</p>`,
      }),
      note("grid"),
    ),
    withSlideNumber(
      3,
      simpleLightLayouts.titleBodySplit({
        title: byId["image-text"].title,
        left: renderImageTextFigure(byId["image-text"].figure),
        right: `<p>${byId["image-text"].text}</p>`,
      }),
      note("image-text"),
    ),
  ];
}
