const goodSlideMarkup = (assetUrl) =>
  `<section class="slide-canvas" data-slide-number="1" data-layout="Fixture" data-font="Arial" data-sizes="1">` +
  `<div class="sl-grid"><img src="${assetUrl}" alt="fixture logo"></div>` +
  `<aside class="slide-note-source" hidden><p>Fixture note.</p></aside></section>`;

export const deckRegistry = {
  good: {
    id: "good",
    title: "Good Deck",
    owner: "fixture-owner",
    presenter: "Fixture Presenter",
    description: "Exports cleanly with bundled assets",
    buildSlides: () => [goodSlideMarkup("/decks/good/assets/logo.svg")],
  },
  bad: {
    id: "bad",
    title: "Bad Deck",
    owner: "fixture-owner",
    presenter: "Fixture Presenter",
    description: "References an asset that is not exported",
    buildSlides: () => [goodSlideMarkup("/decks/bad/assets/missing.png")],
  },
};
