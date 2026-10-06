import "reveal.js/reveal.css";
import "reveal.js/theme/white.css";
import "katex/dist/katex.min.css";
import renderMathInElement from "katex/contrib/auto-render";
import "./app.css";
import {
  renderSlides,
  createDeckSync,
  createRevealDeck,
} from "./core.js";
import { initInteractiveTrendCharts, initInteractiveAnnotations } from "./interactive.js";
import { initSlideEditor } from "./editor.js";

export function renderDeckApp(container, deckDefinition) {
  const deckUrl = new URL(window.location.href);
  const editMode = deckUrl.searchParams.get("edit") === "1";
  const gridOverlayParam = deckUrl.searchParams.get("grid") === "1";
  const slidesMarkup = deckDefinition.buildSlides();
  const sync = createDeckSync(deckDefinition.id);
  const editUrl = `/?deck=${deckDefinition.id}&edit=1${gridOverlayParam ? "&grid=1" : ""}`;
  const viewUrl = `/?deck=${deckDefinition.id}${gridOverlayParam ? "&grid=1" : ""}`;
  const gridLinkSuffix = (href) => `${href}${href.includes("?") ? "&" : "?"}grid=1`;

  container.innerHTML = `
    <div class="app-shell">
      <header class="app-menu">
        <div class="app-menu-brand">
          <h1 class="app-menu-title">${deckDefinition.title}</h1>
          <p class="app-menu-subtitle">${deckDefinition.description}</p>
        </div>
        <div class="app-menu-actions">
          <a class="app-menu-link" href="/">All Decks</a>
          <button class="app-menu-button" id="meta-toggle" type="button" aria-expanded="true">
            Hide Meta
          </button>
          <button class="app-menu-button" id="grid-toggle" type="button" aria-pressed="false">
            Grid: Off
          </button>
          <a class="app-menu-link" href="${editMode ? viewUrl : editUrl}">${editMode ? "View" : "Edit"}</a>
          ${editMode ? `
            <button class="app-menu-button" id="editor-add-text" type="button">Add Text</button>
            <button class="app-menu-button" id="editor-export" type="button">Export Edits</button>
            <button class="app-menu-button" id="editor-clear" type="button">Clear Edits</button>
          ` : ""}
          <button class="app-menu-button" id="presenter-toggle" type="button">Presenter</button>
          <button class="app-menu-button" id="present-toggle" type="button">Present</button>
        </div>
      </header>
      <div class="deck-runtime ${editMode ? "is-editing" : ""}">
        <aside class="meta-panel" id="meta-panel" aria-label="Slide metadata">
          <div class="meta-content" id="meta-content">
            <h2>Slide Meta</h2>
            <dl>
            <div>
              <dt>Deck</dt>
              <dd id="meta-deck-title">-</dd>
            </div>
            <div>
              <dt>Summary</dt>
              <dd id="meta-deck-description">-</dd>
            </div>
            <div>
              <dt>Slide</dt>
              <dd id="meta-slide-number">-</dd>
              </div>
              <div>
                <dt>Layout</dt>
                <dd id="meta-layout">-</dd>
              </div>
              <div>
                <dt>Font</dt>
                <dd id="meta-font">-</dd>
              </div>
              <div>
                <dt>Sizes</dt>
                <dd id="meta-sizes">-</dd>
              </div>
            </dl>
          </div>
      </aside>
      <div class="reveal">
        <div class="slides" id="slides"></div>
      </div>
      <section class="slide-notes-panel" aria-label="Slide notes">
        <div class="slide-notes-resize" id="slide-notes-resize" aria-hidden="true"></div>
        <div class="slide-notes-kicker">Notes</div>
        <div class="slide-note-display" id="slide-note-display"></div>
      </section>
      </div>
    </div>
  `;

  const slidesElement = document.querySelector("#slides");
  renderSlides(slidesElement, slidesMarkup);
  initInteractiveTrendCharts(slidesElement, deckDefinition.id);
  initInteractiveAnnotations(slidesElement, deckDefinition.id);
  if (editMode) {
    initSlideEditor(slidesElement, deckDefinition.id);
  }
  renderMathInElement(slidesElement, {
    delimiters: [
      { left: "$$", right: "$$", display: true },
      { left: "$", right: "$", display: false },
    ],
    throwOnError: false,
  });

  function updateCanvasSlideNumbers() {
    const slides = Array.from(document.querySelectorAll(".slides section"));
    slides.forEach((slide) => {
      const pageNumber = slide.querySelector(".slide-page-number");
      if (!pageNumber) return;
      pageNumber.textContent = slide.dataset.slideNumber || "";
    });
  }

  updateCanvasSlideNumbers();

  const metaSlideNumber = document.querySelector("#meta-slide-number");
  const metaLayout = document.querySelector("#meta-layout");
  const metaFont = document.querySelector("#meta-font");
  const metaSizes = document.querySelector("#meta-sizes");
  const metaDeckTitle = document.querySelector("#meta-deck-title");
  const metaDeckDescription = document.querySelector("#meta-deck-description");
  const metaPanel = document.querySelector("#meta-panel");
  const metaToggle = document.querySelector("#meta-toggle");
  const presentToggle = document.querySelector("#present-toggle");
  const presenterToggle = document.querySelector("#presenter-toggle");
  const editorAddText = document.querySelector("#editor-add-text");
  const editorExport = document.querySelector("#editor-export");
  const editorClear = document.querySelector("#editor-clear");
  const deckRuntime = document.querySelector(".deck-runtime");
  const revealElement = document.querySelector(".reveal");
  const noteDisplay = document.querySelector("#slide-note-display");
  const notesResizeHandle = document.querySelector("#slide-notes-resize");

  function updateMeta(slide) {
    if (!slide) return;
    metaDeckTitle.textContent = deckDefinition.title || "-";
    metaDeckDescription.textContent = deckDefinition.description || "-";
    metaSlideNumber.textContent = slide.dataset.slideNumber || "-";
    metaLayout.textContent = slide.dataset.layout || "-";
    metaFont.textContent = slide.dataset.font || "-";
    metaSizes.textContent = slide.dataset.sizes || "-";
  }

  function updateNotes(slide) {
    if (!slide) return;
    const noteSource = slide.querySelector(".slide-note-source");
    noteDisplay.innerHTML = noteSource?.innerHTML?.trim()
      ? noteSource.innerHTML
      : '<p class="slide-note-empty">No notes for this slide.</p>';
  }

  function setMetaCollapsed(collapsed) {
    metaPanel.classList.toggle("is-collapsed", collapsed);
    metaToggle.setAttribute("aria-expanded", String(!collapsed));
    metaToggle.textContent = collapsed ? "Show Meta" : "Hide Meta";
  }

  metaToggle.addEventListener("click", () => {
    setMetaCollapsed(!metaPanel.classList.contains("is-collapsed"));
  });

  const gridToggle = document.querySelector("#grid-toggle");
  const editViewLink = document.querySelector(`a[href="${editMode ? viewUrl : editUrl}"]`);
  const initialGridHref = editMode ? viewUrl : editUrl;

  function setGridOverlay(enabled) {
    document.querySelectorAll(".slide-canvas").forEach((slide) => {
      slide.classList.toggle("show-grid-overlay", enabled);
    });
    gridToggle.textContent = enabled ? "Grid: On" : "Grid: Off";
    gridToggle.setAttribute("aria-pressed", String(enabled));
    if (editViewLink) {
      editViewLink.setAttribute("href", enabled ? gridLinkSuffix(initialGridHref) : initialGridHref);
    }
  }

  gridToggle.addEventListener("click", () => {
    const enabled = !document.querySelector(".slide-canvas")?.classList.contains("show-grid-overlay");
    setGridOverlay(enabled);
  });

  if (gridOverlayParam) {
    setGridOverlay(true);
  }

  async function togglePresentation() {
    if (!document.fullscreenElement) {
      await revealElement.requestFullscreen();
    } else if (document.fullscreenElement === revealElement) {
      await document.exitFullscreen();
    }
  }

  function syncPresentationUi() {
    const presenting = document.fullscreenElement === revealElement;
    deckRuntime.classList.toggle("is-presenting", presenting);
    presentToggle.textContent = presenting ? "Exit Present" : "Present";
  }

  presentToggle.addEventListener("click", () => {
    togglePresentation().catch(() => {});
  });

  presenterToggle.addEventListener("click", () => {
    window.open(`/?deck=${deckDefinition.id}&presenter=1`, "_blank", "noopener");
  });

  if (editMode) {
    editorAddText?.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("slide-editor:add-text"));
    });
    editorExport?.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("slide-editor:export"));
    });
    editorClear?.addEventListener("click", () => {
      window.dispatchEvent(new CustomEvent("slide-editor:clear"));
    });
  }

  let resizeState = null;

  notesResizeHandle.addEventListener("pointerdown", (event) => {
    resizeState = {
      startY: event.clientY,
      startHeight: document.querySelector(".slide-notes-panel").getBoundingClientRect().height,
    };
    notesResizeHandle.setPointerCapture(event.pointerId);
  });

  notesResizeHandle.addEventListener("pointermove", (event) => {
    if (!resizeState) return;
    const nextHeight = Math.max(64, Math.min(window.innerHeight * 0.4, resizeState.startHeight - (event.clientY - resizeState.startY)));
    deckRuntime.style.setProperty("--notes-pane-height", `${nextHeight}px`);
  });

  function clearResizeState() {
    resizeState = null;
  }

  notesResizeHandle.addEventListener("pointerup", clearResizeState);
  notesResizeHandle.addEventListener("pointercancel", clearResizeState);

  document.addEventListener("fullscreenchange", syncPresentationUi);
  syncPresentationUi();

  setMetaCollapsed(true);

  const deck = createRevealDeck({ keyboard: !editMode });

  deck.initialize();
  deck.on("ready", (event) => {
    updateCanvasSlideNumbers();
    updateMeta(event.currentSlide);
    updateNotes(event.currentSlide);
    sync.publishState({
      slideIndex: deck.getIndices().h,
      slideNumber: event.currentSlide?.dataset.slideNumber || "",
    });
  });
  deck.on("slidechanged", (event) => {
    updateCanvasSlideNumbers();
    updateMeta(event.currentSlide);
    updateNotes(event.currentSlide);
    sync.publishState({
      slideIndex: deck.getIndices().h,
      slideNumber: event.currentSlide?.dataset.slideNumber || "",
    });
  });

  sync.onCommand((message) => {
    if (message?.type !== "goto" || typeof message.slideIndex !== "number") return;
    deck.slide(message.slideIndex);
  });
}

