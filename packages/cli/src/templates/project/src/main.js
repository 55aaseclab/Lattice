import { renderDeckApp, renderPresenterApp } from "@lattice/runtime/renderer";
import { validateLayoutGrids } from "@lattice/runtime/layout";
import { deckList, deckRegistry } from "../decks/registry.js";

const appElement = document.querySelector("#app");
const url = new URL(window.location.href);
const selectedDeckId = url.searchParams.get("deck");
const selectedDeck = selectedDeckId ? deckRegistry[selectedDeckId] : null;
const presenterMode = url.searchParams.get("presenter") === "1";

const gridValidation = validateLayoutGrids();
if (!gridValidation.ok) {
  console.warn("[slides] layout grid validation found issues:", gridValidation.errors);
}

if (!selectedDeck) {
  renderLauncher(appElement);
} else if (presenterMode) {
  renderPresenterApp(appElement, selectedDeck);
} else {
  renderDeckApp(appElement, selectedDeck);
}

function renderLauncher(container) {
  const cards = deckList
    .map(
      (deck) => `
        <a class="deck-card" href="/?deck=${deck.id}">
          <div class="deck-card-kicker">Slide Deck</div>
          <div>
            <h2 class="deck-card-title">${deck.title}</h2>
            <p class="deck-card-desc">${deck.description}</p>
          </div>
          <div class="deck-card-action">Open deck</div>
        </a>
      `,
    )
    .join("");

  container.innerHTML = `
    <div class="app-shell">
      <header class="app-menu">
        <div class="app-menu-brand">
          <h1 class="app-menu-title">Slides Collection</h1>
          <p class="app-menu-subtitle">Launcher</p>
        </div>
      </header>
      <main class="deck-launcher">
        <div class="deck-launcher-inner">
          <div class="deck-launcher-grid">
            ${cards}
          </div>
        </div>
      </main>
    </div>
  `;
}
