import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, readdir, access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { presentationWarnings } from './compiler.mjs';
import { projectNative, validateNative } from '@55aaseclab/lattice-cli/authoring';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const appRequire = createRequire(join(appRoot, 'package.json'));
let bundlePromise;
const captureCss = '.app-menu,.meta-panel,.slide-notes-panel{display:none!important}.app-shell,.deck-runtime{display:block!important;width:100vw!important;height:100vh!important;padding:0!important;margin:0!important}.reveal{position:absolute!important;inset:0!important;width:100vw!important;height:100vh!important}.slide-canvas{border:0!important}';

async function runtimeBundle() {
  bundlePromise ??= (async () => {
    const temporary = await mkdtemp(join(tmpdir(), 'lattice-business-runtime-'));
    try {
      await symlink(join(appRoot, 'node_modules'), join(temporary, 'node_modules'));
      const entry = join(temporary, 'runtime.mjs');
      const source = `import {bootDeckPortal,exportDeckAsPptx} from '@55aaseclab/lattice-runtime/renderer';
import '@55aaseclab/lattice-runtime/themes/simple-light/styles.css';
import {palettes,defaultPalette} from '@55aaseclab/lattice-runtime/themes/simple-light';
import {inspectRenderedDeck,waitForRenderReadiness} from '@55aaseclab/lattice-runtime/inspect';
import {createSlideRuntime} from '@55aaseclab/lattice-runtime/slide-runtime';
import {hydrateProjection,installProjectionStyles} from ${JSON.stringify(fileURLToPath(new URL('./compiler.mjs', import.meta.url)))};
let active;
export async function mount(projection,assets,settings={}){
 window.__businessStage='compile';
 const urls=new Map(assets.map(asset=>[asset.id,'data:'+asset.mimeType+';base64,'+asset.data]));
 const deck=hydrateProjection(projection,{includeNotes:settings.includeNotes===true,assetUrl:id=>urls.get(id)});
 installProjectionStyles(projection);
 active=deck;
 const locationUrl=new URL(window.location.href);if(!locationUrl.searchParams.has('deck')){locationUrl.searchParams.set('deck',deck.id);window.history.replaceState(null,'',locationUrl.href)}
 window.__businessStage='portal';bootDeckPortal({deckRegistry:{[deck.id]:deck},deckList:[deck],themes:palettes,defaultTheme:deck.paletteId||defaultPalette,enablePptx:false,enablePdf:false});
 if(locationUrl.searchParams.has('print-pdf')){window.__businessStage='pdf-ready';await new Promise((resolve,reject)=>{const start=Date.now();const poll=()=>{if(window.document.documentElement.dataset.pdfExportReady==='true')return resolve();if(Date.now()-start>15000)return reject(new Error('Native PDF readiness timed out.'));setTimeout(poll,30)};poll()});window.__businessReady=true;return}
 window.__businessStage='reveal-ready';
 await new Promise((resolve,reject)=>{const start=Date.now();const poll=()=>{if(window.__latticeReveal?.isReady())return resolve();if(Date.now()-start>15000)return reject(new Error('Lattice readiness timed out.'));setTimeout(poll,30)};poll()});
 window.__businessStage='resources-ready';await waitForRenderReadiness(window.document.querySelector('.slides'),{timeout:15000});
 window.__businessSlideRuntimes=[];
 const canvases=window.document.querySelectorAll('.slides>.slide-canvas');
 window.__businessStage='slide-runtime';for(let i=0;i<canvases.length;i++){const specification=deck.slideDefinitions[i];const runtime=createSlideRuntime({slide:{...specification,html:canvases[i].innerHTML},container:canvases[i]});await runtime.ready();await runtime.seek(specification.durationFrames-1);window.__businessSlideRuntimes.push(runtime)}
 window.__businessStage='ready';
 window.__businessReady=true;
}
export async function showSlide(index,stopId){
 const slide=active.slideDefinitions[index];
 let frame=slide.durationFrames-1;
 if(stopId){const stop=slide.stops.find(value=>value.id===stopId);if(!stop)throw new Error('Unknown stop ID.');frame=stop.frame}
 window.__latticeReveal.slide(index);await window.__businessSlideRuntimes[index].seek(frame);await window.__businessSlideRuntimes[index].painted(frame);
}
export async function inspect(){return inspectRenderedDeck(window.document.querySelector('.slides'))}
export async function exportPptx(){return exportDeckAsPptx({title:active.title})}
`;
      await writeFile(entry, source);
      const cliRequire = createRequire(appRequire.resolve('@55aaseclab/lattice-cli/package.json'));
      const { build } = await import(pathToFileURL(cliRequire.resolve('vite')).href);
      const result = await build({ configFile: false, root: temporary, publicDir: false, logLevel: 'error', build: { write: false, minify: true, assetsInlineLimit: Number.MAX_SAFE_INTEGER, cssCodeSplit: false, lib: { entry, name: 'LatticeBusinessRuntime', fileName: 'runtime', cssFileName: 'runtime', formats: ['iife'] } } });
      const output = (Array.isArray(result) ? result : [result]).flatMap(item => item.output);
      return { javascript: output.filter(item => item.type === 'chunk').map(item => item.code).join('\n'), css: output.filter(item => item.type === 'asset' && item.fileName.endsWith('.css')).map(item => item.source).join('\n') };
    } finally { await rm(temporary, { recursive: true, force: true }); }
  })().catch(error => { bundlePromise = undefined; throw error; });
  return bundlePromise;
}

export async function resolveBrowserExecutable() {
  for (const file of [process.env.LATTICE_CHROMIUM, process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].filter(Boolean)) {
    try { await access(file, constants.X_OK); return file; } catch {}
  }
  for (const directory of [process.env.PLAYWRIGHT_BROWSERS_PATH, join(homedir(), '.cache/ms-playwright')].filter(Boolean)) {
    let names = []; try { names = (await readdir(directory)).filter(name => /^chromium(?:_headless_shell)?-\d+$/.test(name)).sort().reverse(); } catch {}
    for (const name of names) for (const relative of ['chrome-headless-shell-linux64/chrome-headless-shell', 'chrome-headless-shell-linux/chrome-headless-shell', 'chrome-linux64/chrome', 'chrome-linux/chrome']) {
      const file = join(directory, name, relative); try { await access(file, constants.X_OK); return file; } catch {}
    }
  }
  throw Object.assign(new Error('Chromium is unavailable.'), { code: 'RENDERER_UNAVAILABLE' });
}

function safeJson(value) { return JSON.stringify(value).replace(/</g, '\\u003c'); }
function htmlDocument(document, assets, bundle, settings) {
  return `<!doctype html><html lang="${document.language === 'en' ? 'en' : 'zh-CN'}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none';script-src 'unsafe-inline';style-src 'unsafe-inline';font-src data:;img-src data:;connect-src 'none';base-uri 'none';form-action 'none'"><title>Slides</title><style>${bundle.css.replace(/<\/style/gi, '<\\/style')}</style><div id="app"></div><script>${bundle.javascript.replace(/<\/script/gi, '<\\/script')}</script><script>LatticeBusinessRuntime.mount(${safeJson(document)},${safeJson(assets)},${safeJson(settings)}).catch(error=>{const message=String(error?.message||'');const reason=/not defined/.test(message)?'MISSING_GLOBAL':/is not a function/.test(message)?'RUNTIME_API_MISMATCH':/Unknown|unknown/.test(message)?'UNKNOWN_REFERENCE':/animation|preset/.test(message)?'INVALID_ANIMATION':/ready|resource|font/i.test(message)?'READINESS_FAILED':'RUNTIME_FAILURE';window.__businessFailure={stage:window.__businessStage||'bootstrap',name:['Error','TypeError','ReferenceError','RangeError'].includes(error?.name)?error.name:'Error',reason};window.__businessFailed=true});</script></html>`;
}

function subset(document, slideIds) {
  if (!slideIds) return document;
  const ids = new Set(slideIds);
  if (!slideIds.length || slideIds.some(id => !document.content.slides.some(slide => slide.id === id))) throw Object.assign(new Error('Unknown slide selection.'), { code: 'INVALID_INPUT' });
  const slides = document.content.slides.filter(slide => ids.has(slide.id));
  const notes = Object.fromEntries(Object.entries(document.notes ?? {}).filter(([id]) => ids.has(id)));
  const manifest = structuredClone(document.manifest ?? {});
  if (manifest.timeline?.slides) manifest.timeline.slides = Object.fromEntries(Object.entries(manifest.timeline.slides).filter(([id]) => ids.has(id)));
  const timeline = structuredClone(document.timeline);
  if (timeline?.slides) timeline.slides = Object.fromEntries(Object.entries(timeline.slides).filter(([id]) => ids.has(id)));
  return { ...document, content: { ...document.content, slides }, notes, manifest, ...(timeline ? { timeline } : {}) };
}

export function createRenderer({ executablePath, launchOptions = {} } = {}) {
  return async function render({ kind, document: original, options = {}, assets = [], signal, authAbortSignal }) {
    const abortSignal = signal ?? authAbortSignal;
    const ensureActive = () => { if (abortSignal?.aborted) throw Object.assign(new Error('Render operation was cancelled.'), { code: 'JOB_CANCELLED' }); };
    ensureActive();
    const document = subset(structuredClone(original), options.slideIds);
    if (kind !== 'export' || options.includeNotes !== true) document.notes = {};
    const slideOrder = document.content.slides.map(slide => slide.id);
    const format = kind === 'export' ? options.format : kind === 'check' ? 'json' : 'png';
    if (!['preview', 'check', 'export'].includes(kind) || !['png', 'html', 'pdf', 'pptx', 'json'].includes(format)) throw Object.assign(new Error('Unsupported render operation.'), { code: 'UNSUPPORTED_CAPABILITY' });
    const warnings = presentationWarnings(document, format);
    if (options.requireEditable && warnings.length) throw Object.assign(new Error('This presentation contains elements that cannot be exported as editable objects.'), { code: 'EDITABLE_EXPORT_UNSUPPORTED' });
    const imageAssets = assets.map(asset => ({ id: asset.id ?? asset.assetId, mimeType: asset.mimeType, data: typeof asset.data === 'string' && !asset.buffer ? asset.data : Buffer.from(asset.buffer ?? asset.data ?? []).toString('base64') }));
    if (kind === 'check' && options.rendered === false) {
      const issues = [];
      try { await validateNative(document); await projectNative(document); }
      catch (error) { issues.push({ type: 'invalid-document', message: error.message, slideId: '', elementId: '', severity: 'error' }); }
      return { artifacts: [{ buffer: Buffer.from(JSON.stringify({ ok: !issues.length, issues, revision: document.revision, slides: slideOrder.length })), mimeType: 'application/json', format: 'json', fileName: `${document.deckId}-inspection.json` }], issues, fidelityWarnings: [] };
    }
    const projection = await projectNative(document, { includeNotes: kind === 'export' && options.includeNotes === true });
    const bundle = await runtimeBundle();
    ensureActive();
    const html = htmlDocument(projection, imageAssets, bundle, { includeNotes: kind === 'export' && options.includeNotes === true });
    if (format === 'html') return { artifacts: [{ buffer: Buffer.from(html), mimeType: 'text/html', format: 'html', fileName: `${document.deckId}.html` }], issues: [], fidelityWarnings: warnings };
    const server = createServer((request, response) => { response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); response.end(html); });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${server.address().port}/?deck=${encodeURIComponent(document.deckId)}`;
    const cliRequire = createRequire(appRequire.resolve('@55aaseclab/lattice-cli/package.json'));
    const playwright = await import(pathToFileURL(cliRequire.resolve('playwright-core')).href);
    const { chromium } = playwright.default ?? playwright;
    let browser, browserState, stage = 'browser-profile', failureLogged = false;
    const onAbort = () => { browser?.close().catch(() => {}); };
    abortSignal?.addEventListener('abort', onAbort, { once: true });
    try {
      browserState = await mkdtemp(join(tmpdir(), 'lattice-business-browser-'));
      for (const name of ['config', 'cache', 'runtime']) await mkdir(join(browserState, name), { mode: 0o700 });
      stage = 'browser-launch';
      browser = await chromium.launch({
        executablePath: executablePath ?? await resolveBrowserExecutable(), headless: true,
        args: ['--no-sandbox', '--disable-dev-shm-usage'], ...launchOptions,
        env: { ...process.env, ...launchOptions.env, XDG_CONFIG_HOME: join(browserState, 'config'), XDG_CACHE_HOME: join(browserState, 'cache'), XDG_RUNTIME_DIR: join(browserState, 'runtime') },
      });
      ensureActive();
      const width = options.width === '960' ? 960 : 1280;
      const page = await browser.newPage({ viewport: { width, height: width * 9 / 16 }, deviceScaleFactor: 1, acceptDownloads: true });
      const failures = [];
      page.on('pageerror', error => failures.push({ type: 'page-error', message: error.message }));
      await page.route('**/*', route => { const target = route.request().url(); return target.startsWith(url.split('/?')[0]) || target.startsWith('data:') || target.startsWith('blob:') ? route.continue() : route.abort(); });
      await page.addInitScript(() => { window.print = () => {}; });
      stage = 'page-mount';
      await page.goto(url, { waitUntil: 'load', timeout: 30000 });
      await page.waitForFunction(() => window.__businessReady || window.__businessFailed, { timeout: 30000 });
      if (await page.evaluate(() => window.__businessFailed)) {
        const failure = await page.evaluate(() => window.__businessFailure);
        process.stderr.write(`${JSON.stringify({ event: 'slides_render_failed', ...failure })}\n`);
        failureLogged = true;
        throw Object.assign(new Error('Lattice rendering failed.'), { code: 'RENDER_FAILED', renderStage: failure?.stage, reason: failure?.reason });
      }
      await page.addStyleTag({ content: captureCss });
      await page.evaluate(() => { window.__latticeReveal.configure({ width: 960, height: 540, margin: 0, minScale: 0.1, maxScale: 2 }); window.__latticeReveal.layout(); });
      stage = 'inspection';
      const report = await page.evaluate(() => LatticeBusinessRuntime.inspect());
      const issues = [...(report.errors ?? []), ...failures].map(issue => ({ type: issue.type, message: issue.message, slideId: String(issue.slide ?? ''), elementId: String(issue.element ?? ''), severity: 'error' }));
      const artifacts = [];
      stage = 'artifact';
      if (kind === 'check') artifacts.push({ buffer: Buffer.from(JSON.stringify({ ok: !issues.length, issues, revision: document.revision, slides: slideOrder.length })), mimeType: 'application/json', format: 'json', fileName: `${document.deckId}-inspection.json` });
      else if (format === 'png') for (const [index, id] of slideOrder.entries()) {
        ensureActive();
        await page.evaluate(({ index, stopId }) => LatticeBusinessRuntime.showSlide(index, stopId), { index, stopId: options.stopId });
        artifacts.push({ buffer: await page.screenshot({ type: 'png', animations: 'disabled' }), mimeType: 'image/png', format: 'png', fileName: `${id}.png`, slideId: id });
      } else if (format === 'pdf') {
        stage = 'native-pdf';
        const printUrl = new URL(url); printUrl.searchParams.set('export', 'pdf-renderer'); printUrl.searchParams.set('print-pdf', '1');
        await page.goto(printUrl.href, { waitUntil: 'load', timeout: 30000 });
        await page.waitForFunction(() => window.__businessReady || window.__businessFailed, { timeout: 30000 });
        if (await page.evaluate(() => window.__businessFailed)) throw Object.assign(new Error('Native PDF rendering failed.'), { code: 'RENDER_FAILED' });
        const buffer = await page.pdf({ printBackground: true, preferCSSPageSize: true, width: '960px', height: '540px', margin: { top: '0', right: '0', bottom: '0', left: '0' } });
        const actualPages = (buffer.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length;
        if (actualPages !== slideOrder.length) throw Object.assign(new Error('PDF page count does not match the document snapshot.'), { code: 'RENDER_FAILED', reason: 'PDF_PAGE_COUNT_MISMATCH' });
        artifacts.push({ buffer, mimeType: 'application/pdf', format: 'pdf', fileName: `${document.deckId}.pdf` });
      } else if (format === 'pptx') {
        const downloadPromise = page.waitForEvent('download', { timeout: 60000 });
        await page.evaluate(() => LatticeBusinessRuntime.exportPptx());
        const download = await downloadPromise;
        const path = await download.path();
        artifacts.push({ buffer: await readFile(path), mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', format: 'pptx', fileName: `${document.deckId}.pptx` });
      }
      ensureActive();
      return { artifacts, issues, fidelityWarnings: warnings };
    } catch (error) {
      if (!failureLogged && !abortSignal?.aborted) {
        const message = String(error?.message ?? '');
        const reason = error?.reason === 'PDF_PAGE_COUNT_MISMATCH' ? error.reason : /crashpad|--database/.test(message) ? 'BROWSER_PROFILE_UNAVAILABLE' : /EROFS|EACCES|Permission denied|Read-only file system/.test(message) ? 'FILESYSTEM_PERMISSION' : /[Tt]imeout/.test(message) ? 'TIMEOUT' : 'RUNTIME_FAILURE';
        const name = ['Error', 'TypeError', 'ReferenceError', 'RangeError', 'TimeoutError'].includes(error?.name) ? error.name : 'Error';
        process.stderr.write(`${JSON.stringify({ event: 'slides_render_failed', stage, name, reason })}\n`);
      }
      throw error;
    } finally { abortSignal?.removeEventListener('abort', onAbort); await browser?.close(); if (browserState) await rm(browserState, { recursive: true, force: true }); await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
  };
}
