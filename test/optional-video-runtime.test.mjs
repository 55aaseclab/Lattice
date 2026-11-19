import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { BusinessService } from '../src/business/server.mjs';
import { createHash, createHmac } from 'node:crypto';
import { ensureBackendsInitialized, getBackend, requireAvailableBackend } from '../packages/cli/src/video/registry.js';
import { createWorkbenchHandler } from '../packages/cli/src/video/ui/server.js';

function unavailableBackend(t) {
  ensureBackendsInitialized();
  const backend = getBackend('remotion'), previous = backend.doctor;
  backend.doctor = async () => ({ status: 'unavailable', diagnostics: [{ level: 'error', message: 'Remotion is not installed.' }], exitCode: 2 });
  t.after(() => { backend.doctor = previous; });
  return backend;
}

test('missing video runtime is reported before native HTTP rendering is queued', async t => {
  unavailableBackend(t);
  await assert.rejects(requireAvailableBackend('remotion'), error => error.code === 'VIDEO_BACKEND_UNAVAILABLE' && error.status === 503);
  const root = await mkdtemp(join(tmpdir(), 'native-video-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'decks', 'sample'), { recursive: true });
  await writeFile(join(root, 'decks/sample/manifest.json'), '{}');
  const handle = await createWorkbenchHandler({ cwd: root, config: { decksDir: 'decks', outDir: 'dist' } });
  const server = createServer((request, response) => { void handle(request, response, () => { response.writeHead(404); response.end(); }); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const url = 'http://127.0.0.1:' + server.address().port;
  const response = await fetch(url + '/api/render', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deck: 'sample', backend: 'remotion' }) });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).code, 'VIDEO_BACKEND_UNAVAILABLE');
  const jobs = await (await fetch(url + '/api/jobs')).json();
  assert.deepEqual(jobs.jobs, []);
});

test('missing video runtime preserves old jobs and artifacts while blocking new work and recovery', async t => {
  unavailableBackend(t);
  const root = await mkdtemp(join(tmpdir(), 'business-video-runtime-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const key = Buffer.alloc(48, 61), file = join(root, 'slides.json');
  let renders = 0;
  const service = new BusinessService({ key, spaces: { personal: file }, renderer: async () => { renders++; throw new Error('No video work may execute.'); } });
  const invoke = async (operation, input, extra = {}) => {
    const request = { operation, spaceId: 'personal', resourceId: 'sample', input, ...extra };
    const raw = Buffer.from(JSON.stringify(request));
    const claims = { v: 1, appId: 'slides', userId: 'owner', clientId: 'synthetic-client', grantId: 'synthetic-grant', spaceId: 'personal', action: operation === 'create_deck' ? 'create' : operation === 'render_video' ? 'render' : 'read', resources: ['*'], actionsGranted: ['read','create','update','render','export','notes','manage_lock','delete'], expiresAt: Date.now() + 25000, requestId: 'synthetic-request', method: 'POST', path: '/api/business', bodyHash: createHash('sha256').update(raw).digest('hex') };
    const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return service.handle(raw, encoded + '.' + createHmac('sha256', key).update(encoded).digest('base64url'));
  };
  await invoke('create_deck', { title: 'Synthetic native deck', templateId: 'simple-light', language: 'en' }, { idempotencyKey: 'create-sample' });
  const before = await readFile(file);
  await assert.rejects(invoke('render_video', { operation: 'render', backend: 'remotion' }, { expectedRevision: '1', idempotencyKey: 'new-video' }), error => error.code === 'VIDEO_BACKEND_UNAVAILABLE');
  assert.deepEqual(await readFile(file), before);
  const store = service.stores.get('personal'), bytes = Buffer.from('Synthetic historical video artifact.');
  const digest = await store.putBlob(bytes);
  await store.transaction(state => {
    const job = { id: 'queued-video', spaceId: 'personal', deckId: 'sample', document: structuredClone(state.documents.sample), options: { operation: 'render', backend: 'remotion' }, kind: 'render_video', status: 'queued', requiredActions: ['read','render','export'], userId: 'owner', clientId: 'synthetic-client', grantId: 'synthetic-grant', authorizationExpiresAt: Date.now() + 25000, createdAt: new Date().toISOString(), attempt: 1 };
    state.jobs['queued-video'] = job;
    state.jobs['legacy-video'] = { ...structuredClone(job), id: 'legacy-video', options: { backend: 'remotion' } };
    state.jobs['finished-video'] = { ...structuredClone(job), id: 'finished-video', status: 'succeeded', artifacts: [{ artifactId: 'old-video' }] };
    state.artifacts['old-video'] = { artifactId: 'old-video', jobId: 'finished-video', deckId: 'sample', format: 'mp4', mimeType: 'video/mp4', byteLength: bytes.length, sha256: digest, blob: digest, fileName: 'old.mp4' };
  });
  const historical = structuredClone((await store.read()).jobs['finished-video']);
  await store.recover();
  const state = await store.read();
  assert.equal(state.jobs['queued-video'].status, 'interrupted');
  assert.equal(state.jobs['queued-video'].error.code, 'VIDEO_BACKEND_UNAVAILABLE');
  assert.equal(state.jobs['legacy-video'].status, 'interrupted');
  assert.deepEqual(state.jobs['finished-video'], historical);
  const artifact = await invoke('get_artifact', { artifactId: 'old-video', mode: 'inline' });
  assert.equal(Buffer.from(artifact.artifact.base64, 'base64').toString(), bytes.toString());
  const finished = await invoke('get_job', { jobId: 'finished-video' });
  assert.equal(finished.kind, 'render_video');
  assert.equal(finished.status, 'succeeded');
  await assert.rejects(invoke('retry_job', { jobId: 'queued-video' }, { idempotencyKey: 'retry-missing-runtime' }), error => error.code === 'VIDEO_BACKEND_UNAVAILABLE');
  assert.equal(Object.keys((await store.read()).jobs).length, 3);
  assert.equal(renders, 0);
});
