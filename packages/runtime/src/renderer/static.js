import "reveal.js/reveal.css";
import "reveal.js/theme/white.css";
import "katex/dist/katex.min.css";
import renderMathInElement from "katex/contrib/auto-render";
import "./app.css";
import {
  renderSlides,
  createRevealDeck,
  updateCanvasSlideNumbers,
  initInteractiveTrendCharts,
  initInteractiveAnnotations,
} from "./index.js";

export async function bootStaticDeck({ container = "#app" } = {}) {
  const appElement = document.querySelector(container);
  const deckUrl = new URL(window.location.href);
  const gridOverlayParam = deckUrl.searchParams.get("grid") === "1";

  const manifest = await (await fetch("./manifest.json", { cache: "no-cache" })).json();
  const content = await (await fetch(manifest.entry.content, { cache: "no-cache" })).json();

  document.title = content.title || manifest.id;

  const deckDefinition = {
    id: content.id || manifest.id,
    title: content.title || manifest.id,
    description: content.description || "",
    buildSlides: () => content.slides.map((slide) => slide.html),
  };

  renderStaticDeckApp(appElement, deckDefinition, { gridOverlayParam });
}

function renderStaticDeckApp(container, deck, { gridOverlayParam = false } = {}) {
  const slidesMarkup = deck.buildSlides();

  container.innerHTML = `
    <div class="app-shell">
      <header class="app-menu">
        <div class="app-menu-brand">
          <h1 class="app-menu-title">${deck.title}</h1>
          <p class="app-menu-subtitle">${deck.description}</p>
        </div>
        <div class="app-menu-actions">
          <button class="app-menu-button" id="grid-toggle" type="button" aria-pressed="false">
            Grid: Off
          </button>
        </div>
      </header>
      <div class="deck-runtime">
        <div class="reveal">
          <div class="slides" id="slides"></div>
        </div>
        <section class="slide-notes-panel" aria-label="Slide notes">
          <div class="slide-notes-kicker">Notes</div>
          <div class="slide-note-display" id="slide-note-display"></div>
        </section>
      </div>
    </div>
  `;

  const slidesElement = document.querySelector("#slides");
  renderSlides(slidesElement, slidesMarkup);
  updateCanvasSlideNumbers(slidesElement);
  initInteractiveTrendCharts(slidesElement, deck.id);
  initInteractiveAnnotations(slidesElement, deck.id);
  renderMathInElement(slidesElement, {
    delimiters: [
      { left: "$$", right: "$$", display: true },
      { left: "$", right: "$", display: false },
    ],
    throwOnError: false,
  });

  const noteDisplay = document.querySelector("#slide-note-display");
  const gridToggle = document.querySelector("#grid-toggle");

  function setGridOverlay(enabled) {
    document.querySelectorAll(".slide-canvas").forEach((slideEl) => {
      slideEl.classList.toggle("show-grid-overlay", enabled);
    });
    gridToggle.textContent = enabled ? "Grid: On" : "Grid: Off";
    gridToggle.setAttribute("aria-pressed", String(enabled));
  }

  gridToggle.addEventListener("click", () => {
    const enabled = !document.querySelector(".slide-canvas")?.classList.contains("show-grid-overlay");
    setGridOverlay(enabled);
  });

  if (gridOverlayParam) {
    setGridOverlay(true);
  }

  function updateNotes(slide) {
    if (!slide) return;
    const noteSource = slide.querySelector(".slide-note-source");
    noteDisplay.innerHTML = noteSource?.innerHTML?.trim()
      ? noteSource.innerHTML
      : '<p class="slide-note-empty">No notes for this slide.</p>';
  }

  const revealDeck = createRevealDeck();
  revealDeck.initialize();
  revealDeck.on("ready", (event) => {
    updateCanvasSlideNumbers();
    updateNotes(event.currentSlide);
  });
  revealDeck.on("slidechanged", (event) => {
    updateCanvasSlideNumbers();
    updateNotes(event.currentSlide);
  });
}
