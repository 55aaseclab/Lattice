import { t } from './locale.js';
import "reveal.js/reveal.css";
import "reveal.js/theme/white.css";
import "katex/dist/katex.min.css";
import renderMathInElement from "katex/contrib/auto-render";
import "./app.css";
import {
  renderSlides,
  applyDeckIdentity,
  createDeckSync,
  createRevealDeck,
} from "./core.js";
import { initInteractiveTrendCharts, initInteractiveAnnotations } from "./interactive.js";
import { initSlideEditor } from "./editor.js";
import { installDimensionInspection } from "../inspect/dimension-overlay.js";
import { installRenderedInspection } from "../inspect/index.js";

export function renderDeckApp(container, deckDefinition) {
  const deckUrl = new URL(window.location.href);
  const editMode = deckUrl.searchParams.get("edit") === "1";
  const gridOverlayParam = deckUrl.searchParams.get("grid") === "1";
  const slidesMarkup = deckDefinition.buildSlides();
  applyDeckIdentity(container, deckDefinition.id);
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
          <a class="app-menu-link" href="/">${t("All decks", "全部文稿")}</a>
          <button class="app-menu-button" id="meta-toggle" type="button" aria-expanded="true">
            ${t("Hide details", "隐藏信息")}
          </button>
          <button class="app-menu-button" id="grid-toggle" type="button" aria-pressed="false">
            ${t("Grid off", "网格：关")}
          </button>
          <a class="app-menu-link" href="${editMode ? viewUrl : editUrl}">${editMode ? t("View", "查看") : t("Edit", "编辑")}</a>
          ${editMode ? `
            <button class="app-menu-button" id="editor-add-text" type="button">${t("Add text", "添加文字")}</button>
            <button class="app-menu-button" id="editor-export" type="button">${t("Export edits", "导出修改")}</button>
            <button class="app-menu-button" id="editor-clear" type="button">${t("Clear edits", "清除修改")}</button>
          ` : ""}
          <button class="app-menu-button" id="presenter-toggle" type="button">${t("Presenter view", "主讲视图")}</button>
          <button class="app-menu-button" id="present-toggle" type="button">${t("Present", "演示")}</button>
        </div>
      </header>
      <div class="deck-runtime ${editMode ? "is-editing" : ""}">
        <aside class="meta-panel" id="meta-panel" aria-label="${t("Slide details", "页面信息")}">
          <div class="meta-content" id="meta-content">
            <h2>${t("Slide details", "页面信息")}</h2>
            <dl>
            <div>
              <dt>${t("Deck", "文稿")}</dt>
              <dd id="meta-deck-title">-</dd>
            </div>
            <div>
              <dt>${t("Summary", "摘要")}</dt>
              <dd id="meta-deck-description">-</dd>
            </div>
            <div>
              <dt>${t("Presenter", "主讲")}</dt>
              <dd id="meta-deck-presenter">-</dd>
            </div>
            <div>
              <dt>${t("Author", "作者")}</dt>
              <dd id="meta-deck-owner">-</dd>
            </div>
            <div>
              <dt>${t("Slide", "页面")}</dt>
              <dd id="meta-slide-number">-</dd>
              </div>
              <div>
                <dt>${t("Layout", "布局")}</dt>
                <dd id="meta-layout">-</dd>
              </div>
              <div>
                <dt>${t("Font", "字体")}</dt>
                <dd id="meta-font">-</dd>
              </div>
              <div>
                <dt>${t("Font size", "字号")}</dt>
                <dd id="meta-sizes">-</dd>
              </div>
            </dl>
          </div>
      </aside>
      <div class="reveal">
        <div class="slides" id="slides"></div>
      </div>
      <section class="slide-notes-panel" aria-label="${t("Speaker notes", "讲稿")}">
        <div class="slide-notes-resize" id="slide-notes-resize" aria-hidden="true"></div>
        <div class="slide-notes-kicker">${t("Speaker notes", "讲稿")}</div>
        <div class="slide-note-display" id="slide-note-display"></div>
      </section>
      </div>
    </div>
  `;

  const slidesElement = document.querySelector("#slides");
  renderSlides(slidesElement, slidesMarkup);
  installDimensionInspection(slidesElement);
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
  const metaDeckPresenter = document.querySelector("#meta-deck-presenter");
  const metaDeckOwner = document.querySelector("#meta-deck-owner");
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
    metaDeckPresenter.textContent = deckDefinition.presenter || "-";
    metaDeckOwner.textContent = deckDefinition.owner || "-";
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
      : ("<p class=\"slide-note-empty\">" + t("No notes for this slide.", "本页暂无讲稿。") + "</p>");
  }

  function setMetaCollapsed(collapsed) {
    metaPanel.classList.toggle("is-collapsed", collapsed);
    metaToggle.setAttribute("aria-expanded", String(!collapsed));
    metaToggle.textContent = collapsed ? t("Show details", "显示信息") : t("Hide details", "隐藏信息");
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
    gridToggle.textContent = enabled ? t("Grid on", "网格：开") : t("Grid off", "网格：关");
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
    presentToggle.textContent = presenting ? t("End presentation", "结束演示") : t("Present", "演示");
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

  // Headless tooling surface (mirrors window.__latticeInspection): lets the
  // CLI navigate slides programmatically instead of racing Reveal's own
  // hash/writeURL management with external location.hash writes.
  window.__latticeReveal = deck;
  deck.initialize();
  deck.on("ready", async (event) => {
    updateCanvasSlideNumbers();
    updateMeta(event.currentSlide);
    updateNotes(event.currentSlide);
    sync.publishState({
      slideIndex: deck.getIndices().h,
      slideNumber: event.currentSlide?.dataset.slideNumber || "",
    });
    await installRenderedInspection(slidesElement, { deck: deckDefinition.id });
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
