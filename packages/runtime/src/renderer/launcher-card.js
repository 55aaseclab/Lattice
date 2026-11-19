import { t } from './locale.js';
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function safeEntry(value) {
  if (typeof value !== 'string' || !value || /[\u0000-\u0020\\]/.test(value) || value.startsWith('//')) return null;
  if (value.startsWith('/') || value.startsWith('?') || value.startsWith('./')) return value;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? value : null; }
  catch { return null; }
}

export function renderDeckCard(deck, { deckParam = 'deck' } = {}) {
  const content = `<div><h2 class="deck-card-title">${escapeHtml(deck.title)}</h2><p class="deck-card-desc">${escapeHtml(deck.description)}</p></div>`;
  if (!deck.entries || typeof deck.entries !== 'object' || Array.isArray(deck.entries)) return `
    <a class="deck-card" href="/?${escapeHtml(deckParam)}=${encodeURIComponent(deck.id)}">${content}<div class="deck-card-action">${t("View", "查看")}</div></a>`;
  const entries = [['viewer', t("View", "查看")], ['present', t("Present", "演示")], ['workbench', t("Video", "视频")], ['review', t("Review", "审阅")]].map(([key, label]) => ({ key, label, href: safeEntry(deck.entries[key]) })).filter(entry => entry.href);
  const viewer = entries.find(entry => entry.key === 'viewer');
  return `<article class="deck-card" data-deck="${escapeHtml(deck.id)}">${viewer ? `<a class="deck-card-primary" href="${escapeHtml(viewer.href)}">${content}</a>` : content}<div class="deck-card-actions">${entries.map(entry => `<a class="deck-card-action" href="${escapeHtml(entry.href)}">${entry.label}</a>`).join('')}</div></article>`;
}
