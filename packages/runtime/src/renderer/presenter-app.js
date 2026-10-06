import { createDeckSync } from "./core.js";
import { SLIDE_CANVAS.width, SLIDE_CANVAS.height } from "../grid/index.js";

export function renderPresenterApp(container, deckDefinition) {
  const slidesMarkup = deckDefinition.buildSlides();
  const parser = new DOMParser();
  const slides = slidesMarkup.map((markup) => {
    const doc = parser.parseFromString(markup, "text/html");
    return doc.body.firstElementChild?.outerHTML ?? "";
  });
  const sync = createDeckSync(deckDefinition.id);

  container.innerHTML = `
    <main class="presenter-runtime">
      <div class="presenter-layout">
        <section class="presenter-panel">
          <div class="presenter-toolbar">
            <div class="presenter-timer" id="presenter-timer">00:00:00</div>
            <button class="presenter-button" id="presenter-pause" type="button">Pause</button>
            <button class="presenter-button" id="presenter-reset" type="button">Reset</button>
          </div>
          <select class="presenter-select" id="presenter-slide-select" aria-label="Quick slide navigation"></select>
          <div class="presenter-panel-kicker">Current Slide</div>
          <div class="presenter-stage presenter-stage-current" id="presenter-current-stage">
            <div class="presenter-stage-inner" id="presenter-current"></div>
          </div>
          <div class="presenter-secondary-grid">
            <button class="presenter-stage-button" id="presenter-prev" type="button">
              <div class="presenter-panel-kicker">Previous</div>
              <div class="presenter-stage presenter-stage-secondary" id="presenter-prev-stage">
                <div class="presenter-stage-inner" id="presenter-prev-slide"></div>
              </div>
            </button>
            <button class="presenter-stage-button" id="presenter-next-button" type="button">
              <div class="presenter-panel-kicker">Next</div>
              <div class="presenter-stage presenter-stage-secondary" id="presenter-next-stage">
                <div class="presenter-stage-inner" id="presenter-next"></div>
              </div>
            </button>
          </div>
        </section>
        <section class="presenter-panel">
          <div class="presenter-notes-header">
            <div class="presenter-panel-kicker">Speaker Notes</div>
            <div class="presenter-font-controls">
              <button class="presenter-button presenter-font-button" id="presenter-font-minus" type="button">-</button>
              <button class="presenter-button presenter-font-button" id="presenter-font-plus" type="button">+</button>
            </div>
          </div>
          <div class="presenter-status" id="presenter-status"></div>
          <div class="presenter-notes" id="presenter-notes"></div>
        </section>
      </div>
    </main>
  `;

  const currentElement = document.querySelector("#presenter-current");
  const prevElement = document.querySelector("#presenter-prev-slide");
  const nextElement = document.querySelector("#presenter-next");
  const currentStage = document.querySelector("#presenter-current-stage");
  const prevStage = document.querySelector("#presenter-prev-stage");
  const nextStage = document.querySelector("#presenter-next-stage");
  const notesElement = document.querySelector("#presenter-notes");
  const statusElement = document.querySelector("#presenter-status");
  const timerElement = document.querySelector("#presenter-timer");
  const pauseButton = document.querySelector("#presenter-pause");
  const resetButton = document.querySelector("#presenter-reset");
  const slideSelect = document.querySelector("#presenter-slide-select");
  const fontMinusButton = document.querySelector("#presenter-font-minus");
  const fontPlusButton = document.querySelector("#presenter-font-plus");

  let currentIndex = 0;
  let noteFontSize = 18;
  let timerStart = Date.now();
  let pausedElapsed = 0;
  let paused = false;

  function extractNote(markup) {
    if (!markup) return "";
    const doc = parser.parseFromString(markup, "text/html");
    return doc.querySelector(".slide-note-source")?.innerHTML?.trim() ?? "";
  }

  function renderScaledSlide(stageElement, innerElement, markup, { centerHorizontally = false } = {}) {
    innerElement.innerHTML = markup || "";
    const slideCanvas = innerElement.querySelector(".slide-canvas");
    if (!slideCanvas) return;
    const scale = Math.min(
      stageElement.clientWidth / SLIDE_CANVAS.width,
      stageElement.clientHeight / SLIDE_CANVAS.height,
    );
    const scaledWidth = SLIDE_CANVAS.width * scale;
    const offsetX = centerHorizontally ? Math.max(0, (stageElement.clientWidth - scaledWidth) / 2) : 0;
    innerElement.style.transform = `scale(${scale})`;
    innerElement.style.width = `${SLIDE_CANVAS.width}px`;
    innerElement.style.height = `${SLIDE_CANVAS.height}px`;
    innerElement.style.left = `${offsetX}px`;
  }

  function extractTitle(markup) {
    if (!markup) return "-";
    const doc = parser.parseFromString(markup, "text/html");
    return doc.querySelector("h1, h2")?.textContent?.trim() || "-";
  }

  function updateTimer() {
    const elapsed = paused ? pausedElapsed : Date.now() - timerStart;
    const totalSeconds = Math.floor(elapsed / 1000);
    const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
    const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    timerElement.textContent = `${hours}:${minutes}:${seconds}`;
  }

  function updatePresenterView() {
    const prevMarkup = slides[currentIndex - 1] || "";
    const currentMarkup = slides[currentIndex] || "";
    const nextMarkup = slides[currentIndex + 1] || "";
    renderScaledSlide(prevStage, prevElement, prevMarkup, { centerHorizontally: true });
    renderScaledSlide(currentStage, currentElement, currentMarkup, { centerHorizontally: true });
    renderScaledSlide(nextStage, nextElement, nextMarkup, { centerHorizontally: true });
    const noteHtml = extractNote(currentMarkup);
    notesElement.innerHTML = noteHtml || '<p class="slide-note-empty">No notes for this slide.</p>';
    notesElement.style.fontSize = `${noteFontSize}px`;
    statusElement.textContent = `Slide ${currentIndex + 1} of ${slides.length}`;
    slideSelect.value = String(currentIndex);
  }

  window.addEventListener("resize", updatePresenterView);

  slideSelect.innerHTML = slides
    .map((markup, index) => `<option value="${index}">Slide ${index + 1} · ${extractTitle(markup)}</option>`)
    .join("");

  slideSelect.addEventListener("change", () => {
    sync.publishCommand({ type: "goto", slideIndex: Number(slideSelect.value) });
  });

  document.querySelector("#presenter-prev").addEventListener("click", () => {
    const targetIndex = Math.max(0, currentIndex - 1);
    sync.publishCommand({ type: "goto", slideIndex: targetIndex });
  });

  document.querySelector("#presenter-next-button").addEventListener("click", () => {
    const targetIndex = Math.min(slides.length - 1, currentIndex + 1);
    sync.publishCommand({ type: "goto", slideIndex: targetIndex });
  });

  pauseButton.addEventListener("click", () => {
    if (paused) {
      timerStart = Date.now() - pausedElapsed;
      paused = false;
      pauseButton.textContent = "Pause";
    } else {
      pausedElapsed = Date.now() - timerStart;
      paused = true;
      pauseButton.textContent = "Resume";
    }
    updateTimer();
  });

  resetButton.addEventListener("click", () => {
    timerStart = Date.now();
    pausedElapsed = 0;
    paused = false;
    pauseButton.textContent = "Pause";
    updateTimer();
  });

  fontMinusButton.addEventListener("click", () => {
    noteFontSize = Math.max(14, noteFontSize - 2);
    updatePresenterView();
  });

  fontPlusButton.addEventListener("click", () => {
    noteFontSize = Math.min(32, noteFontSize + 2);
    updatePresenterView();
  });

  sync.onState((message) => {
    if (typeof message?.slideIndex !== "number") return;
    currentIndex = Math.max(0, Math.min(slides.length - 1, message.slideIndex));
    updatePresenterView();
  });

  const initialState = sync.getState();
  if (typeof initialState?.slideIndex === "number") {
    currentIndex = initialState.slideIndex;
  }
  setInterval(updateTimer, 1000);
  updateTimer();
  updatePresenterView();
}

