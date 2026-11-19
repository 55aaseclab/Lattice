import Reveal from 'reveal.js';
import { SLIDE_CANVAS } from '../grid/index.js';

export { SLIDE_CANVAS };

export function renderSlides(container, slides) {
  container.innerHTML = slides.join('');
}

export function createRevealDeck({
  width = SLIDE_CANVAS.width,
  height = SLIDE_CANVAS.height,
  keyboard = true,
  ...overrides
} = {}) {
  return new Reveal({
    width,
    height,
    margin: 0,
    center: false,
    hash: true,
    slideNumber: false,
    transition: 'none',
    keyboard,
    ...overrides,
  });
}

export function updateCanvasSlideNumbers(root = document) {
  const slides = Array.from(root.querySelectorAll('.slides section'));
  slides.forEach((slide) => {
    const pageNumber = slide.querySelector('.slide-page-number');
    if (!pageNumber) return;
    pageNumber.textContent = slide.dataset.slideNumber || '';
  });
}

/**
 * Stamp the hosting app root with the active deck's stable identity
 * (`data-lattice-deck`). Deck-private stylesheets can scope generic slide
 * rules to their own deck through this hook, so one deck's CSS can never leak
 * into another deck's rendering in the multi-deck portal or in a static
 * export. Returns the attribute value that was set.
 */
export function applyDeckIdentity(container, deckId) {
  if (!container) return null;
  if (deckId == null || deckId === "") {
    delete container.dataset.latticeDeck;
    return null;
  }
  container.dataset.latticeDeck = String(deckId);
  return container.dataset.latticeDeck;
}

export function createDeckSync(deckId) {
  const channelName = `lattice-sync:${deckId}`;
  const storageKey = `lattice-sync-state:${deckId}`;
  const channel = new BroadcastChannel(channelName);

  function publishState(state) {
    const message = { type: 'state', ...state };
    localStorage.setItem(storageKey, JSON.stringify(message));
    channel.postMessage(message);
  }

  function publishCommand(command) {
    channel.postMessage(command);
  }

  function onState(handler) {
    channel.addEventListener('message', (event) => {
      if (event.data?.type === 'state') handler(event.data);
    });
  }

  function onCommand(handler) {
    channel.addEventListener('message', (event) => {
      if (event.data?.type === 'goto') handler(event.data);
    });
  }

  function getState() {
    const raw = localStorage.getItem(storageKey);
    return raw ? JSON.parse(raw) : null;
  }

  return {
    publishState,
    publishCommand,
    onState,
    onCommand,
    getState,
  };
}
