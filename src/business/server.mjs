import { isDatabase } from '../sqlite-document.mjs';
import { createServer as httpServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { SlidesStore, fail, hash } from './store.mjs';
import { idSchema, revisionSchema, OPERATIONS, NO_RESOURCE, DOCUMENT_WRITES, KEYED_OPERATIONS, SNAPSHOT_OPERATIONS } from './schema.mjs';

const actions = new Set(['read', 'create', 'update', 'render', 'export', 'delete', 'notes', 'manage_lock']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function validId(value) { return idSchema.safeParse(value).success; }
const errorSegment = z.union([z.string().regex(/^[A-Za-z_][A-Za-z0-9_-]{0,79}$/).refine(value => !['__proto__','prototype','constructor'].includes(value)), z.number().int().min(0).max(1000000)]);
const fieldError = z.object({ path: z.array(errorSegment).min(1).max(24), code: z.enum(Object.values(z.ZodIssueCode)) }).strict();
function safeErrorDetails(error) {
  if (error.authorizedSlides !== true) return {};
  if (error.status === 409 && error.code === 'REVISION_CONFLICT' && typeof error.currentRevision === 'string' && revisionSchema.safeParse(error.currentRevision).success) return { currentRevision: error.currentRevision };
  if (error.status !== 400 || error.code !== 'INVALID_INPUT' || !Array.isArray(error.fieldErrors)) return {};
  const fieldErrors = error.fieldErrors.slice(0,20).flatMap(item => { const parsed = fieldError.safeParse({path:item?.path,code:item?.code}); return parsed.success ? [parsed.data] : []; });
  return fieldErrors.length ? {fieldErrors} : {};
}
export function verifyAssertion(raw, assertion, key, now = Date.now(), path = '/api/business') {
  const invalid = () => fail(401, 'INVALID_ASSERTION');
  if (typeof assertion !== 'string' || assertion.length > 32768) invalid();
  const parts = assertion.split('.'); if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) invalid();
  const expected = createHmac('sha256', key).update(parts[0]).digest(), actual = Buffer.from(parts[1], 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) invalid();
  let claims; try { claims = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8')); } catch { invalid(); }
  const required = ['v', 'appId', 'userId', 'clientId', 'grantId', 'spaceId', 'action', 'resources', 'expiresAt', 'requestId', 'method', 'path', 'bodyHash'];
  if (!object(claims) || required.some(name => !Object.hasOwn(claims, name)) || Object.keys(claims).some(name => !required.includes(name) && !['actionsGranted', 'authorizationExpiresAt', 'firstPartyNative'].includes(name))) invalid();
  if (claims.v !== 1 || claims.appId !== 'slides' || claims.method !== 'POST' || claims.path !== path || claims.bodyHash !== hash(raw) || !actions.has(claims.action)) invalid();
  if (!['userId', 'clientId', 'grantId', 'spaceId', 'requestId'].every(name => validId(claims[name])) || !Number.isSafeInteger(claims.expiresAt) || claims.expiresAt <= now || claims.expiresAt > now + 30000) invalid();
  if (!Array.isArray(claims.resources) || !claims.resources.length || claims.resources.length > 1000 || new Set(claims.resources).size !== claims.resources.length || claims.resources.some(id => id !== '*' && !validId(id)) || claims.resources.includes('*') && claims.resources.length !== 1) invalid();
  if (claims.authorizationExpiresAt !== undefined && (!Number.isSafeInteger(claims.authorizationExpiresAt) || claims.authorizationExpiresAt <= now || claims.authorizationExpiresAt > now + 31 * 86400000)) invalid();
  if (claims.firstPartyNative !== undefined && typeof claims.firstPartyNative !== 'boolean') invalid();
  if (claims.actionsGranted !== undefined && (!Array.isArray(claims.actionsGranted) || claims.actionsGranted.some(action => !actions.has(action)) || new Set(claims.actionsGranted).size !== claims.actionsGranted.length || !claims.actionsGranted.includes(claims.action))) invalid();
  return claims;
}
export class BusinessService {
  constructor({ key, spaces, blobs = {}, renderer, authorizationCheck, now = Date.now }) {
    if (!Buffer.isBuffer(key) || key.length < 32 || key.length > 4096 || !object(spaces) || !Object.keys(spaces).length) throw new Error('Slides business configuration is invalid.');
    if(!object(blobs)||Object.entries(blobs).some(([space,path])=>!Object.hasOwn(spaces,space)||typeof path!=='string'||!isAbsolute(path)))throw new Error('Invalid app-owned blob mapping.');
    this.key = Buffer.from(key); this.now = now; this.stores = new Map();
    for (const [spaceId, file] of Object.entries(spaces)) { if (!validId(spaceId) || !isAbsolute(file) || [...this.stores.values()].some(store => store.file === file && !isDatabase(file))) throw new Error('Slides spaces require distinct absolute data files.'); this.stores.set(spaceId, new SlidesStore(file, { spaceId, blobsDirectory: blobs[spaceId], renderer, authorizationCheck, now })); }
    this.ready = Promise.all([...this.stores.values()].map(store => store.recover()));
  }
  validateRequest(request, claims) {
    if (!object(request) || Object.keys(request).some(name => !['operation', 'spaceId', 'resourceId', 'input', 'expectedRevision', 'idempotencyKey'].includes(name))) fail(400, 'INVALID_REQUEST');
    if (!Object.hasOwn(OPERATIONS, request.operation) || claims.spaceId !== request.spaceId || !this.stores.has(request.spaceId) || claims.action !== OPERATIONS[request.operation]) fail(403, 'FORBIDDEN');
    if (NO_RESOURCE.has(request.operation)) { if (request.resourceId !== undefined || request.expectedRevision !== undefined) fail(400, 'INVALID_RESOURCE'); }
    else if (!validId(request.resourceId)) fail(400, 'RESOURCE_REQUIRED');
    const snapshot = SNAPSHOT_OPERATIONS.has(request.operation);
    if (DOCUMENT_WRITES.has(request.operation) && request.operation !== 'create_deck' || snapshot) { if (!revisionSchema.safeParse(request.expectedRevision).success) fail(428, 'REVISION_REQUIRED'); }
    else if (request.expectedRevision !== undefined) fail(400, 'INVALID_REVISION');
    if (KEYED_OPERATIONS.has(request.operation)) { if (!validId(request.idempotencyKey)) fail(428, 'IDEMPOTENCY_REQUIRED'); }
    else if (request.idempotencyKey !== undefined) fail(400, 'INVALID_IDEMPOTENCY');
  }
  async handle(raw, assertion) {
    const claims = verifyAssertion(raw, assertion, this.key, this.now()); let request;
    try { request = JSON.parse(raw.toString('utf8')); } catch { fail(400, 'INVALID_REQUEST'); }
    this.validateRequest(request, claims); await this.ready;
    try { return await this.stores.get(claims.spaceId).invoke(request, claims); }
    catch (error) {
      if (!request.resourceId || claims.resources.includes('*') || claims.resources.includes(request.resourceId)) error.authorizedSlides = true;
      throw error;
    }
  }
  async upload(raw, assertion, path, uploadId) { const claims = verifyAssertion(raw, assertion, this.key, this.now(), path); if (!this.stores.has(claims.spaceId) || claims.action !== 'update') fail(403, 'FORBIDDEN'); await this.ready; return this.stores.get(claims.spaceId).upload(uploadId, raw, claims); }
}
function json(response, status, value) { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); response.end(JSON.stringify(value)); }
export function createServer({ business, key, spaces, renderer, authorizationCheck, now = Date.now } = {}) {
  business ||= new BusinessService({ key, spaces, renderer, authorizationCheck, now });
  const server = httpServer({ maxHeaderSize: 16384, requestTimeout: 15000, headersTimeout: 10000 }, async (request, response) => {
    try {
      if (request.method === 'GET' && request.url === '/health') { await business.ready; return json(response, 200, { status: 'ok', app: 'slides' }); }
      const upload = /^\/api\/business\/uploads\/([A-Za-z0-9-]{1,100})$/.exec(request.url || '');
      if (request.method !== 'POST' || request.url !== '/api/business' && !upload) return json(response, 404, { code: 'NOT_FOUND' });
      const chunks = []; let length = 0; for await (const part of request) { length += part.length; if (length > (upload ? 10 * 1024 * 1024 : 3 * 1024 * 1024)) fail(413, 'REQUEST_TOO_LARGE'); chunks.push(part); }
      const raw = Buffer.concat(chunks), assertion = request.headers['x-praxis-assertion'];
      const value = upload ? await business.upload(raw, assertion, request.url, upload[1]) : await business.handle(raw, assertion);
      return json(response, 200, value);
    } catch (error) {
      const status = Number.isInteger(error.status) && error.status >= 400 && error.status <= 599 ? error.status : 500;
      const code = /^[A-Z_]{1,64}$/.test(error.code || '') ? error.code : 'REQUEST_FAILED';
      return json(response, status, {code, ...safeErrorDetails(error)});
    }
  });
  server.business = business; return server;
}
async function checkAuthorization(url, headers, body) {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: 'POST', headers, signal: AbortSignal.timeout(5000) }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 65536) response.destroy(new Error('Authorization response is too large.')); else chunks.push(chunk); });
      response.on('error', reject);
      response.on('end', () => { if (response.statusCode !== 200) return resolve(false); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')).authorized === true); } catch { resolve(false); } });
    });
    request.on('error', reject); request.end(body);
  });
}
function privateFile(path) { if (!isAbsolute(path || '')) throw new Error('Slides secrets require absolute paths.'); const info = lstatSync(path); if (!info.isFile() || info.isSymbolicLink() || info.mode & 0o077 || info.size > 65536) throw new Error('Slides secrets require private regular files.'); return readFileSync(path); }
export function loadBusinessService(env = process.env, renderer) {
  const key = privateFile(env.SLIDES_BUSINESS_KEY_FILE), config = JSON.parse(privateFile(env.SLIDES_BUSINESS_SPACES_FILE).toString('utf8'));
  if (!object(config) || Object.keys(config).some(name => !['version', 'spaces', 'blobs'].includes(name)) || config.version !== undefined && config.version !== 1) throw new Error('Slides spaces configuration is invalid.');
  if (env.SLIDES_BUSINESS_AUTHORIZATION_HOST && !/^[A-Za-z0-9.:[\]-]{1,250}$/.test(env.SLIDES_BUSINESS_AUTHORIZATION_HOST)) throw new Error('Invalid Slides callback Host.');
  let authorizationCheck;
  if (env.SLIDES_BUSINESS_AUTHORIZATION_URL) {
    const url = new URL(env.SLIDES_BUSINESS_AUTHORIZATION_URL);
    if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol) || url.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(url.hostname)) throw new Error('Slides authorization callback requires a fixed safe URL.');
    authorizationCheck = async job => {
      const body = JSON.stringify({ spaceId: job.spaceId, resourceId: job.deckId, userId: job.userId, clientId: job.clientId, grantId: job.grantId, actions: job.requiredActions, expiresAt: job.expiresAt, ...(job.firstPartyNative ? { firstPartyNative: true } : {}) });
      const claims = { v: 1, appId: 'slides', method: 'POST', path: url.pathname, bodyHash: hash(body), expiresAt: Date.now() + 10000, requestId: randomUUID() };
      const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
      const assertion = `${payload}.${createHmac('sha256', key).update(payload).digest('base64url')}`;
      return checkAuthorization(url, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'x-praxis-business-assertion': assertion, ...(env.SLIDES_BUSINESS_AUTHORIZATION_HOST ? { Host: env.SLIDES_BUSINESS_AUTHORIZATION_HOST } : {}) }, body);
    };
  }
  return new BusinessService({ key, spaces: config.spaces, blobs: config.blobs, renderer, authorizationCheck });
}
async function main() {
  let host = '127.0.0.1', port = 4328;
  for (let i = 2; i < process.argv.length; i += 2) { if (process.argv[i] === '--host') host = process.argv[i + 1]; else if (process.argv[i] === '--port' && /^\d+$/.test(process.argv[i + 1] || '')) port = Number(process.argv[i + 1]); else throw new Error('Unknown server argument.'); }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid Slides port.');
  const { createRenderer } = await import('./render.mjs'); const { runNativeTask } = await import('./native-media.mjs'); const visualRenderer = createRenderer(); const renderer = args => ['validate','lint','budget','prepare_audio','render_video','review'].includes(args.kind) ? runNativeTask(args) : visualRenderer(args); const business = loadBusinessService(process.env, renderer); const server = createServer({ business });
  server.listen(port, host, () => process.stdout.write(`Slides business listening on http://${host}:${port}\n`));
  const stop = () => { server.close(() => process.exit(0)); server.closeIdleConnections(); }; process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
