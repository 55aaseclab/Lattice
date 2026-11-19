import { t, bindLanguageSwitch } from '../packages/runtime/src/renderer/locale.js';
import { bootDeckPortal } from "@55aaseclab/lattice-runtime/renderer";
import {
  defaultPalette,
  palettes,
} from "@55aaseclab/lattice-runtime/themes/simple-light";
import { deckList, deckRegistry } from "../decks/registry.js";
import { hydrateProjection, installProjectionStyles } from './business/compiler.mjs';

class DeckUnavailable extends Error {}

async function businessDecks() {
  const base = new URL(import.meta.env.PRAXIS_SLIDES_API_BASE || import.meta.env.BASE_URL || './', location.href);
  const api = new URL('./api/slides/decks', base);
  const response = await fetch(api, { credentials: 'same-origin', cache: 'no-store' });
  if (!import.meta.env.PRAXIS_SLIDES_API_BASE && response.status === 404) return { list: [], registry: {}, presentation: {} };
  if (!response.ok) throw new Error('Business slides are unavailable.');
  if (!response.headers.get('content-type')?.includes('application/json')) {
    if (import.meta.env.PRAXIS_SLIDES_API_BASE) throw new Error('Invalid business deck response.');
    return { list: [], registry: {}, presentation: {} };
  }
  const { decks } = await response.json();
  if (!Array.isArray(decks)) throw new Error('Invalid business deck list.');
  const list = decks.map(deck => {
    if (deck.legacy === true) return deck;
    const id = deck.id || `${deck.spaceId}:${deck.resourceId}`;
    const params = new URLSearchParams({ deck: id, slidesSpace: deck.spaceId, slidesResource: deck.resourceId });
    const viewer = `${base.pathname}?${params}`;
    params.set('present', '1');
    return { ...deck, id, entries: { viewer, present: `${base.pathname}?${params}` } };
  });
  const url = new URL(location.href), selectedId = url.searchParams.get('deck');
  const scoped = url.searchParams.has('slidesSpace') || url.searchParams.has('slidesResource');
  const selected = list.find(deck => {
    if (!scoped) return deck.id === selectedId;
    return !deck.legacy && deck.spaceId === url.searchParams.get('slidesSpace')
      && deck.resourceId === url.searchParams.get('slidesResource')
      && (selectedId === null || deck.id === selectedId);
  });
  if (!selected) return { list, registry: {}, presentation: {} };
  if (selected.legacy === true) return { list, registry: {}, presentation: {}, selected };
  const target = new URL(`${api.pathname}/${encodeURIComponent(selected.spaceId)}/${encodeURIComponent(selected.resourceId)}`, api);
  const includeNotes = url.searchParams.get('presenter') === '1';
  target.searchParams.set('includeNotes', String(includeNotes));
  if (url.searchParams.has('revision')) target.searchParams.set('revision', url.searchParams.get('revision'));
  const result = await fetch(target, { credentials: 'same-origin', cache: 'no-store' });
  if ([403, 404].includes(result.status)) throw new DeckUnavailable();
  if (!result.ok) throw new Error('Business deck could not be loaded.');
  const { projection } = await result.json();
  const id = selectedId || selected.id;
  const deck = hydrateProjection(projection, { includeNotes, viewId: id, assetUrl: assetId => `${target.pathname}/assets/${encodeURIComponent(assetId)}` });
  installProjectionStyles(projection);
  url.searchParams.set('deck', id);
  url.searchParams.set('slidesSpace', selected.spaceId);
  url.searchParams.set('slidesResource', selected.resourceId);
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`);
  const presentation = {};
  if (url.searchParams.get('present') === '1') {
    const { createV2DeckDescriptor } = await import('@55aaseclab/lattice-runtime/presentation');
    presentation[id] = createV2DeckDescriptor({ manifest: deck.manifest, slides: deck.slideDefinitions, notes: Object.fromEntries(deck.slideDefinitions.map(slide => [slide.id, slide.notes])) });
  }
  return { list, registry: { [id]: deck }, presentation, selected, paletteId: deck.paletteId };
}

async function boot() {
  const business = await businessDecks();
  const params = new URLSearchParams(location.search);
  const requested = params.get('deck');
  if (!business.selected && (params.has('slidesSpace') || params.has('slidesResource')
      || (requested && !Object.hasOwn(deckRegistry, requested) && (import.meta.env.PRAXIS_SLIDES_API_BASE || params.get('present') !== '1')))) {
    throw new DeckUnavailable();
  }
  const summaries = new Map(deckList.map(deck => [deck.id, deck]));
  for (const deck of business.list) summaries.set(deck.id, { ...summaries.get(deck.id), ...deck });
  // M2 Lattice Presentation: the v2 deck registry is only loaded when a
  // presentation is actually requested, so the v1 deck pages keep their
  // existing module graph untouched.
  let v2Decks = null;
  if (new URLSearchParams(window.location.search).get("present") === "1") {
    // The presentation surface ships its stylesheet separately from
    // presentation-app.js, so the present=1 path must load it alongside the
    // v2 registry before booting (v1 pages keep their module graph untouched).
    await import("@55aaseclab/lattice-runtime/renderer/presentation.css");
    ({ v2DeckRegistry: v2Decks } = await import("./presentation-decks.js"));
  }
  bootDeckPortal({
    deckRegistry: { ...deckRegistry, ...business.registry },
    deckList: [...summaries.values()],
    themes: palettes,
    defaultTheme: business.paletteId ?? defaultPalette,
    v2Decks: { ...v2Decks, ...business.presentation },
    enablePptx: !business.selected || business.selected.legacy === true || business.selected.actions?.includes('export') === true,
    enablePdf: !business.selected || business.selected.legacy === true || business.selected.actions?.includes('export') === true,
  });
}

const container = document.querySelector('#app');
async function openPortal() {
  const message = document.createElement('p');
  message.setAttribute('role', 'status');
  message.textContent = t("Loading slides…", "正在读取文稿…");
  container.replaceChildren(message);
  try {
    await boot();
    bindLanguageSwitch(container.querySelector("[data-deck-language]"));
  } catch (error) {
    const missing = error instanceof DeckUnavailable;
    message.textContent = missing ? t("This deck is missing or inaccessible.", "这份文稿不存在或已无法访问。") : t("Could not load slides.", "暂时无法读取文稿。");
    if (!missing) {
      const retry = document.createElement('button');
      retry.type = 'button';
      retry.textContent = t("Retry", "重新读取");
      retry.addEventListener('click', openPortal);
      container.append(retry);
    }
    if (location.search) {
      const back = document.createElement('a');
      back.href = location.pathname;
      back.textContent = t("Back to decks", "返回文稿列表");
      container.append(back);
    }
  }
}
void openPortal();
