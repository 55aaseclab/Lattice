import { slideDefinitions } from "./conformance/slides.v2.js";

// The export pipeline consumes buildSlides(); the v2 slide definitions are the
// canonical source, so the registry adapts them without duplicating content.
export const deckRegistry = {
  conformance: {
    id: "conformance",
    title: "Video Conformance Fixture",
    owner: "lattice",
    presenter: "Lattice",
    description: "Deterministic deck for video backend conformance (A26-A29)",
    buildSlides: () =>
      slideDefinitions.map((slide) => (typeof slide.html === "function" ? slide.html() : slide.html)),
  },
};

export const deckList = Object.values(deckRegistry);
