const businessError=(status,code)=>Object.assign(new Error(code),{status,code});
const prefix = '/api/business/slides/web';
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/;
const legacyIdentifier = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/;
const chunkSize = 1024 * 1024;
const maximumArtifactBytes = 128 * 1024 * 1024;

function byteRange(value, total) {
  if (!value) return { start: 0, end: total - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(value);
  if (!match || !match[1] && !match[2] || total === 0) return null;
  const startValue = match[1] ? Number(match[1]) : null, endValue = match[2] ? Number(match[2]) : null;
  if ([startValue, endValue].some(number => number !== null && !Number.isSafeInteger(number))) return null;
  const start = startValue === null ? Math.max(0, total - endValue) : startValue;
  const end = startValue === null || endValue === null ? total - 1 : Math.min(total - 1, endValue);
  return start < 0 || start >= total || end < start ? null : { start, end, partial: true };
}

async function writeChunk(response, bytes) {
  if (response.destroyed) throw businessError(499, 'CLIENT_DISCONNECTED');
  if (response.write(bytes)) return;
  await new Promise((resolve, reject) => {
    const cleanup = () => { response.off('drain', drained); response.off('close', closed); response.off('error', failed); };
    const drained = () => { cleanup(); resolve(); };
    const closed = () => { cleanup(); reject(businessError(499, 'CLIENT_DISCONNECTED')); };
    const failed = error => { cleanup(); reject(error); };
    response.once('drain', drained); response.once('close', closed); response.once('error', failed);
  });
}

async function serveArtifact({ request, response, ctx, media }) {
  const invoke = input => ctx.invoke({ operation: 'get_artifact', spaceId: media[1], resourceId: media[2], input: { artifactId: media[4], ...input } });
  const { artifact } = await invoke({ mode: 'metadata' });
  if (!artifact || !Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 0 || artifact.byteLength > maximumArtifactBytes || !/^[a-f0-9]{64}$/.test(artifact.sha256 || '') || !/^[a-z][a-z0-9.+-]*\/[a-z0-9.+-]+$/.test(artifact.mimeType || '')) throw businessError(502, 'INVALID_APP_RESPONSE');
  if (media[3] === 'assets' && !['image/png', 'image/jpeg', 'image/webp', 'audio/wav', 'audio/mpeg', 'audio/ogg', 'audio/mp4'].includes(artifact.mimeType)) throw businessError(404, 'NOT_FOUND');
  ctx.requireNative();
  const etag = `"${artifact.sha256}"`;
  const headers = { 'Content-Type': artifact.mimeType, 'Cache-Control': 'private, max-age=0, must-revalidate', ETag: etag, 'X-Content-Type-Options': 'nosniff', Vary: 'Cookie', 'Accept-Ranges': 'bytes' };
  if (media[3] === 'artifacts') {
    const fileName = typeof artifact.fileName === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(artifact.fileName) ? artifact.fileName : media[4];
    headers['Content-Disposition'] = `attachment; filename="${fileName}"`;
    headers['Content-Security-Policy'] = "sandbox; default-src 'none'";
  }
  if (request.headers['if-none-match'] === etag) { response.writeHead(304, headers); response.end(); return true; }
  const range = byteRange(!request.headers['if-range'] || request.headers['if-range'] === etag ? request.headers.range : undefined, artifact.byteLength);
  if (!range) { response.writeHead(416, { ...headers, 'Content-Range': `bytes */${artifact.byteLength}` }); response.end(); return true; }
  if (range.partial) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${artifact.byteLength}`;
  headers['Content-Length'] = range.end - range.start + 1;
  const status = range.partial ? 206 : 200;
  if (request.method === 'HEAD' || artifact.byteLength === 0) { response.writeHead(status, headers); response.end(); return true; }
  try {
    for (let offset = range.start; offset <= range.end;) {
      if (response.destroyed) return true;
      ctx.requireNative();
      const length = Math.min(chunkSize, range.end - offset + 1);
      const result = await invoke({ mode: 'chunk', offset, length });
      const chunk = result.artifact?.chunk;
      if (!chunk || typeof chunk.base64 !== 'string' || chunk.base64.length > Math.ceil(length / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(chunk.base64) || chunk.offset !== offset || chunk.byteLength !== length || chunk.totalByteLength !== artifact.byteLength || chunk.eof !== (offset + length === artifact.byteLength) || result.artifact.sha256 !== artifact.sha256 || result.artifact.mimeType !== artifact.mimeType) throw businessError(502, 'INVALID_APP_RESPONSE');
      const bytes = Buffer.from(chunk.base64, 'base64');
      if (bytes.length !== length || bytes.toString('base64') !== chunk.base64) throw businessError(502, 'INVALID_APP_RESPONSE');
      ctx.requireNative();
      if (!response.headersSent) response.writeHead(status, headers);
      await writeChunk(response, bytes);
      offset += length;
    }
    response.end();
  } catch (error) {
    if (!response.headersSent) throw error;
    response.destroy(error);
  }
  return true;
}

async function defaultLegacySummaryProvider(ctx,spaceId) { return ctx.readNative({path:'/lattice/portal/decks',spaceId,resourceId:'legacy-decks',action:'read'}); }

function legacySummaries(value) {
  if (!Array.isArray(value?.decks) || value.decks.length > 1000) throw businessError(502, 'INVALID_APP_RESPONSE');
  const ids = new Set();
  return value.decks.map(deck => {
    if (!legacyIdentifier.test(deck?.id || '') || ids.has(deck.id) || typeof deck.title !== 'string' || !deck.title.trim() || deck.title.length > 1000 || /[\x00-\x1f\x7f]/.test(deck.title)) throw businessError(502, 'INVALID_APP_RESPONSE');
    ids.add(deck.id);
    const entries = {};
    for (const kind of ['viewer', 'present', 'workbench', 'review']) {
      const entry = deck.entries?.[kind];
      if (typeof entry !== 'string' || entry.length > 2048 || !entry.startsWith('/apps/slides/') || /[\\\x00-\x20\x7f%]/.test(entry)) throw businessError(502, 'INVALID_APP_RESPONSE');
      const url = new URL(entry, 'https://slides.invalid');
      const expectedPath = kind === 'workbench' ? `/apps/slides/workbench/${deck.id}` : kind === 'review' ? `/apps/slides/lattice/portal/deck/${deck.id}/review` : '/apps/slides/';
      const expectedQuery = kind === 'viewer' ? `?deck=${deck.id}` : kind === 'present' ? `?deck=${deck.id}&present=1` : '';
      if (url.origin !== 'https://slides.invalid' || url.pathname !== expectedPath || url.search !== expectedQuery || url.hash || url.username || url.password) throw businessError(502, 'INVALID_APP_RESPONSE');
      entries[kind] = entry;
    }
    return { id: deck.id, title: deck.title, description: '', legacy: true, entries };
  });
}

export function createNativeHttpHandler({ legacySummaryProvider = defaultLegacySummaryProvider } = {}) {
  return async (request, response, ctx) => {
    const url = new URL(request.url, ctx.issuer);
    if (!url.pathname.startsWith(`${prefix}/`)) return false;
    ctx.requireNative();
    if (!['GET', 'HEAD'].includes(request.method)) throw businessError(405, 'METHOD_NOT_ALLOWED');
    if ([...url.searchParams.keys()].some(key => !['includeNotes', 'revision'].includes(key)) || ['includeNotes', 'revision'].some(key => url.searchParams.getAll(key).length > 1) || url.searchParams.has('includeNotes') && !['true', 'false'].includes(url.searchParams.get('includeNotes')) || url.searchParams.has('revision') && !/^[1-9]\d{0,14}$/.test(url.searchParams.get('revision')) || /%|\\/.test(url.pathname)) throw businessError(400, 'INVALID_REQUEST');
    let value;
    if (url.pathname === `${prefix}/decks`) {
      if (url.search) throw businessError(400, 'INVALID_REQUEST');
      const spaces = ctx.catalog().filter(space => space.apps.some(app => app.id === 'slides' && app.actions.includes('read')));
      const decks = [];
      for (const space of spaces) {
        let cursor;
        do {
          const page = await ctx.invoke({ operation: 'list_decks', spaceId: space.id, input: { limit: 100, ...(cursor ? { cursor } : {}) } });
          for (const deck of page.decks || []) {
            const actions = ['read', 'notes', 'render', 'export'].filter(action => {
              try { ctx.authorize({ spaceId: space.id, resourceId: deck.id, action }); return true; } catch { return false; }
            });
            decks.push({ ...deck, id: `${space.id}:${deck.id}`, resourceId: deck.id, spaceId: space.id, actions });
          }
          cursor = page.nextCursor;
        } while (cursor);
      }
      const legacyScope = spaces.find(space => {
        try { ctx.authorize({ spaceId: space.id, resourceId: 'legacy-decks', action: 'read' }, { auditDenied: false }); return true; }
        catch { return false; }
      });
      if (legacyScope) {
        const legacy = legacySummaries(await legacySummaryProvider(ctx,legacyScope.id));
        ctx.authorize({ spaceId: legacyScope.id, resourceId: 'legacy-decks', action: 'read' }, { auditDenied: false });
        decks.push(...legacy);
      }
      value = { decks };
    } else {
      const media = url.pathname.slice(prefix.length).match(/^\/decks\/([^/]+)\/([^/]+)\/(assets|artifacts)\/([^/]+)$/);
      if (media) {
        if (url.search || ![media[1], media[2], media[4]].every(value => identifier.test(value))) throw businessError(400, 'INVALID_REQUEST');
        return serveArtifact({ request, response, ctx, media });
      }
      const match = url.pathname.slice(prefix.length).match(/^\/decks\/([^/]+)\/([^/]+)$/);
      if (!match || !identifier.test(match[1]) || !identifier.test(match[2])) throw businessError(404, 'NOT_FOUND');
      value = await ctx.invoke({ operation: 'read_deck', spaceId: match[1], resourceId: match[2], input: { includeNotes: url.searchParams.get('includeNotes') === 'true', ...(url.searchParams.has('revision') ? { revision: url.searchParams.get('revision') } : {}) } });
      if (value.document?.truncated) {
        const document = value.document, slides = [];
        for (let offset = 0; offset < document.slideOrder.length; offset += 10) {
          const page = await ctx.invoke({ operation: 'read_deck', spaceId: match[1], resourceId: match[2], input: { includeNotes: url.searchParams.get('includeNotes') === 'true', revision: value.revision, slideIds: document.slideOrder.slice(offset, offset + 10) } });
          slides.push(...page.document.slides);
        }
        document.slides = slides;
        delete document.truncated;
      }
    }
    ctx.requireNative();
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Vary: 'Cookie' });
    response.end(request.method === 'HEAD' ? undefined : JSON.stringify(value));
    return true;
  };
}
