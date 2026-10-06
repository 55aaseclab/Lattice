import "@55aaseclab/lattice-runtime/themes/simple-light/styles.css";
import { buildSlides as buildDemoSlides } from "./demo/slides.js";

export const deckRegistry = {
  demo: {
    id: "demo",
    title: "My First Lattice Deck",
    description: "Generated with Lattice",
    buildSlides: buildDemoSlides,
  },
};

export const deckList = Object.values(deckRegistry);
