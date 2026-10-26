// Browser-only fixture for presentation-browser.test.js (M2 A14–A19). Under
// plain Node test discovery this file evaluates but does nothing (no
// document). Boots the exact production portal entry (bootPresentation) with
// a real lattice.deck.v2 descriptor built from canonical deck artifacts.
async function main() {
  const { bootPresentation } = await import("@55aaseclab/lattice-runtime/renderer/presentation-app");
  const { createV2DeckDescriptor } = await import("@55aaseclab/lattice-runtime/presentation");
  await import("@55aaseclab/lattice-runtime/renderer/presentation.css");
  const manifest = (await import("./decks/present-demo/manifest.json")).default;
  const { slideDefinitions } = await import("./decks/present-demo/slides.v2.js");
  const { default: notes } = await import("./decks/present-demo/notes.js");

  const descriptor = createV2DeckDescriptor({ manifest, slides: slideDefinitions, notes });
  const params = new URLSearchParams(window.location.search);
  const deckId = params.get("deck");
  window.__latticePresentationFixture = { descriptor, deckId };
  bootPresentation(document.getElementById("app"), {
    deckId,
    v2Decks: { "present-demo": descriptor },
    presenter: params.get("presenter") === "1",
  });
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  await main();
}
