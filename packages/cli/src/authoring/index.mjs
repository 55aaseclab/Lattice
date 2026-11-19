import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { listTemplates, loadTemplateModule, getTemplate } from '../templates/library/index.js';
import { SLIDE_CANVAS, THEME_VERSION, palettes, defaultPalette, TECHNICAL_BLOCKS, simpleLightBlocks } from '@55aaseclab/lattice-runtime/themes/simple-light';
import { STOP_REVEAL_PRESET_CATALOG, validateStopRevealAnimation } from '@55aaseclab/lattice-runtime/themes/simple-light/presets';
import { validateDeckManifestV2 } from '@55aaseclab/lattice-runtime/deck-v2';
import { resolveTimeline } from '@55aaseclab/lattice-runtime/timeline';
import { layoutSchema, layoutFields, supportedLayouts, originalLayouts, safeTemplateContent, nodeSchema } from './content.mjs';
import { describeInput } from './json-schema.mjs';
import {DATA_VISUAL_CATALOG,validateDataChart,validateDataDiagram,validateDataShape} from '@55aaseclab/lattice-runtime/data-visuals';

export const NATIVE_ADAPTER_VERSION = 1;
const repositoryRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const extensionPath = fileURLToPath(new URL('./content.mjs', import.meta.url));
const slug = /^[a-z0-9][a-z0-9-]*$/;
const fail = (message, fieldErrors) => { throw Object.assign(new Error(message), { code: 'INVALID_INPUT', status: 400, ...(fieldErrors?.length ? { fieldErrors: fieldErrors.slice(0, 20) } : {}) }); };
const clean = value => JSON.parse(JSON.stringify(value));
const hash = value => createHash('sha256').update(value).digest('hex');
const basicBlockParameters = {
  group: ['text', 'children'], textbox: ['text', 'children', 'name'], table: ['head', 'rows', 'caption', 'compact', 'name'], image: ['assetId', 'alt', 'caption', 'fit'],
  positioned: ['text', 'children', 'anchor', 'region', 'name'], positionedTextbox: ['text', 'children', 'anchor', 'region', 'name'], positionedGroup: ['text', 'children', 'anchor', 'region', 'name'],
  grid: ['columns', 'rows', 'gap', 'margin', 'cells', 'name'], gridCell: ['col', 'row', 'colSpan', 'rowSpan', 'text', 'children', 'fit', 'name'],
};

export function getNativeSlotGuidance(templateId) {
  const meta = getTemplate(typeof templateId === 'object' ? templateId.templateId : templateId).meta;
  const originals = [...originalLayouts, ...(meta.id === 'stage-table' ? ['stage-table'] : meta.id === 'vuln-explainer' ? ['hook', 'concept', 'mechanism', 'evidence', 'impact', 'score', 'fix-status', 'takeaways'] : [])];
  return {
    templateId: meta.id,
    slots: clean(meta.slots ?? []),
    budgets: clean(meta.budgets ?? null),
    layouts: Object.fromEntries(supportedLayouts(meta.id).map(layout => [layout, { fields: layoutFields(layout), source: originals.includes(layout) ? 'original-template' : 'native-extension', required: Object.entries(layoutSchema(layout).shape).filter(([key, schema]) => !schema.isOptional()).map(([key]) => key), inputSchema: describeInput(layoutSchema(layout), { node: nodeSchema, active: new Set([nodeSchema]), reference: 'urn:lattice:authoring:node:v1' }) }])),
    nodes: { basic: Object.entries(basicBlockParameters).map(([name, params]) => ({ name, params })), technical: clean(TECHNICAL_BLOCKS.blocks).map(block => block.name === 'reveal' ? { ...block, params: ['stop', 'children'] } : block), dataVisuals:clean(DATA_VISUAL_CATALOG), inputSchema: { $id: 'urn:lattice:authoring:node:v1', $defs: { node: describeInput(nodeSchema, { node: nodeSchema }) }, $ref: '#/$defs/node' }, input: 'Strict typed JSON nodes with kind and listed parameters; no HTML, CSS, JavaScript, class names or external image URLs.' },
  };
}

export function getNativeCatalog() {
  return {
    schema: 'lattice.authoring.catalog.v1', adapterVersion: NATIVE_ADAPTER_VERSION,
    canvas: clean(SLIDE_CANVAS), theme: { id: 'simple-light', version: THEME_VERSION },
    templates: listTemplates().map(({ meta }) => ({ ...clean(meta), guidance: getNativeSlotGuidance(meta.id) })),
    palettes: clean(palettes), defaultPalette, presets: clean(STOP_REVEAL_PRESET_CATALOG),
    basicBlocks: Object.keys(simpleLightBlocks), technicalBlocks: clean(TECHNICAL_BLOCKS), dataVisuals:clean(DATA_VISUAL_CATALOG),
  };
}

function normalizedVars({ templateId, deckId, title, templateVars, ...rest }) {
  if (!slug.test(deckId) || deckId.length > 100) fail('Deck ID must be a stable slug.');
  const vars = { ...rest, ...templateVars, deckId, title: title ?? deckId };
  for (const key of Object.keys(vars)) if (!['deckId', 'title', 'owner', 'presenter', 'description', 'stages'].includes(key)) fail(`Unknown template variable: ${key}.`);
  for (const key of ['title', 'owner', 'presenter', 'description']) if (vars[key] !== undefined && (typeof vars[key] !== 'string' || vars[key].length > 1000)) fail(`Template variable ${key} must be a short string.`);
  if (vars.stages !== undefined && (!Number.isInteger(vars.stages) || vars.stages < 1 || vars.stages > 8)) fail('Stage count must be an integer between one and eight.');
  return vars;
}

async function originalScaffold(input) {
  const { scaffold } = await loadTemplateModule(input.templateId);
  const vars = normalizedVars(input);
  const result = scaffold(vars);
  const protectedFiles = Object.fromEntries(Object.entries(result.files).filter(([name]) => !['content.js', 'notes.js', 'manifest.json'].includes(name)));
  return { ...result, vars, templateIdentity: { templateId: input.templateId, scaffoldSha256: hash(JSON.stringify(protectedFiles)), adapterVersion: NATIVE_ADAPTER_VERSION, themeVersion: THEME_VERSION } };
}

function nativeManifest(document, originalFiles) {
  const original = JSON.parse(originalFiles['manifest.json']);
  const manifest = { ...original, ...clean(document.manifest ?? {}), id: document.deckId, title: document.title, entry: original.entry, theme: original.theme, canvas: original.canvas, routes: { main: document.content.slides.map(slide => slide.id) } };
  if (document.timeline !== undefined) manifest.timeline = clean(document.timeline);
  return manifest;
}

async function withViteWorkspace(files, callback) {
  const root = await mkdtemp(join(tmpdir(), 'lattice-native-'));
  let server;
  try {
    await symlink(join(repositoryRoot, 'node_modules'), join(root, 'node_modules'));
    for (const [name, value] of Object.entries(files)) {
      if (name.includes('..') || name.startsWith('/')) throw new Error('Unexpected trusted scaffold path.');
      await mkdir(dirname(join(root, name)), { recursive: true });
      await writeFile(join(root, name), value);
    }
    server = await createServer({ configFile: false, root, publicDir: false, appType: 'custom', logLevel: 'silent', cacheDir: join(root, '.vite'), server: { middlewareMode: true }, ssr: { noExternal: ['@55aaseclab/lattice-runtime'] } });
    return await callback({ root, files, server });
  } finally { await server?.close(); await rm(root, { recursive: true, force: true }); }
}

export async function scaffoldNative(input) {
  const result = await originalScaffold(input);
  const defaults = await withViteWorkspace(result.files, async ({ server }) => ({ content: clean((await server.ssrLoadModule('/content.js')).default), notes: clean((await server.ssrLoadModule('/notes.js')).default) }));
  return { templateId: input.templateId, templateVars: Object.fromEntries(Object.entries(result.vars).filter(([key]) => !['deckId', 'title'].includes(key))), ...defaults, manifest: JSON.parse(result.files['manifest.json']), templateIdentity: result.templateIdentity };
}

function validateJson(value, depth = 0, count = { value: 0 }) {
  if (depth > 16 || ++count.value > 25000) fail('Native content exceeds the structural limit.');
  if (value === null || ['string', 'boolean'].includes(typeof value)) return;
  if (typeof value === 'number' && Number.isFinite(value)) return;
  if (!value || typeof value !== 'object' || !Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) fail('Native content must contain plain JSON values.');
  for (const [key, child] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) fail('Unsafe native content key.');
    validateJson(child, depth + 1, count);
  }
}

export async function validateNative(document) {
  if (!document || !slug.test(document.deckId ?? '')) fail('Deck ID must be a stable slug.');
  normalizedVars({ templateId: document.templateId, deckId: document.deckId, title: document.title, templateVars: document.templateVars });
  const guidance = getNativeSlotGuidance(document.templateId);
  const content = document.content;
  validateJson(content);
  if (!content || !Array.isArray(content.slides) || !content.slides.length || content.slides.length > 100) fail('A deck must contain one to one hundred slides.');
  for (const key of Object.keys(content)) if (!['slides', 'slotGuidance', 'guidance'].includes(key)) fail(`Unknown content field: ${key}.`);
  const ids = new Set();
  for (const [index, slide] of content.slides.entries()) {
    if (!slide || typeof slide !== 'object' || Array.isArray(slide)) fail('Invalid native slide.', [{ path: ['content','slides',index], code: 'invalid_type' }]);
    if (!Object.hasOwn(guidance.layouts, slide.layout)) fail('The native slide layout is unsupported.', [{ path: ['content','slides',index,'layout'], code: 'invalid_enum_value' }]);
    const result = layoutSchema(slide.layout).safeParse(slide);
    if (!result.success) fail('Invalid native slide content.', result.error.issues.slice(0,20).map(issue => ({ path: ['content','slides',index,...issue.path], code: issue.code })));
    if (ids.has(slide.id)) fail('Slide IDs must be unique.');
    ids.add(slide.id);
    if (slide.stops && new Set(slide.stops).size !== slide.stops.length) fail('Stop IDs must be unique within a slide.');
    const stops = new Set(slide.stops ?? ['static']);
    const inspectNodes = value => {
      if (!value || typeof value !== 'object') return;
      if (['chart','diagram','shape'].includes(value.kind)) {
        const {kind,...parameters}=value;
        try { ({chart:validateDataChart,diagram:validateDataDiagram,shape:validateDataShape})[kind](parameters); }
        catch(error){fail(error.message);}
      }
      if (value.kind === 'grid') for (const cell of value.cells) if (cell.col + (cell.colSpan ?? 1) - 1 > value.columns || cell.row + (cell.rowSpan ?? 1) - 1 > value.rows) fail('A native grid cell exceeds its declared tracks.');
      for (const [key, child] of Object.entries(value)) {
        if (['stop', 'reveal', 'analogyStop', 'termsStop', 'tableReveal'].includes(key) && typeof child === 'string' && !stops.has(child)) fail('A reveal must reference a declared slide stop.');
        if (child && typeof child === 'object') inspectNodes(child);
      }
    };
    inspectNodes(slide);
  }
  if (document.notes !== undefined) {
    validateJson(document.notes);
    if (!document.notes || Array.isArray(document.notes) || typeof document.notes !== 'object') fail('Notes must be keyed by slide ID.');
    for (const [id, note] of Object.entries(document.notes)) if (!ids.has(id) || typeof note !== 'string' || note.length > 20000) fail('Notes require a known slide ID and plain text.');
  }
  if (document.paletteId !== undefined && !palettes.some(palette => palette.id === document.paletteId)) fail('Unknown native palette.');
  const inspectPaths = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'src' && (typeof child !== 'string' || !/^\.\/assets\/audio\/[a-z0-9][a-z0-9-]*\.(?:wav|mp3|ogg|m4a)$/.test(child))) fail('Media sources must be authorized materialized audio assets.');
      if (child && typeof child === 'object') inspectPaths(child);
    }
  };
  inspectPaths(document.timeline); inspectPaths(document.manifest?.timeline);
  if (document.manifest?.assets !== undefined && document.manifest.assets !== './assets.json') fail('The native asset manifest must use the managed asset path.');
  for (const key of ['sources', 'references']) if (typeof document.manifest?.[key] === 'string' && document.manifest[key] !== `./${key}.json`) fail('Native reference files must use managed paths.');
  const original = await originalScaffold({ templateId: document.templateId, deckId: document.deckId, title: document.title, templateVars: document.templateVars });
  const manifest = nativeManifest(document, original.files);
  const definitions = content.slides.map(slide => ({ id: slide.id, html: '', durationFrames: Math.max(1, slide.stops?.length ?? 1), stops: (slide.stops ?? ['static']).map((id, frame) => ({ id, frame })) }));
  const manifestReport = validateDeckManifestV2(manifest, { expectedId: document.deckId, slideIds: [...ids] });
  if (!manifestReport.ok) fail(manifestReport.errors.map(issue => issue.message).join('; '));
  const timelineReport = resolveTimeline({ manifest, slides: definitions, presetCatalog: STOP_REVEAL_PRESET_CATALOG, validateAnimation: validateStopRevealAnimation });
  if (!timelineReport.ok) fail(timelineReport.errors.map(issue => issue.message).join('; '));
  return { ok: true };
}

export async function materializeNativeWorkspace(document, { includeNotes = false, assetUrl, callback, directory } = {}) {
  await validateNative(document);
  const original = await originalScaffold({ templateId: document.templateId, deckId: document.deckId, title: document.title, templateVars: document.templateVars });
  const content = safeTemplateContent(document.content, assetUrl);
  const manifest = nativeManifest(document, original.files);
  const notes = includeNotes ? clean(document.notes ?? {}) : {};
  const renderNotes = Object.fromEntries(Object.entries(notes).map(([id, note]) => [id, String(note).replace(/[&<>]/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[character])]));
  const files = { ...original.files, 'manifest.json': `${JSON.stringify(manifest, null, 2)}\n`, 'content.js': `export default ${JSON.stringify(content)};\n`, 'notes.js': `export default ${JSON.stringify(notes)};\n`, 'render-notes.js': `export default ${JSON.stringify(renderNotes)};\n` };
  const registryImport = original.registryImport.replace(`"./${document.deckId}/slides.js"`, '"./slides.js"');
  files['native-registry.mjs'] = `${registryImport}\nconst registry={${original.registryEntry}};\nexport default registry[${JSON.stringify(document.deckId)}];\n`;
  // Native narration and fingerprints read canonical notes.js. Only the trusted HTML sink uses escaped notes.
  files['slides.js'] = files['slides.js'].replace('import notes from "./notes.js";', 'import notes from "./render-notes.js";');
  const extensions = `import {nativeLayoutRenderers} from ${JSON.stringify(extensionPath)};\nfor(const [name,render] of Object.entries(nativeLayoutRenderers))if(!Object.hasOwn(RENDERERS,name))RENDERERS[name]=render;\n`;
  files['slides.js'] = files['slides.js'].replace('export function buildSlides()', `${extensions}\nexport function buildSlides()`);
  if (directory) {
    await mkdir(directory, { recursive: true });
    for (const [name, value] of Object.entries(files)) await writeFile(join(directory, name), value);
    return { directory, files, manifest, templateIdentity: original.templateIdentity };
  }
  if (typeof callback === 'function') return withViteWorkspace(files, context => callback({ ...context, manifest, templateIdentity: original.templateIdentity }));
  return { files, manifest, templateIdentity: original.templateIdentity };
}

export async function projectNative(document, { includeNotes = false, assetUrl } = {}) {
  return materializeNativeWorkspace(document, { includeNotes, assetUrl, callback: async ({ server, files, manifest, templateIdentity }) => {
    const { slideDefinitions } = await server.ssrLoadModule('/slides.v2.js');
    const metadata = (await server.ssrLoadModule('/native-registry.mjs')).default;
    const manifestReport = validateDeckManifestV2(manifest, { expectedId: document.deckId, slideIds: slideDefinitions.map(slide => slide.id) });
    if (!manifestReport.ok) fail(manifestReport.errors.map(issue => issue.message).join('; '));
    const resolved = resolveTimeline({ manifest, slides: slideDefinitions, presetCatalog: STOP_REVEAL_PRESET_CATALOG, validateAnimation: validateStopRevealAnimation });
    if (!resolved.ok) fail(resolved.errors.map(issue => issue.message).join('; '));
    const timingById = new Map((resolved.timeline?.slides ?? []).map(slide => [slide.slideId, slide]));
    return {
      id: document.deckId, title: document.title, revision: document.revision, canvas: clean(manifest.canvas), manifest,
      paletteId: document.paletteId ?? defaultPalette, templateIdentity, timeline: clean(resolved.timeline),
      owner: metadata.owner, presenter: metadata.presenter, description: metadata.description,
      styles: files['styles.css'] ?? '',
      slideDefinitions: clean(slideDefinitions.map(slide => {
        const timing = timingById.get(slide.id);
        return { ...slide, ...(timing ? { durationFrames: timing.durationFrames, stops: timing.stops, animation: timing.animation } : {}), notes: includeNotes ? document.notes?.[slide.id] ?? '' : '' };
      })),
    };
  } });
}

export { nodeSchema };
export { buildProvenanceRecord } from '../edit/provenance.js';
export { getNativeMediaCatalog, validateAudienceReview } from './media.mjs';
