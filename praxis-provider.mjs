import { createHash } from 'node:crypto';

// This module has no store, filesystem, credential or network access. The host
// supplies narrowly bound reads after resolving the current user's authority.
const metadata = {
  "version": 1,
  "appId": "lattice-slides",
  "name": "Lattice",
  "cards": {
    "supported": true
  },
  "readOperations": [
    "list_decks",
    "read_deck",
    "get_links"
  ],
  "nativeReads": [],
  "dataSources": [
    {
      "id": "managed-decks",
      "label": "Managed decks and revisions",
      "labels": {
        "zh": "受管文稿与版本"
      },
      "kind": "json",
      "location": {
        "env": "SLIDES_BUSINESS_SPACES_FILE",
        "map": "spaces"
      }
    },
    {
      "id": "managed-assets",
      "label": "Managed media and artifacts",
      "labels": {
        "zh": "受管媒体与产物"
      },
      "kind": "directory",
      "location": {
        "env": "SLIDES_BUSINESS_SPACES_FILE",
        "map": "spaces",
        "suffix": ".blobs"
      }
    },
    {
      "id": "native-decks",
      "label": "Native deck sources",
      "labels": {
        "zh": "原生文稿源码"
      },
      "kind": "directory",
      "location": {
        "kind": "working-directory",
        "relative": "decks",
        "serviceRole": "native"
      }
    },
    {
      "id": "native-state",
      "label": "Native authoring state",
      "labels": {
        "zh": "原生创作状态"
      },
      "kind": "directory",
      "location": {
        "kind": "working-directory",
        "relative": ".lattice",
        "serviceRole": "native"
      }
    }
  ],
  "adapterAppId": "slides"
};
export function describe() { return structuredClone(metadata); }
const text = (value, limit = 800) => typeof value === 'string' ? value.slice(0, limit) : '';
const encode = value => encodeURIComponent(String(value));
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const array = (value, key) => { if (!Array.isArray(value?.[key])) throw new Error('INVALID_SOURCE_RESPONSE'); return value[key]; };
const issue = state => state.errors.push({ code: 'SOURCE_UNAVAILABLE' });
function result(state) {
  const items = [...new Map(state.items.map(item => [item.id, item])).values()];
  return { status: state.errors.length ? state.reads ? 'partial' : 'unavailable' : items.length ? 'ready' : 'empty', items, ...(state.errors.length ? { errors: state.errors } : {}) };
}
function card({ spaceId = 'native-view', resourceId, objectId = resourceId, revision, title, preview, href, reason, reasonZh, kind = 'result', evidence = [], dueDate, updatedAt }) {
  if (!resourceId || !title || revision === undefined || revision === null || !String(revision) || typeof href !== 'string' || !href.startsWith('/') || href.startsWith('//')) throw new Error('INVALID_SOURCE_PROJECTION');
  const version = String(revision);
  return { id: `${metadata.appId}:${encode(spaceId)}:${encode(objectId)}`, appId: metadata.appId, spaceId, resourceId, revision: version, kind,
    title: text(title, 240), ...(text(preview) ? { preview: text(preview) } : {}), reason,
    labels: { zh: { reason: reasonZh } },
    source: { name: metadata.name, appId: metadata.appId, spaceId, resourceId, revision: version, href },
    primaryAction: { label: `Open in ${metadata.name}`, labels: { zh: `在 ${metadata.name} 中打开` }, href },
    evidence: [{ label: 'Source record', labels: { zh: '原始记录' }, href, revision: version }, ...evidence],
    ...(dueDate ? { dueDate } : {}), ...(updatedAt ? { updatedAt } : {}) };
}
async function scoped(context, project) {
  const state = { items: [], errors: [], reads: 0 };
  if (!Array.isArray(context?.spaces) || typeof context?.invoke !== 'function') return { status: 'unavailable', items: [], errors: [{ code: 'READ_CONTEXT_UNAVAILABLE' }] };
  const read = async request => {
    try { const value = await context.invoke(request); if (!value || typeof value !== 'object') throw new Error('INVALID_SOURCE_RESPONSE'); state.reads++; return value; }
    catch { issue(state); return null; }
  };
  for (const spaceId of new Set(context.spaces)) {
    if (typeof spaceId !== 'string' || !spaceId) { issue(state); continue; }
    try { await project(spaceId, read, state); } catch { issue(state); }
  }
  return result(state);
}
async function native(context, project) {
  if (typeof context?.readNative !== 'function') return { status: 'unavailable', items: [], errors: [{ code: 'READ_CONTEXT_UNAVAILABLE' }] };
  const state = { items: [], errors: [], reads: 0 };
  try { const value = await context.readNative({ path: metadata.nativeReads[0], resourceId: metadata.nativeResourceId }); if (!value || typeof value !== 'object') throw new Error('INVALID_SOURCE_RESPONSE'); state.reads++; await project(value, state); }
  catch { issue(state); }
  return result(state);
}
export async function getDataInventory(context) {
  if (typeof context?.resolveDataSource !== 'function') return { status: 'unavailable', items: [], errors: [{ code: 'DATA_CONTEXT_UNAVAILABLE' }] };
  const items = [], errors = [];
  for (const source of metadata.dataSources) {
    try {
      const resolved = await context.resolveDataSource(structuredClone(source));
      if (!resolved) throw new Error('UNRESOLVED_SOURCE');
      for (const [index, value] of (Array.isArray(resolved) ? resolved : [resolved]).entries()) {
        const { hostPath, containerPath, volumeName, storageKey, status, description } = value;
        items.push({ id: Array.isArray(resolved) ? `${source.id}:${value.id || index}` : source.id, appId: metadata.appId, label: source.label, labels: source.labels, kind: source.kind, status: status || 'ready',
          ...(hostPath ? { hostPath } : {}), ...(containerPath ? { containerPath } : {}), ...(volumeName ? { volumeName } : {}), ...(storageKey ? { storageKey } : {}), ...(description || source.description ? { description: description || source.description } : {}) });
      }
    } catch { errors.push({ id: source.id, code: 'DATA_SOURCE_UNAVAILABLE' }); items.push({ id: source.id, appId: metadata.appId, label: source.label, labels: source.labels, kind: source.kind, status: 'unavailable' }); }
  }
  return { status: errors.length ? items.some(item => item.status !== 'unavailable') ? 'partial' : 'unavailable' : items.length ? 'ready' : 'empty', items, ...(errors.length ? { errors } : {}) };
}

export async function getCards(context) {
  return scoped(context, async (spaceId, read, state) => {
    const visited = new Set(); let cursor;
    do {
      const listing = await read({ spaceId, operation: 'list_decks', input: { limit: 100, ...(cursor ? { cursor } : {}) } }); if (!listing) return;
      for (const entry of array(listing, 'decks')) {
        const resourceId = entry.resourceId || entry.id;
        const snapshot = await read({ spaceId, operation: 'read_deck', resourceId, input: { includeNotes: false } }); if (!snapshot) continue;
        const document = snapshot.document; if (!document) { issue(state); continue; }
        const href = `/apps/slides/?${new URLSearchParams({ deck: `${spaceId}:${resourceId}`, slidesSpace: spaceId, slidesResource: resourceId, revision: String(snapshot.revision) })}`;
        const first = document.content?.slides?.[0] || document.slides?.[0];
        const preview = document.content?.subtitle || first?.content?.headline || first?.content?.title || first?.title;
        state.items.push(card({ spaceId, resourceId, revision: snapshot.revision, title: document.title || entry.title, preview, href, reason: 'Saved presentation', reasonZh: '已保存的演示文稿', updatedAt: document.updatedAt,
          evidence: [{ label: `${entry.slideCount} slides`, labels: { zh: `${entry.slideCount} 张幻灯片` }, href, revision: String(snapshot.revision) }] }));
      }
      cursor = listing.nextCursor;
      if (cursor && (visited.has(cursor) || visited.size >= 100)) { issue(state); return; }
      visited.add(cursor);
    } while (cursor);
  });
}
