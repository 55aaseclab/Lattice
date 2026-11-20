import { isDatabase, readDocument, writeDocument, hasDocument, transaction as databaseTransaction, beforeCommit } from '../sqlite-document.mjs';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, mkdir, rm, lstat, open, copyFile, chmod } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { inputs, DOCUMENT_WRITES, KEYED_OPERATIONS, SNAPSHOT_OPERATIONS } from './schema.mjs';
import * as Native from '@55aaseclab/lattice-cli/authoring';
import { getNativeMediaCatalog, assertVideoBackendAvailable } from '@55aaseclab/lattice-cli/authoring/media';
import { createUpload, writeUploadChunk, finishUpload } from './uploads.mjs';
import { createContentLockRecord } from '@55aaseclab/lattice-runtime/content-lock';

export const fail = (status, code, message = code, details = {}) => { throw Object.assign(new Error(message), { status, code, ...details }); };
const normalized = value => Array.isArray(value) ? value.map(normalized) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalized(value[key])])) : value;
export const hash = value => createHash('sha256').update(Buffer.isBuffer(value) ? value : typeof value === 'string' ? value : JSON.stringify(normalized(value))).digest('hex');
const clone = value => structuredClone(value);
const empty = () => ({ schemaVersion: 1, cursor: 0, documents: {}, versions: {}, receipts: {}, jobs: {}, assets: {}, uploads: {}, artifacts: {}, events: [] });
const permitted = (claims, id) => claims.resources.includes('*') || claims.resources.includes(id);
const grants = claims => new Set(claims.actionsGranted || [claims.action]);
function requireActions(claims, actions) { const allowed = grants(claims); if (actions.some(action => !allowed.has(action))) fail(403, 'FORBIDDEN'); }
function parse(operation, input) {
  const stack = [[input || {}, 0]]; let count = 0;
  while (stack.length) { const [value, depth] = stack.pop(); if (depth > 20 || ++count > 50000) fail(400, 'INVALID_INPUT'); if (value && typeof value === 'object') for (const [key, item] of Object.entries(value)) { if (['__proto__','prototype','constructor'].includes(key)) fail(400, 'INVALID_INPUT'); stack.push([item, depth + 1]); } }
  const result = inputs[operation]?.safeParse(input || {}); if (!result?.success) fail(400, 'INVALID_INPUT');
  const data = result.data;
  if (operation === 'get_artifact' && Number(Boolean(data.artifactId)) + Number(Boolean(data.assetId)) !== 1) fail(400, 'INVALID_INPUT');
  if (operation === 'get_artifact' && data.mode !== 'chunk' && (data.offset !== undefined || data.length !== undefined)) fail(400, 'INVALID_INPUT');
  return data;
}
function paginate(items, input) { const offset = Number(input.cursor || 0), limit = input.limit || 20; return { items: items.slice(offset, offset + limit), ...(offset + limit < items.length ? { nextCursor: String(offset + limit) } : {}) }; }
const isNative = document => document?.schema === 'lattice.business.native.v1';
const needsVideoBackend = (kind, options) => kind === 'render_video' && ['still', 'render'].includes(options?.operation ?? 'render');
const checkVideoBackend = async (kind, options) => {
  if (needsVideoBackend(kind, options)) await assertVideoBackendAvailable(options?.backend || 'remotion');
};

const slidesOf = document => isNative(document) ? document.content.slides : document.slides || [];
const slideIds = document => slidesOf(document).map(slide => slide.id);
function requireNative(document) { if (!isNative(document)) fail(409, 'UNSUPPORTED_DOCUMENT_MODEL', 'This earlier document remains readable; native authoring requires a native template document.'); }
function viewDocument(document, notes) { const result = clone(document); if (!notes) { delete result.notes; for (const slide of result.slides || []) delete slide.notes; } return result; }
function documentAt(state, request) { const current = Object.hasOwn(state.documents, request.resourceId) && state.documents[request.resourceId]; if (!current) fail(404, 'NOT_FOUND'); if (!['read_deck', 'get_links'].includes(request.operation) || !request.input?.revision) return current; const snapshot = state.versions[request.resourceId]?.find(v => v.revision === request.input.revision); if (!snapshot) fail(404, 'NOT_FOUND'); return snapshot.document; }
async function validateDocument(document) {
  requireNative(document); await Native.validateNative(document);
  const assets = new Set(document.assets.map(asset => asset.id));
  const stack = [document.content];
  while (stack.length) { const value = stack.pop(); if (!value || typeof value !== 'object') continue; if (value.kind === 'image' && !assets.has(value.assetId)) fail(400, 'UNKNOWN_ASSET'); for (const child of Object.values(value)) if (child && typeof child === 'object') stack.push(child); }
}
function assertRevision(document, expected) { if (document.revision !== expected) fail(409, 'REVISION_CONFLICT', 'Read the current revision before retrying', { currentRevision: document.revision }); }
function contentFingerprint(document) { const value = clone(document); for (const field of ['revision', 'updatedAt', 'locked', 'lockFingerprint', 'archived']) delete value[field]; return hash(value); }
const notesFingerprint = document => hash(isNative(document) ? document.notes || {} : document.slides.map(s => [s.id, s.notes]));

export class SlidesStore {
  constructor(file, { spaceId = 'local', blobsDirectory, renderer, authorizationCheck, now = Date.now } = {}) { this.file = file; this.spaceId = spaceId; this.blobs = blobsDirectory || `${file}.blobs`; this.renderer = renderer; this.authorizationCheck = authorizationCheck; this.now = now; this.pending = Promise.resolve(); this.running = new Map(); }
  async read() {
    if (isDatabase(this.file)) { if (!hasDocument(this.file, this.spaceId)) { if(process.env.SLIDES_REQUIRE_DATABASE==='1')fail(503,'DATA_UNAVAILABLE');return empty(); } const state=readDocument(this.file,this.spaceId).value; if(state.schemaVersion!==1||!state.documents||!state.jobs)fail(500,'INVALID_STORE'); return state; }
    try { const info = await lstat(this.file); if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024 * 1024) fail(500, 'INVALID_STORE'); const state = JSON.parse(await readFile(this.file, 'utf8')); if (state.schemaVersion !== 1 || !state.documents || !state.jobs) fail(500, 'INVALID_STORE'); return state; }
    catch (error) { if (error.code === 'ENOENT') return empty(); throw error; }
  }
  async transaction(callback) {
    const run = async () => {
      if (isDatabase(this.file)) return databaseTransaction(this.file, async () => { const state=await this.read(); const result=await callback(state); const raw=JSON.stringify(state);if(Buffer.byteLength(raw)>128*1024*1024)fail(413,'STORE_SIZE_LIMIT');await writeDocument(this.file,this.spaceId,'state',state,undefined,raw);return result; });
      await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
      const lock = `${this.file}.lock`; let acquired = false;
      for (let attempt = 0; attempt < 100 && !acquired; attempt++) {
        try { await mkdir(lock, { mode: 0o700 }); acquired = true; }
        catch (error) { if (error.code !== 'EEXIST') throw error; const info = await lstat(lock); if (this.now() - info.mtimeMs > 60000) await rm(lock, { recursive: true, force: true }); else await delay(25); }
      }
      if (!acquired) fail(503, 'STORE_BUSY');
      try { const state = await this.read(); const result = await callback(state); const serialized = JSON.stringify(state); if (Buffer.byteLength(serialized) > 128 * 1024 * 1024) fail(413, 'STORE_SIZE_LIMIT'); const temp = `${this.file}.${randomUUID()}.tmp`; try { await writeFile(temp, serialized, { mode: 0o600, flag: 'wx' }); await rename(temp, this.file); } finally { await rm(temp, { force: true }); } return result; }
      finally { await rm(lock, { recursive: true, force: true }); }
    };
    const next = this.pending.then(run, run); this.pending = next.catch(() => {}); return next;
  }
  async putBlob(buffer) { await mkdir(this.blobs, { recursive: true, mode: 0o700 }); const digest = hash(buffer), file = join(this.blobs, digest); try { await writeFile(file, buffer, { flag: 'wx', mode: 0o600 }); } catch (error) { if (error.code !== 'EEXIST') throw error; } return digest; }
  async readBlob(digest) { if (!/^[a-f0-9]{64}$/.test(digest)) fail(500, 'INVALID_ARTIFACT'); const buffer = await readFile(join(this.blobs, digest)); if (hash(buffer) !== digest) fail(500, 'ARTIFACT_CORRUPT'); return buffer; }
  async recover() {
    let state = await this.read();
    const unavailable = new Set();
    for (const job of Object.values(state.jobs)) {
      if (['queued', 'running', 'cancelling'].includes(job.status) && needsVideoBackend(job.kind, job.options)) {
        try { await checkVideoBackend(job.kind, job.options); }
        catch { unavailable.add(job.id); }
      }
    }
    if (unavailable.size || Object.values(state.jobs).some(job => ['running', 'cancelling'].includes(job.status))) {
      await this.transaction(state => {
        for (const job of Object.values(state.jobs)) {
          if (unavailable.has(job.id)) { job.status = 'interrupted'; job.error = { code: 'VIDEO_BACKEND_UNAVAILABLE', retryable: true }; }
          else if (['running', 'cancelling'].includes(job.status)) { job.status = 'interrupted'; job.error = { code: 'PROCESS_INTERRUPTED' }; }
        }
      });
      state = await this.read();
    }
    for (const job of Object.values(state.jobs)) if (job.status === 'queued') queueMicrotask(() => this.runJob(job.id).catch(() => {}));
  }

  async capabilities() {
    return { schemaVersion: 2, documentSchema: 'lattice.business.native.v1', native: Native.getNativeCatalog(), media: await getNativeMediaCatalog(), immutable: ['templates','theme implementation','skills','renderer source'], authoring: 'Native template content slots, structure, notes, timeline and palette; no separate element/layout AST.', exportFormats: this.renderer ? ['png','html','pdf','pptx'] : [], assetSources: ['inline','chunked-upload'], uploads: true, assetMimeTypes: ['image/png','image/jpeg','image/webp','audio/wav','audio/mpeg','audio/ogg','audio/mp4'], limits: { maxSlides: 100, maxOperations: 50, maxReadSlides: 100, inlineBytes: 1048576, maxArtifactBytes: 128 * 1024 * 1024, artifactChunkBytes: 1048576 }, nativeTasks: { audio: ['voices','narration','bgm'], video: ['plan','doctor','still','render','subtitles','chapters'], audience: ['pack','review','verify','personas','session_init','session_append','session_check'], validation: ['validate','lint','budget'] }, dependencyAvailability: 'Native commands report missing provisioned engines or providers explicitly at execution; no fabricated results.', legacyDocuments: 'read/history/artifact/archive only; never silently converted or rendered as native.' };
  }

  async invoke(request, claims) {
    request = { ...request, input: parse(request.operation, request.input) };
    if (request.resourceId && !permitted(claims, request.resourceId)) fail(404, 'NOT_FOUND');
    const operation = request.operation;
    if (KEYED_OPERATIONS.has(operation)) {
      if (!request.idempotencyKey) fail(428, 'IDEMPOTENCY_REQUIRED');
      let jobId;
      const result = await this.transaction(async state => {
        if(isDatabase(this.file))beforeCommit(this.file,()=>{if(claims.expiresAt<=this.now())fail(401,'INVALID_ASSERTION');});
        if (claims.expiresAt <= this.now()) fail(401, 'INVALID_ASSERTION');
        const receiptKey = hash([claims.userId, claims.clientId, claims.spaceId, request.idempotencyKey]);
        const requestHash = hash(request), prior = state.receipts[receiptKey];
        if (prior) { if (prior.hash !== requestHash) fail(409, 'IDEMPOTENCY_CONFLICT'); if (prior.result.resourceId && !permitted(claims, prior.result.resourceId)) fail(404, 'NOT_FOUND'); return { ...prior.result, replayed: true }; }
        let response;
        if (DOCUMENT_WRITES.has(operation)) response = await this.edit(state, request, claims);
        else if (operation === 'create_upload') { const document = documentAt(state,request); requireNative(document); assertRevision(document,request.expectedRevision); response = await createUpload(state,request,claims,this); }
        else if (operation === 'write_upload_chunk') response = await writeUploadChunk(state,request,claims,this);
        else if (operation === 'finish_upload') response = await finishUpload(state,request,claims,this);
        else if (SNAPSHOT_OPERATIONS.has(operation)) { response = await this.createJob(state, request, claims); jobId = response.jobId; }
        else if (operation === 'cancel_job') response = this.cancelJob(state, request, claims);
        else if (operation === 'retry_job') { response = await this.retryJob(state, request, claims); jobId = response.jobId; }
        state.receipts[receiptKey] = { hash: requestHash, result: response }; return { ...response, replayed: false };
      });
      if (jobId) queueMicrotask(() => this.runJob(jobId).catch(() => {}));
      return result;
    }
    const state = await this.read();
    if (operation === 'get_capabilities') return this.capabilities();
    if (operation === 'get_media_catalog') return getNativeMediaCatalog();
    if (operation === 'get_template') { const catalog = Native.getNativeCatalog(), template = catalog.templates.find(value => value.id === request.input.templateId); if (!template) fail(404, 'NOT_FOUND'); const scaffold = await Native.scaffoldNative({ templateId: request.input.templateId, deckId: 'template-preview', title: 'Template' }); return { template, guidance: Native.getNativeSlotGuidance(request.input.templateId), defaultContent: scaffold.content, templateIdentity: scaffold.templateIdentity }; }
    if (operation === 'events') { const minCursor = state.events[0]?.cursor || state.cursor + 1; const resetRequired = request.input.after < minCursor - 1 || request.input.after > state.cursor; return { cursor: state.cursor, minCursor, resetRequired, events: resetRequired ? [] : state.events.filter(e => e.cursor > request.input.after && permitted(claims, e.resourceId)) }; }
    if (operation === 'list_decks') { const page = paginate(Object.values(state.documents).filter(d => !d.archived && permitted(claims, d.deckId)).map(d => ({ id: d.deckId, resourceId: d.deckId, revision: d.revision, title: d.title, language: d.language, slideCount: slidesOf(d).length, model: d.schema || 'slides.document.v1', readOnly: !isNative(d), updatedAt: d.updatedAt, locked: d.locked })), request.input); return { ...page, decks: page.items, spaceId: claims.spaceId }; }
    const document = documentAt(state, request);
    if (operation === 'read_deck') {
      if (request.input.includeNotes) requireActions(claims, ['notes']);
      const visible = viewDocument(document, request.input.includeNotes);
      if (request.input.slideIds?.some(id => !slideIds(document).includes(id))) fail(404, 'NOT_FOUND');
      if (!isNative(document)) { if (request.input.slideIds) visible.slides = visible.slides.filter(slide => request.input.slideIds.includes(slide.id)); return { resourceId: document.deckId, revision: document.revision, document: visible, readOnly: true, model: 'slides.document.v1' }; }
      const assetUrl = id => `/apps/slides/api/slides/decks/${encodeURIComponent(claims.spaceId)}/${encodeURIComponent(document.deckId)}/assets/${encodeURIComponent(id)}`;
      const projection = await Native.projectNative(visible, { includeNotes: request.input.includeNotes, assetUrl });
      if (request.input.slideIds) { visible.content.slides = visible.content.slides.filter(slide => request.input.slideIds.includes(slide.id)); if (visible.notes) visible.notes = Object.fromEntries(Object.entries(visible.notes).filter(([id]) => request.input.slideIds.includes(id))); projection.slideDefinitions = projection.slideDefinitions.filter(slide => request.input.slideIds.includes(slide.id)); projection.manifest.routes.main = projection.slideDefinitions.map(slide => slide.id); }
      return { resourceId: document.deckId, revision: document.revision, document: visible, projection };
    }
    if (operation === 'get_slot_guidance') { requireNative(document); const guidance = Native.getNativeSlotGuidance(document.templateId); const slides = document.content.slides.filter(slide => !request.input.slideId || slide.id === request.input.slideId); if (!slides.length) fail(404, 'NOT_FOUND'); return { resourceId: document.deckId, revision: document.revision, ...guidance, slides: slides.map(slide => ({ id: slide.id, layout: slide.layout, fields: guidance.layouts[slide.layout].fields })) }; }
    if (operation === 'list_assets') return { resourceId: document.deckId, revision: document.revision, ...paginate(document.assets.map(a => clone(a)), request.input) };
    if (operation === 'list_revisions') return { resourceId: document.deckId, ...paginate((state.versions[document.deckId] || []).slice().reverse().map(v => ({ revision: v.revision, createdAt: v.createdAt, operation: v.operation, slideCount: slidesOf(v.document).length, model: v.document.schema || 'slides.document.v1', provenance: v.provenance || null })), request.input) };
    if (operation === 'get_links') { if (request.input.view === 'presenter') requireActions(claims, ['notes']); return { resourceId: document.deckId, revision: document.revision, url: `/apps/slides/?deck=${encodeURIComponent(`${claims.spaceId}:${document.deckId}`)}&slidesSpace=${encodeURIComponent(claims.spaceId)}&slidesResource=${encodeURIComponent(document.deckId)}&revision=${document.revision}${request.input.view === 'presenter' ? '&presenter=1' : request.input.view === 'present' ? '&present=1' : ''}` }; }
    if (operation === 'get_job') { const job = this.job(state, request, claims); return this.jobView(job); }
    if (operation === 'get_artifact') return this.artifact(state, request, claims);
    fail(400, 'UNKNOWN_OPERATION');
  }
  async edit(state, request, claims) {
    const operation = request.operation, id = request.resourceId, input = request.input; let document, before;
    const reset = operation === 'apply_edits' && input.operations.length === 1 && input.operations[0].kind === 'reset_template' ? input.operations[0] : null;
    if (operation === 'create_deck') {
      if (Object.hasOwn(state.documents, id)) fail(409, 'ALREADY_EXISTS');
      const scaffold = await Native.scaffoldNative({ templateId: input.templateId, deckId: id, title: input.title, templateVars: input.templateVars });
      document = { schema: 'lattice.business.native.v1', schemaVersion: 2, deckId: id, revision: '0', title: input.title, language: input.language, ...scaffold, assets: [], locked: false, archived: false, createdAt: new Date(this.now()).toISOString() };
    } else {
      document = clone(documentAt(state, request)); assertRevision(document, request.expectedRevision); before = clone(document);
      if (operation !== 'archive_deck' && !reset) requireNative(document);
      if (document.locked && !['set_content_lock','archive_deck'].includes(operation) && !(operation === 'apply_edits' && input.operations.every(edit => edit.kind === 'set_review_session'))) fail(423, 'CONTENT_LOCKED');
    }
    if (reset) {
      requireActions(claims, ['read','update','notes']);
      if (document.archived) fail(409, 'DECK_ARCHIVED');
      if (!Native.getNativeCatalog().templates.some(template => template.id === reset.templateId)) fail(400, 'INVALID_TEMPLATE');
      const scaffold = await Native.scaffoldNative({ templateId: reset.templateId, deckId: id, title: document.title, templateVars: reset.templateVars });
      document = { schema: 'lattice.business.native.v1', schemaVersion: 2, deckId: id, revision: document.revision, title: document.title, language: document.language || 'zh-CN', ...scaffold, assets: clone(document.assets || []), locked: false, archived: false, createdAt: document.createdAt };
    } else if (operation === 'apply_edits') for (const edit of input.operations) await this.applyEdit(state, document, edit, claims);
    if (operation === 'remove_asset') { const asset = document.assets.find(value=>value.id===input.assetId); if (!asset) fail(404,'NOT_FOUND'); const marker = JSON.stringify({content:document.content,timeline:document.timeline,manifestTimeline:document.manifest.timeline}); if (marker.includes(JSON.stringify(input.assetId)) || asset.nativePath && (marker.includes(JSON.stringify(asset.nativePath)) || marker.includes(JSON.stringify(`./${asset.nativePath}`)))) fail(409,'ASSET_IN_USE'); document.assets = document.assets.filter(asset=>asset.id!==input.assetId); }
    if (operation === 'restore_revision') { const snapshot = state.versions[id]?.find(value => value.revision === input.revision); if (!snapshot) fail(404, 'NOT_FOUND'); requireNative(snapshot.document); if (notesFingerprint(document) !== notesFingerprint(snapshot.document)) requireActions(claims, ['notes']); const revision = document.revision; document = clone(snapshot.document); document.revision = revision; document.locked = false; delete document.lockFingerprint; delete document.contentLock; }
    if (operation === 'set_content_lock') { requireActions(claims, ['manage_lock']); document.locked = input.mode === 'freeze'; if (document.locked) { const projection = await Native.projectNative(document, { includeNotes: true }); document.contentLock = createContentLockRecord(document.content, projection.manifest, document.notes, projection.slideDefinitions.map(slide => slide.html), { deckId: document.deckId, reason: input.reason }); document.lockFingerprint = document.contentLock.fingerprint.compositeHash; } else { delete document.lockFingerprint; delete document.contentLock; } }
    if (operation === 'archive_deck') document.archived = input.archived;
    if (isNative(document)) { await validateDocument(document); if (operation === 'apply_edits' && input.operations.some(edit => ['set_timeline','attach_audio_artifact'].includes(edit.kind) || edit.kind === 'set_content_field' && edit.fieldPath[0] === 'stops')) await Native.projectNative(document, { includeNotes: true }); }
    document.revision = String(Number(document.revision) + 1); document.updatedAt = new Date(this.now()).toISOString();
    const provenance = Native.buildProvenanceRecord({ command: `mcp.${operation}`, actor: hash([claims.userId,claims.clientId]).slice(0,24), when: document.updatedAt, deck: document.deckId, reason: reset?.reason || input.reason || null, sourceMap: null, inputs: { sha256: before ? contentFingerprint(before) : null, revision: before?.revision || null }, outputs: { sha256: contentFingerprint(document), revision: document.revision }, gate: { permitted: true, contentLockedBefore: before?.locked || false, templateId: document.templateId || null }, lockUpdate: operation === 'set_content_lock' ? input.mode : null });
    state.documents[id] = document; if (!Object.hasOwn(state.versions,id)) state.versions[id] = [];
    if (reset && !state.versions[id].some(version => version.revision === before.revision)) state.versions[id].push({ revision: before.revision, document: clone(before), createdAt: before.updatedAt || before.createdAt || document.updatedAt, operation: 'legacy_snapshot', provenance: null });
    state.versions[id].push({ revision: document.revision, document: clone(document), createdAt: document.updatedAt, operation, provenance });
    const event = { id: randomUUID(), cursor: ++state.cursor, resourceId: id, revision: document.revision, operation, requestId: claims.requestId, committedAt: document.updatedAt };
    state.events.push(event); state.events = state.events.slice(-2048);
    return { spaceId: claims.spaceId, resourceId: id, revision: document.revision, cursor: state.cursor, event, slideIds: slideIds(document), templateId: document.templateId || null, templateIdentity: document.templateIdentity || null, provenance, locked: document.locked, archived: document.archived };
  }
  async applyEdit(state, document, edit, claims) {
    const slide = edit.slideId && document.content.slides.find(value => value.id === edit.slideId); if (edit.slideId && !slide) fail(404, 'NOT_FOUND');
    if (edit.kind === 'set_metadata') { const { title, language, ...vars } = edit.patch; if (title !== undefined) document.title = title; if (language !== undefined) document.language = language; Object.assign(document.templateVars, vars); Object.assign(document.manifest, vars); }
    else if (edit.kind === 'set_content_field') {
      const guidance = Native.getNativeSlotGuidance(document.templateId), [first,...rest] = edit.fieldPath;
      if (typeof first !== 'string' || ['id','guidance','slotGuidance'].includes(first) || !guidance.layouts[slide.layout].fields.includes(first)) fail(400, 'UNKNOWN_CONTENT_SLOT');
      let target = slide;
      for (const segment of [first,...rest].slice(0,-1)) { if (!target || typeof target !== 'object' || !Object.hasOwn(target,segment)) fail(400, 'UNKNOWN_CONTENT_SLOT'); target = target[segment]; }
      const last = edit.fieldPath.at(-1); if (!target || typeof target !== 'object' || Array.isArray(target) && (typeof last !== 'number' || last > target.length)) fail(400, 'UNKNOWN_CONTENT_SLOT'); target[last] = clone(edit.value);
    }
    else if (edit.kind === 'add_slide') { if (slideIds(document).includes(edit.slide.id)) fail(409, 'ALREADY_EXISTS'); const ids = slideIds(document); const index = edit.afterSlideId === null ? 0 : edit.afterSlideId === undefined ? ids.length : ids.indexOf(edit.afterSlideId) + 1; if (edit.afterSlideId && index === 0) fail(404, 'NOT_FOUND'); document.content.slides.splice(index,0,clone(edit.slide)); document.notes[edit.slide.id] = ''; }
    else if (edit.kind === 'remove_slide') { if (document.notes[edit.slideId]) requireActions(claims,['notes']); document.content.slides = document.content.slides.filter(value => value.id !== edit.slideId); delete document.notes[edit.slideId]; if (document.timeline?.slides) delete document.timeline.slides[edit.slideId]; if (document.manifest.timeline?.slides) delete document.manifest.timeline.slides[edit.slideId]; }
    else if (edit.kind === 'reorder_slides') { const ids = slideIds(document); if (edit.slideIds.length !== ids.length || new Set(edit.slideIds).size !== ids.length || edit.slideIds.some(id => !ids.includes(id))) fail(400,'INVALID_SLIDE_ORDER'); document.content.slides = edit.slideIds.map(id => document.content.slides.find(value => value.id === id)); }
    else if (edit.kind === 'set_palette') { if (!Native.getNativeCatalog().palettes.some(palette => palette.id === edit.paletteId)) fail(400,'INVALID_PALETTE'); document.paletteId = edit.paletteId; }
    else if (edit.kind === 'set_timeline') document.timeline = clone(edit.timeline);
    else if (edit.kind === 'set_notes') { requireActions(claims,['notes']); document.notes[edit.slideId] = edit.notes; }
    else if (edit.kind === 'attach_asset') { const asset = state.assets[edit.stagedAssetId]; if (!asset || asset.deckId !== document.deckId || !asset.staged || asset.expiresAt < this.now()) fail(404,'NOT_FOUND'); if (document.assets.some(value => value.id === asset.id)) fail(409,'ALREADY_EXISTS'); asset.staged = false; document.assets.push(this.assetView(asset)); }
    else if (edit.kind === 'attach_audio_artifact' || edit.kind === 'set_review_session') {
      const job = this.job(state,{resourceId:document.deckId,input:{jobId:edit.jobId}},claims); if (job.status !== 'succeeded') fail(409,'JOB_NOT_COMPLETE'); if (job.document.revision !== document.revision) fail(409,'REVISION_CONFLICT');
      if (edit.kind === 'set_review_session') { if (job.kind !== 'review' || !job.report?.session) fail(400,'INVALID_REVIEW_RESULT'); document.reviewSession = clone(job.report.session); }
      else { if (job.kind !== 'prepare_audio' || !(job.report?.timeline || job.report?.nativeManifest?.timeline)) fail(400,'INVALID_AUDIO_RESULT'); if (job.options.kind === 'narration') requireActions(claims,['notes']); const audio = (job.artifacts || []).map(item=>state.artifacts[item.artifactId]).filter(item=>item.mimeType.startsWith('audio/')); if (!audio.length) fail(400,'INVALID_AUDIO_RESULT'); for (const artifact of audio) { if (!artifact.nativePath || !/^assets\/audio\/[A-Za-z0-9_.-]+$/.test(artifact.nativePath)) fail(400,'INVALID_AUDIO_RESULT'); const asset = { id:artifact.artifactId,deckId:document.deckId,blob:artifact.blob,mimeType:artifact.mimeType,byteLength:artifact.byteLength,sha256:artifact.sha256,rights:'generated',sourceLabel:'native-audio',nativePath:artifact.nativePath,staged:false,notesSensitive:job.requiredActions.includes('notes') }; state.assets[asset.id] = asset; if (!document.assets.some(value=>value.id===asset.id)) document.assets.push(this.assetView(asset)); } document.timeline = clone(job.report.timeline || job.report.nativeManifest.timeline); }
    }
  }

  assetView(asset) { return { id: asset.id, mimeType: asset.mimeType, byteLength: asset.byteLength, sha256: asset.sha256, rights: asset.rights, sourceLabel: asset.sourceLabel, ...(asset.nativePath ? { nativePath: asset.nativePath } : {}), ...(asset.notesSensitive ? { notesSensitive: true } : {}) }; }
  job(state, request, claims) { const job = state.jobs[request.input.jobId]; if (!job || job.deckId !== request.resourceId) fail(404, 'NOT_FOUND'); requireActions(claims, job.requiredActions); return job; }
  jobView(job) { return { resourceId: job.deckId, revision: job.document.revision, jobId: job.id, kind: job.kind, status: job.status, createdAt: job.createdAt, attempt: job.attempt, ...(job.parentJobId ? { parentJobId: job.parentJobId } : {}), ...(job.artifacts ? { artifacts: job.artifacts } : {}), ...(job.issues ? { issues: job.issues } : {}), ...(job.asset ? { asset: job.asset } : {}), ...(job.report ? { report: job.report } : {}), ...(job.error ? { error: job.error } : {}) }; }
  async createJob(state, request, claims) {
    const document = documentAt(state, request); assertRevision(document, request.expectedRevision);
    if (document.archived) fail(409, 'DECK_ARCHIVED');
    if (request.input.sourceAssetId && !document.assets.some(asset=>asset.id===request.input.sourceAssetId && asset.mimeType.startsWith('audio/'))) fail(404,'NOT_FOUND');
    requireNative(document);
    if (request.input.slideIds?.some(id => !slideIds(document).includes(id))) fail(404, 'NOT_FOUND');
    const requiredActions = ['read'];
    if (['preview','lint','prepare_audio','render_video','review'].includes(request.operation) || request.operation === 'check' && request.input.rendered) requiredActions.push('render');
    if (['export','render_video'].includes(request.operation)) requiredActions.push('export');
    if (request.operation === 'import_asset') requiredActions.push('update');
    const sensitiveAudio = document.assets.some(asset=>asset.notesSensitive) && (['render_video','review','prepare_audio'].includes(request.operation) || request.operation === 'export' && request.input.format === 'html');
    const needsNotes = request.input.includeNotes || request.operation === 'prepare_audio' && request.input.kind === 'narration' || ['review','budget'].includes(request.operation) || sensitiveAudio || request.operation === 'render_video' && request.input.operation === 'subtitles';
    if (needsNotes) requiredActions.push('notes'); requireActions(claims, requiredActions);
    if (request.operation !== 'import_asset' && !this.renderer) fail(503,'RENDERER_UNAVAILABLE');
    await checkVideoBackend(request.operation, request.input);
    if (Object.values(state.jobs).filter(j => ['queued', 'running'].includes(j.status)).length >= 16 || Object.values(state.jobs).filter(j => ['queued', 'running'].includes(j.status) && j.userId === claims.userId).length >= 8) fail(429, 'JOB_QUOTA');
    const id = randomUUID(); const job = { id, spaceId: claims.spaceId, deckId: document.deckId, document: viewDocument(document, Boolean(needsNotes)), options: clone(request.input), kind: request.operation, status: 'queued', requiredActions: [...new Set(requiredActions)], userId: claims.userId, clientId: claims.clientId, grantId: claims.grantId, authorizationExpiresAt: claims.authorizationExpiresAt || claims.expiresAt, firstPartyNative: claims.firstPartyNative === true, createdAt: new Date(this.now()).toISOString(), attempt: 1 };
    state.jobs[id] = job; return this.jobView(job);
  }
  cancelJob(state, request, claims) { const job = this.job(state, request, claims); if (job.userId !== claims.userId && !grants(claims).has('manage_lock')) fail(403, 'FORBIDDEN'); if (['queued', 'running', 'cancelling'].includes(job.status)) { job.status = job.status === 'queued' ? 'cancelled' : 'cancelling'; this.running.get(job.id)?.abort(); } return this.jobView(job); }
  async retryJob(state, request, claims) { const original = this.job(state, request, claims); if (!['failed', 'interrupted'].includes(original.status)) fail(409, 'JOB_NOT_RETRYABLE'); await checkVideoBackend(original.kind, original.options); const id = randomUUID(), job = { ...clone(original), id, status: 'queued', parentJobId: original.id, attempt: original.attempt + 1, userId: claims.userId, clientId: claims.clientId, grantId: claims.grantId, authorizationExpiresAt: claims.authorizationExpiresAt || claims.expiresAt, firstPartyNative: claims.firstPartyNative === true, createdAt: new Date(this.now()).toISOString() }; delete job.error; delete job.artifacts; delete job.issues; state.jobs[id] = job; return this.jobView(job); }
  async artifact(state, request, claims) {
    const artifactId = request.input.artifactId || request.input.assetId;
    let artifact = state.artifacts[artifactId], revision;
    if (!artifact) {
      const asset = state.assets[artifactId]; if (!asset || asset.staged || asset.deckId !== request.resourceId) fail(404,'NOT_FOUND');
      requireActions(claims, asset.notesSensitive ? ['read','notes'] : ['read']);
      artifact = { artifactId: asset.id, deckId: asset.deckId, mimeType: asset.mimeType, byteLength: asset.byteLength, sha256: asset.sha256, blob: asset.blob, format: asset.mimeType.split('/')[1], fileName: `${asset.id}.${asset.mimeType.split('/')[1]}`, downloadUrl: `/apps/slides/api/slides/decks/${encodeURIComponent(claims.spaceId)}/${encodeURIComponent(request.resourceId)}/assets/${encodeURIComponent(asset.id)}` };
      revision = state.documents[request.resourceId].revision;
    } else {
      if (artifact.deckId !== request.resourceId) fail(404,'NOT_FOUND');
      const job = state.jobs[artifact.jobId]; requireActions(claims,job.requiredActions); revision = job.document.revision;
      artifact = { ...artifact, downloadUrl: `/apps/slides/api/slides/decks/${encodeURIComponent(claims.spaceId)}/${encodeURIComponent(request.resourceId)}/artifacts/${encodeURIComponent(artifact.artifactId)}` };
    }
    const value = { ...artifact }; delete value.blob;
    if (request.input.mode === 'inline') { if (value.byteLength > 4 * 1024 * 1024) fail(413,'ARTIFACT_TOO_LARGE'); value.base64 = (await this.readBlob(artifact.blob)).toString('base64'); }
    if (request.input.mode === 'chunk') {
      if (!/^[a-f0-9]{64}$/.test(artifact.blob)) fail(500,'INVALID_ARTIFACT');
      const offset = request.input.offset ?? 0, length = request.input.length ?? 1048576;
      if (offset > value.byteLength) fail(416,'INVALID_RANGE');
      const file = join(this.blobs,artifact.blob), info = await lstat(file);
      if (!info.isFile() || info.isSymbolicLink() || info.size !== value.byteLength) fail(500,'ARTIFACT_CORRUPT');
      const descriptor = await open(file,'r');
      try { const buffer = Buffer.alloc(Math.min(length,value.byteLength-offset)); const {bytesRead} = await descriptor.read(buffer,0,buffer.length,offset); value.chunk = { base64: buffer.subarray(0,bytesRead).toString('base64'), offset, byteLength: bytesRead, totalByteLength: value.byteLength, eof: offset + bytesRead >= value.byteLength }; }
      finally { await descriptor.close(); }
    }
    return { resourceId: request.resourceId, revision, artifact: value };
  }
  async artifactBlob(item) {
    if (item.filePath) {
      const info = await lstat(item.filePath); if (!info.isFile() || info.isSymbolicLink() || info.size > 128 * 1024 * 1024) fail(413,'ARTIFACT_TOO_LARGE');
      const digest = createHash('sha256'); for await (const chunk of createReadStream(item.filePath)) digest.update(chunk);
      const blob = digest.digest('hex'); await mkdir(this.blobs,{recursive:true,mode:0o700});
      const temporary = join(this.blobs,`${blob}.${randomUUID()}.tmp`); try { await copyFile(item.filePath,temporary,1); await chmod(temporary,0o600); await rename(temporary,join(this.blobs,blob)); } finally { await rm(temporary,{force:true}); }
      return { blob, byteLength: info.size };
    }
    const buffer = Buffer.isBuffer(item.buffer) ? item.buffer : Buffer.from(item.buffer); if (buffer.length > 128 * 1024 * 1024) fail(413,'ARTIFACT_TOO_LARGE');
    return { blob: await this.putBlob(buffer), byteLength: buffer.length };
  }

  async runJob(jobId) {
    const controller = new AbortController(); this.running.set(jobId, controller);
    let job, result, timer, checking = false;
    const authorized = async value => this.authorizationCheck ? await this.authorizationCheck({ spaceId: value.spaceId, deckId: value.deckId, userId: value.userId, clientId: value.clientId, grantId: value.grantId, requiredActions: value.requiredActions, expiresAt: value.authorizationExpiresAt, firstPartyNative: value.firstPartyNative }) === true : value.authorizationExpiresAt > this.now();
    try {
      job = await this.transaction(state => { const job = state.jobs[jobId]; if (!job || job.status !== 'queued') return null; if (!this.authorizationCheck && job.authorizationExpiresAt <= this.now()) { job.status = 'failed'; job.error = { code: 'AUTHORIZATION_EXPIRED' }; return null; } job.status = 'running'; return clone(job); });
      if (!job) return;
      if (!await authorized(job)) fail(403, 'AUTHORIZATION_REVOKED');
      if (needsVideoBackend(job.kind, job.options)) {
        await checkVideoBackend(job.kind, job.options);
        if (!await authorized(job)) fail(403, 'AUTHORIZATION_REVOKED');
      }
      timer = setInterval(async () => { if (checking) return; checking = true; try { if (!await authorized(job)) controller.abort(); } catch { controller.abort(); } finally { checking = false; } }, 5000); timer.unref();
      if (job.kind === 'import_asset') result = await this.importAsset(job);
      else {
        const state = await this.read(); const assets = await Promise.all(job.document.assets.map(async asset => ({ ...asset, assetId: asset.id, buffer: await this.readBlob(state.assets[asset.id].blob) })));
        const context = { session: clone(job.document.reviewSession || null), priorArtifacts: [] };
        const refs = [...new Set([job.options.sessionJobId,job.options.packJobId,...(job.options.reviewJobIds || [])].filter(Boolean))];
        for (const id of refs) {
          const prior = state.jobs[id]; if (!prior || prior.deckId !== job.deckId || prior.status !== 'succeeded') fail(404,'NOT_FOUND');
          if (prior.requiredActions.some(action => !job.requiredActions.includes(action))) fail(403,'FORBIDDEN');
          for (const item of prior.artifacts || []) { const artifact = state.artifacts[item.artifactId]; if (!artifact || artifact.byteLength > 16 * 1024 * 1024) fail(413,'CONTEXT_ARTIFACT_TOO_LARGE'); context.priorArtifacts.push({fileName:artifact.fileName,format:artifact.format,role:id===job.options.packJobId?'pack':id===job.options.sessionJobId?'session':'review',nativePath:artifact.nativePath,buffer:await this.readBlob(artifact.blob)}); }
        }
        result = await this.renderer({ kind: job.kind, document: job.document, options: job.options, assets, context, signal: controller.signal });
      }
      if (controller.signal.aborted) fail(409, 'JOB_CANCELLED');
      if (!await authorized(job)) fail(403, 'AUTHORIZATION_REVOKED');
      await this.transaction(async state => {
        const current = state.jobs[jobId]; if (!current || current.status === 'cancelling') { if (current) current.status = 'cancelled'; return; }
        if (result.asset) { state.assets[result.asset.id] = result.asset; current.asset = { ...this.assetView(result.asset), stagedAssetId: result.asset.id }; }
        current.artifacts = [];
        for (const item of result.artifacts || []) {
          const {blob,byteLength} = await this.artifactBlob(item), id = randomUUID();
          const nativePath = typeof item.nativePath === 'string' && item.nativePath.length <= 1000 && /^[A-Za-z0-9._/-]+$/.test(item.nativePath) && !item.nativePath.startsWith('/') && !item.nativePath.split('/').includes('..') ? item.nativePath : undefined;
          const artifact = { artifactId:id,deckId:job.deckId,jobId,format:item.format,mimeType:item.mimeType,fileName:String(item.fileName || `slides.${item.format}`).replace(/[^A-Za-z0-9_.-]/g,'_'),byteLength,sha256:blob,blob,createdAt:new Date(this.now()).toISOString(),fidelityWarnings:result.fidelityWarnings || [],...(nativePath?{nativePath}:{}),...(item.role?{role:item.role}:{}) };
          state.artifacts[id] = artifact; current.artifacts.push({...artifact,blob:undefined});
        }
        if (result.report !== undefined) current.report = clone(result.report);
        current.issues = result.issues || []; current.status = 'succeeded';
      });
    } catch (error) { await this.transaction(state => { const current = state.jobs[jobId]; if (current) { current.status = controller.signal.aborted || current.status === 'cancelling' ? 'cancelled' : 'failed'; current.error = { code: /^[A-Z_]{1,100}$/.test(error.code || '') ? error.code : 'RENDER_FAILED', retryable: error.retryable === true }; if (error.nativeReport !== undefined) current.report = clone(error.nativeReport); } }).catch(() => {}); }
    finally { if (timer) clearInterval(timer); this.running.delete(jobId); if (typeof result?.cleanup === 'function') { try { await result.cleanup(); } catch {} } }
  }
  async importAsset(job) {
    const source = job.options.source; let buffer;
    if (source.kind === 'inline') { buffer = Buffer.from(source.data, 'base64'); if (buffer.length > 1048576 || buffer.toString('base64') !== source.data) fail(400, 'INVALID_ASSET'); }
    else { const state = await this.read(), upload = state.uploads[source.uploadId]; if (!upload || upload.deckId !== job.deckId || upload.userId !== job.userId || upload.clientId !== job.clientId || !upload.blob || upload.expiresAt <= this.now()) fail(404, 'NOT_FOUND'); buffer = await this.readBlob(upload.blob); source.mimeType = upload.mimeType; }
    const wave = source.mimeType === 'audio/wav' && buffer.length >= 44 && buffer.toString('ascii',0,4) === 'RIFF' && buffer.toString('ascii',8,12) === 'WAVE';
    const mp3 = source.mimeType === 'audio/mpeg' && buffer.length >= 4 && (buffer.toString('ascii',0,3) === 'ID3' || buffer[0] === 255 && (buffer[1] & 224) === 224);
    const m4a = source.mimeType === 'audio/mp4' && buffer.length >= 16 && buffer.toString('ascii',4,8) === 'ftyp';
    const ogg = source.mimeType === 'audio/ogg' && buffer.length >= 27 && buffer.toString('ascii',0,4) === 'OggS';
    if (source.mimeType.startsWith('audio/') && !(wave || mp3 || ogg || m4a)) fail(400,'INVALID_ASSET');
    const png = buffer.length >= 24 && buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10])); const jpeg = buffer.length >= 4 && buffer[0] === 255 && buffer[1] === 216 && buffer.at(-2) === 255 && buffer.at(-1) === 217; const webp = buffer.length >= 16 && buffer.toString('ascii',0,4) === 'RIFF' && buffer.toString('ascii',8,12) === 'WEBP';
    if (source.mimeType === 'image/png' && !png || source.mimeType === 'image/jpeg' && !jpeg || source.mimeType === 'image/webp' && !webp) fail(400, 'INVALID_ASSET');
    let width, height;
    if (png) { if (buffer.toString('ascii', 12, 16) !== 'IHDR') fail(400, 'INVALID_ASSET'); width = buffer.readUInt32BE(16); height = buffer.readUInt32BE(20); }
    if (jpeg) {
      let offset = 2;
      while (offset + 4 < buffer.length) {
        if (buffer[offset] !== 255) fail(400, 'INVALID_ASSET');
        while (buffer[offset] === 255) offset++;
        const marker = buffer[offset++];
        if ([0xD8, 0xD9, 0x01].includes(marker) || marker >= 0xD0 && marker <= 0xD7) continue;
        if (offset + 2 > buffer.length) fail(400, 'INVALID_ASSET');
        const size = buffer.readUInt16BE(offset);
        if (size < 2 || offset + size > buffer.length) fail(400, 'INVALID_ASSET');
        if ([0xC0,0xC1,0xC2,0xC3,0xC5,0xC6,0xC7,0xC9,0xCA,0xCB,0xCD,0xCE,0xCF].includes(marker)) { if (size < 7) fail(400, 'INVALID_ASSET'); height = buffer.readUInt16BE(offset + 3); width = buffer.readUInt16BE(offset + 5); break; }
        if (marker === 0xDA) break;
        offset += size;
      }
    }
    if (webp) {
      const type = buffer.toString('ascii', 12, 16);
      if (type === 'VP8X' && buffer.length >= 30) { width = 1 + buffer.readUIntLE(24, 3); height = 1 + buffer.readUIntLE(27, 3); }
      else if (type === 'VP8 ' && buffer.length >= 30 && buffer[23] === 0x9D && buffer[24] === 0x01 && buffer[25] === 0x2A) { width = buffer.readUInt16LE(26) & 0x3FFF; height = buffer.readUInt16LE(28) & 0x3FFF; }
      else if (type === 'VP8L' && buffer.length >= 25 && buffer[20] === 0x2F) { const bits = buffer.readUInt32LE(21); width = 1 + (bits & 0x3FFF); height = 1 + ((bits >>> 14) & 0x3FFF); }
    }
    if (!source.mimeType.startsWith('audio/') && (!width || !height)) fail(400, 'INVALID_ASSET');
    if (width > 8192 || height > 8192 || width * height > 32000000) fail(400, 'ASSET_PIXEL_LIMIT');
    const blob = await this.putBlob(buffer), id = randomUUID(); return { asset: { id, deckId: job.deckId, mimeType: source.mimeType, byteLength: buffer.length, sha256: blob, blob, rights: job.options.rights, sourceLabel: job.options.sourceLabel, staged: true, expiresAt: this.now() + 3600000 } };
  }
}
