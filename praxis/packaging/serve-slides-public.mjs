import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createStaticAppServer } from './serve-static-app.mjs';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const app = resolve(process.env.PRAXIS_LATTICE_ROOT || process.env.SLIDES_PROJECT_ROOT || workspace);
const publicBase = (process.env.PUBLIC_BASE_PATH || '/apps/slides').replace(/\/$/, '');
if (!/^\/(?:[A-Za-z0-9_-]+\/?)*$/.test(publicBase) || publicBase.includes('//')) throw new Error('PUBLIC_BASE_PATH must be a safe absolute URL path.');
const port = Number(process.env.PORT || 14666);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT must be a valid port.');
const viewerRoot = join(app, 'dist-public-viewer');
const workbenchRoot = join(app, 'dist-public-workbench');
const businessRoot = join(app, 'dist-public-business');
for (const output of [viewerRoot, workbenchRoot, businessRoot]) {
  const metadata = JSON.parse(await readFile(join(output, 'public-build.json'), 'utf8'));
  if (metadata.publicBase !== publicBase) throw new Error('Rebuild public Slides assets with the configured PUBLIC_BASE_PATH.');
  if (output === businessRoot && metadata.mode !== 'business-only') throw new Error('Slides business assets must exclude legacy content.');
}
const appRequire = createRequire(join(app, 'package.json'));
const cliPackage = await realpath(appRequire.resolve('@55aaseclab/lattice-cli/package.json'));
const cliRoot = dirname(cliPackage);
const ui = join(cliRoot, 'src/video/ui/app');
const { loadConfig } = await import(pathToFileURL(join(cliRoot, 'src/config/index.js')).href);
const { installPortalMiddleware } = await import(pathToFileURL(join(cliRoot, 'src/portal/server.js')).href);
const config = await loadConfig(app);
const staticViewer = createStaticAppServer({ root: viewerRoot });
const staticWorkbench = createStaticAppServer({ root: workbenchRoot });
const staticBusiness = createStaticAppServer({ root: businessRoot });
const sendStatic = (server, request, response) => server.emit('request', request, response);
const notFound = (request, response) => {
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(request.method === 'HEAD' ? undefined : 'Not found.');
};

// The app's portal only needs Connect's use/mount/next semantics. Reuse its
// handlers without constructing Vite or exposing any development middleware.
const layers = [];
installPortalMiddleware({ cwd: app, config, server: { middlewares: {
  use(route, handler) {
    if (typeof route === 'function') { handler = route; route = ''; }
    layers.push({ route: route.replace(/\/$/, ''), handler });
  },
} } });

function prefixDeckAssets(html) {
  return html.replace(/(\b(?:src|href)\s*=\s*["'])\/decks\//g, `$1${publicBase}/decks/`);
}

function adaptHtml(html) {
  // Only app-owned route attributes and the exact dev-shell asset locations
  // are rewritten. A /@fs request itself is always rejected by the listener.
  for (const name of ['app.js', 'app.css']) {
    const attribute = name.endsWith('.js') ? 'src' : 'href';
    const original = `${attribute}="/@fs${ui}/${name}`;
    const start = html.indexOf(original);
    if (start !== -1) {
      const end = html.indexOf('"', start + original.length);
      if (end === -1) throw new Error('Invalid workbench asset attribute.');
      html = `${html.slice(0, start)}${attribute}="${publicBase}/_workbench/${name}"${html.slice(end + 1)}`;
    }
  }
  html = html.replace('window.__LATTICE_WORKBENCH_BASE = "/workbench";', `window.__LATTICE_WORKBENCH_BASE = ${JSON.stringify(`${publicBase}/workbench`)};`);
  return html.replace(/href="\/(?=\?|"|workbench(?:[/?"]|$)|lattice\/portal\/)/g, `href="${publicBase}/`);
}

function adaptJson(body, pathname) {
  const payload = JSON.parse(body);
  if (pathname === '/lattice/portal/decks') {
    for (const deck of payload.decks ?? []) {
      for (const key of ['viewer', 'present', 'workbench', 'review']) {
        if (typeof deck.entries?.[key] === 'string' && deck.entries[key].startsWith('/')) deck.entries[key] = `${publicBase}${deck.entries[key]}`;
      }
    }
  } else if (/^\/workbench\/api\/decks\/[^/]+\/descriptor$/.test(pathname)) {
    // audioAssets[].url deliberately stays /api/...: app.js passes it through
    // apiUrl(), which adds the injected workbench base exactly once.
    for (const slide of payload.slides ?? []) {
      if (typeof slide.html === 'string') slide.html = prefixDeckAssets(slide.html);
    }
  }
  return JSON.stringify(payload);
}

async function mediaPathAllowed(pathname) {
  let root, file;
  const artifact = pathname.match(/^\/workbench\/api\/files\/(.+)$/);
  const audio = pathname.match(/^\/workbench\/api\/decks\/([^/]+)\/assets\/(.+)$/);
  if (artifact) {
    root = join(app, '.lattice/generated');
    let requested = decodeURIComponent(artifact[1]);
    if (requested.startsWith('.lattice/generated/')) requested = requested.slice('.lattice/generated/'.length);
    if (isAbsolute(requested)) return false;
    file = resolve(root, requested);
  } else if (audio) {
    const deck = decodeURIComponent(audio[1]);
    if (!deck || deck === '.' || deck === '..' || /[/\\\0]/.test(deck)) return false;
    root = resolve(app, config.decksDir, deck);
    file = resolve(root, decodeURIComponent(audio[2]));
  } else return true;
  try {
    // The reused APIs perform lexical containment. Enforce real containment
    // here as well, so a generated/audio symlink cannot expose another file.
    const inside = relative(await realpath(root), await realpath(file));
    return inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside);
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return true; // The app returns its normal missing-file response.
    return false;
  }
}

const server = createServer(async (request, response) => {
  let pathname;
  try { pathname = decodeURIComponent(new URL(request.url, 'http://slides.invalid').pathname); }
  catch { response.writeHead(400); response.end('Invalid path.'); return; }
  if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(part => part.startsWith('.')) || /^\/@/.test(pathname)) return notFound(request, response);
  // The edge strips /apps/slides; accepting it here also makes direct smoke
  // checks useful without exposing a second path to a different application.
  if (publicBase && (pathname === publicBase || pathname.startsWith(`${publicBase}/`))) {
    const url = new URL(request.url, 'http://slides.invalid');
    request.url = `${url.pathname.slice(publicBase.length) || '/'}${url.search}`;
    pathname = pathname.slice(publicBase.length) || '/';
  }
  if (pathname === '/health' && ['GET', 'HEAD'].includes(request.method)) {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(request.method === 'HEAD' ? undefined : '{"status":"ok","app":"slides"}');
    return;
  }
  if (pathname.startsWith('/_business/') || pathname.startsWith('/_viewer/')) {
    const business = pathname.startsWith('/_business/');
    request.url = request.url.slice(business ? '/_business'.length : '/_viewer'.length) || '/';
    return sendStatic(business ? staticBusiness : staticViewer, request, response);
  }
  try { if (!(await mediaPathAllowed(pathname))) return notFound(request, response); }
  catch { response.writeHead(400); response.end('Invalid path.'); return; }
  if (pathname.startsWith('/_workbench/')) {
    if (!['/_workbench/app.js', '/_workbench/app.css'].includes(pathname)) return notFound(request, response);
    request.url = `/${pathname.slice('/_workbench/'.length)}`;
    return sendStatic(staticWorkbench, request, response);
  }
  const originalEnd = response.end;
  const originalWriteHead = response.writeHead;
  let explicitType = '';
  response.writeHead = function (...args) {
    const headers = args[typeof args[1] === 'string' ? 2 : 1];
    if (headers && !Array.isArray(headers)) {
      for (const [name, value] of Object.entries(headers)) {
        if (name.toLowerCase() === 'content-type') explicitType = String(value);
      }
    }
    return originalWriteHead.apply(this, args);
  };
  const isHead = request.method === 'HEAD';
  response.end = function (body, encoding, callback) {
    try {
      const type = explicitType || String(response.getHeader('Content-Type') || '');
      if (body != null && type.includes('text/html')) body = adaptHtml(Buffer.isBuffer(body) ? body.toString('utf8') : String(body));
      else if (body != null && type.includes('application/json') && (pathname === '/lattice/portal/decks' || /^\/workbench\/api\/decks\/[^/]+\/descriptor$/.test(pathname))) body = adaptJson(String(body), pathname);
    } catch (error) {
      console.error(`Slides response adaptation failed: ${error.message}`);
      response.destroy();
      return this;
    }
    return originalEnd.call(this, isHead ? undefined : body, encoding, callback);
  };
  if (isHead && (pathname === '/' || pathname.startsWith('/workbench') || pathname.startsWith('/lattice/portal/'))) request.method = 'GET';
  let index = 0;
  const next = error => {
    if (error) {
      console.error(`Slides middleware failed: ${error.message}`);
      if (response.headersSent) { response.destroy(); return; }
      response.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Unable to serve Slides.');
      return;
    }
    const layer = layers[index++];
    if (!layer) return sendStatic(staticViewer, request, response);
    if (layer.route && pathname !== layer.route && !pathname.startsWith(`${layer.route}/`)) return next();
    const previousUrl = request.url;
    if (layer.route) {
      request.url = request.url.slice(layer.route.length) || '/';
      if (request.url.startsWith('?')) request.url = `/${request.url}`;
    }
    try {
      Promise.resolve(layer.handler(request, response, error => { request.url = previousUrl; next(error); })).catch(error => { request.url = previousUrl; next(error); });
    } catch (error) { request.url = previousUrl; next(error); }
  };
  next();
});
server.on('error', error => { console.error(`Public Slides failed: ${error.message}`); process.exitCode = 1; });
server.listen(port, process.env.HOST || '0.0.0.0', () => console.log(`Public Slides listening on http://${process.env.HOST || '0.0.0.0'}:${port} for ${publicBase}/`));
