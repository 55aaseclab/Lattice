import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { copyFile, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspace = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const app = resolve(process.env.PRAXIS_LATTICE_ROOT || process.env.SLIDES_PROJECT_ROOT || workspace);
const publicBase = (process.env.PUBLIC_BASE_PATH || '/apps/slides').replace(/\/$/, '');
if (!/^\/(?:[A-Za-z0-9_-]+\/?)*$/.test(publicBase) || publicBase.includes('//')) throw new Error('PUBLIC_BASE_PATH must be a safe absolute URL path.');
const viewer = resolve(app, 'dist-public-viewer');
const workbench = resolve(app, 'dist-public-workbench');
const business = resolve(app, 'dist-public-business');
const businessOnly = process.env.SLIDES_BUSINESS_VIEWER_ONLY === '1';
const appRequire = createRequire(join(app, 'package.json'));
const cliPackage = await realpath(appRequire.resolve('@55aaseclab/lattice-cli/package.json'));
const cliRequire = createRequire(cliPackage);
const ui = join(dirname(cliPackage), 'src/video/ui/app');

// Keep the normal app build and local dist independent of this public adapter.
if (!businessOnly) await new Promise((accept, reject) => {
  const child = spawn(process.execPath, [join(dirname(cliPackage), 'src/index.js'), 'build', '--out', viewer], { cwd: app, stdio: 'inherit' });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? accept() : reject(new Error(`Slides viewer build failed (${code}).`)));
});

// Only URL-bearing forms used by the existing renderer are adapted. Deck text,
// notes, identifiers, and arbitrary strings are never globally replaced.
function adaptViewerUrls(source) {
  return source
    .replace(/(["'`])\/\?deck=/g, `$1${publicBase}/?deck=`)
    .replaceAll('href="/"', `href="${publicBase}/"`)
    .replaceAll('href="/?', `href="${publicBase}/?`)
    .replace(/(\b(?:src|href)\s*[:=]\s*["'`])\/decks\//g, `$1${publicBase}/decks/`)
    .replace(/(url\(\s*["']?)\/decks\//g, `$1${publicBase}/decks/`);
}
for (const name of businessOnly ? [] : await readdir(join(viewer, 'assets'))) {
  if (!/\.(?:js|css)$/.test(name)) continue;
  const file = join(viewer, 'assets', name);
  const source = await readFile(file, 'utf8');
  const adapted = adaptViewerUrls(source);
  if (adapted !== source) await writeFile(file, adapted);
}

const { build } = await import(pathToFileURL(cliRequire.resolve('vite')).href);
const emptyRegistry = '\0praxis-empty-legacy-registry';
const emptyPresentations = '\0praxis-empty-legacy-presentations';
const registryFile = resolve(app, 'decks/registry.js');
const presentationsFile = resolve(app, 'src/presentation-decks.js');
await build({
  configFile: false,
  root: app,
  publicDir: false,
  base: `${publicBase}/_business/`,
  define: { 'import.meta.env.PRAXIS_SLIDES_API_BASE': JSON.stringify(`${publicBase}/`) },
  plugins: [{
    name: 'slides-business-only-registry', enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || source.startsWith('\0')) return;
      const file = source.startsWith('.') ? resolve(dirname(importer.split('?')[0]), source) : source;
      if (file === registryFile) return emptyRegistry;
      if (file === presentationsFile) return emptyPresentations;
      if (typeof file === 'string' && file.startsWith(`${resolve(app, 'decks')}/`)) throw new Error('Private deck modules cannot enter the business viewer.');
    },
    load(id) {
      if (id === emptyRegistry) return "import '@55aaseclab/lattice-runtime/themes/simple-light/styles.css';export const deckRegistry={};export const deckList=[];";
      if (id === emptyPresentations) return 'export const v2DeckRegistry={};';
      if (id.startsWith(`${resolve(app, 'decks')}/`)) throw new Error('Private deck modules cannot enter the business viewer.');
    },
  }],
  build: { outDir: business, emptyOutDir: true, sourcemap: false },
});
for (const name of await readdir(join(business, 'assets'))) {
  if (!/\.(?:js|css)$/.test(name)) continue;
  const file = join(business, 'assets', name);
  const source = await readFile(file, 'utf8');
  const adapted = adaptViewerUrls(source);
  if (adapted !== source) await writeFile(file, adapted);
}
let playerImportAdapted = false;
if (!businessOnly) await build({
  configFile: false,
  root: ui,
  publicDir: false,
  base: `${publicBase}/_workbench/`,
  plugins: [{
    name: 'public-workbench-player',
    transform(source, id) {
      if (id !== join(ui, 'app.js')) return;
      // The dev shell versions a computed player import. Make just that known
      // import static so Vite includes the player and runtime in the bundle.
      const original = 'import(/* @vite-ignore */ `./player.js${assetVersion}`)';
      if (!source.includes(original)) throw new Error('Workbench player import changed; update the public build adapter.');
      const artifactEncoding = 'const encoded = encodeURIComponent(artifact.path);';
      if (!source.includes(artifactEncoding)) throw new Error('Workbench artifact URL changed; update the public build adapter.');
      const previewEncoding = 'const url = apiUrl(`/files/${encodeURIComponent(relativePath)}`);';
      if (!source.includes(previewEncoding)) throw new Error('Workbench artifact preview URL changed; update the public build adapter.');
      playerImportAdapted = true;
      const artifactUrl = 'const encoded = artifact.path.replace(/^\\.lattice\\/generated\\//, "").split("/").map(encodeURIComponent).join("/");';
      const previewUrl = 'const url = apiUrl("/files/" + relativePath.replace(/^\\.lattice\\/generated\\//, "").split("/").map(encodeURIComponent).join("/"));';
      return { code: source.replace(original, 'import("./player.js")').replace(artifactEncoding, artifactUrl).replace(previewEncoding, previewUrl), map: null };
    },
  }],
  build: {
    outDir: workbench,
    emptyOutDir: true,
    sourcemap: false,
    lib: { entry: join(ui, 'app.js'), formats: ['es'], fileName: () => 'app.js' },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
if (!businessOnly && !playerImportAdapted) throw new Error('Workbench entry was not bundled.');
if (!businessOnly) {
  await mkdir(workbench, { recursive: true });
  await copyFile(join(ui, 'app.css'), join(workbench, 'app.css'));
}
for (const output of businessOnly ? [business] : [viewer, workbench, business]) {
  await writeFile(join(output, 'public-build.json'), `${JSON.stringify({ publicBase, ...(output === business ? { mode: 'business-only', apiBase: `${publicBase}/` } : {}) })}\n`);
}
console.log(`Public Slides production assets built for ${publicBase}/`);
