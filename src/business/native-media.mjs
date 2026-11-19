import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, writeFile, symlink, rm, readdir, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { materializeNativeWorkspace } from '@55aaseclab/lattice-cli/authoring';
import { validateAudienceReview } from '@55aaseclab/lattice-cli/authoring/media';
import { inputs } from './schema.mjs';

const appRoot = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(join(appRoot, 'package.json'));
const cliRoot = dirname(require.resolve('@55aaseclab/lattice-cli/package.json'));
const cli = join(cliRoot, 'src/index.js');
const MIME = { '.json': 'application/json', '.hash': 'application/json', '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.png': 'image/png', '.txt': 'text/plain; charset=utf-8', '.srt': 'application/x-subrip', '.md': 'text/markdown; charset=utf-8' };
const failure = (code, message = code, details = {}) => Object.assign(new Error(message), { code, status: 422, ...details });
const htmlText = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);

function redacted(value) {
  if (Array.isArray(value)) return value.map(redacted);
  if (!value || typeof value !== 'object') return typeof value === 'string' ? value.replace(/\/(?:home|tmp|workspace|usr|var|opt|run)\/[^\s"'<>]*/g, '[private]') : value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !['cwd', 'root', 'path', 'sourcePath', 'outputPath', 'stdout', 'stderr', 'commandLine'].includes(key)).map(([key, child]) => [key, redacted(child)]));
}

function parseOutput(text) {
  try { return JSON.parse(text); } catch {}
  const starts = [...text.matchAll(/^[{\[]/gm)].map(match => match.index);
  const first = text.indexOf('{'); if (first >= 0 && !starts.includes(first)) starts.unshift(first);
  for (const start of starts.reverse()) {
    let depth = 0, quoted = false, escaped = false;
    for (let index = start; index < text.length; index++) {
      const character = text[index];
      if (quoted) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') quoted = false;
      } else if (character === '"') quoted = true;
      else if (character === '{' || character === '[') depth++;
      else if (character === '}' || character === ']') {
        if (--depth === 0) {
          try { return JSON.parse(text.slice(start, index + 1)); } catch { break; }
        }
      }
    }
  }
  return null;
}

export function runNativeCommand(args, { cwd, signal, timeoutMs = 10 * 60_000, env = process.env, allowRefusalReport = false } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(failure('JOB_CANCELLED'));
    const child = spawn(process.execPath, [cli, ...args], { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = { stdout: [], stderr: [], bytes: 0 };
    let rejection, killTimer;
    const stop = error => {
      rejection ??= error;
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
      killTimer ??= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 1500);
      killTimer.unref();
    };
    const timer = setTimeout(() => stop(failure('NATIVE_TASK_TIMEOUT')), timeoutMs); timer.unref();
    const abort = () => stop(failure('JOB_CANCELLED'));
    signal?.addEventListener('abort', abort, { once: true });
    for (const name of ['stdout', 'stderr']) child[name].on('data', chunk => {
      output.bytes += chunk.length;
      if (output.bytes > 8 * 1024 * 1024) return stop(failure('NATIVE_OUTPUT_TOO_LARGE'));
      output[name].push(chunk);
    });
    child.on('error', error => { rejection = failure('NATIVE_RUNTIME_UNAVAILABLE'); });
    child.on('close', code => {
      clearTimeout(timer); clearTimeout(killTimer); signal?.removeEventListener('abort', abort);
      if (rejection) return reject(rejection);
      const stdout = Buffer.concat(output.stdout).toString(), stderr = Buffer.concat(output.stderr).toString();
      const report = parseOutput(stdout) ?? parseOutput(stderr);
      if (code !== 0 && !(allowRefusalReport && report && code === 1 && !report.error)) {
        const nativeCode = typeof report?.error?.code === 'string' ? report.error.code : code === 2 ? 'runtime-unavailable' : 'operation-refused';
        return reject(failure(`NATIVE_${nativeCode.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`, 'The native operation did not complete.', { nativeReport: redacted(report ?? { exitCode: code }), retryable: code === 2 }));
      }
      resolve(report ?? { ok: true, exitCode: code });
    });
  });
}

async function collectArtifacts(directory, root, artifacts, { exclude = [], accept = () => true } = {}) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error; });
  for (const entry of entries) {
    const file = join(directory, entry.name), rel = relative(root, file);
    if (entry.name === 'node_modules' || exclude.some(prefix => rel === prefix || rel.startsWith(`${prefix}/`))) continue;
    if (entry.isSymbolicLink()) throw failure('UNSAFE_NATIVE_ARTIFACT');
    if (entry.isDirectory()) { await collectArtifacts(file, root, artifacts, { exclude, accept }); continue; }
    if (!entry.isFile()) throw failure('UNSAFE_NATIVE_ARTIFACT');
    const extension = entry.name.match(/\.[^.]+$/)?.[0];
    if (!MIME[extension] || !accept(entry.name)) continue;
    const info = await lstat(file);
    if (info.size > 128 * 1024 * 1024) throw failure('ARTIFACT_TOO_LARGE');
    artifacts.push({ filePath: file, mimeType: MIME[extension], format: extension === '.hash' ? 'json' : extension.slice(1), fileName: entry.name });
    if (artifacts.length > 200) throw failure('TOO_MANY_NATIVE_ARTIFACTS');
  }
}

export async function runNativeTask({ kind, document, options, assets = [], context = {}, signal }) {
  const parsed = inputs[kind]?.safeParse(options);
  if (!parsed?.success || !['validate', 'budget', 'lint', 'prepare_audio', 'render_video', 'review'].includes(kind)) throw failure('INVALID_INPUT');
  options = parsed.data;
  const root = await mkdtemp(join(tmpdir(), 'lattice-native-job-'));
  const cleanup = () => rm(root, { recursive: true, force: true });
  try {
    const deckId = document.deckId;
    if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(deckId)) throw failure('INVALID_INPUT');
    const deckDir = join(root, 'decks', deckId);
    await symlink(join(appRoot, 'node_modules'), join(root, 'node_modules'));
    await writeFile(join(root, 'package.json'), '{"type":"module","private":true}\n');
    await writeFile(join(root, 'lattice.config.js'), 'export default {decksDir:"decks",outDir:".lattice/generated/export",registry:"./decks/registry.js",theme:"simple-light"};\n');
    const assetMap = new Map();
    for (const asset of assets) {
      const id = asset.id ?? asset.assetId;
      if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(id) || !Buffer.isBuffer(asset.buffer)) throw failure('INVALID_ASSET');
      if (/^image\/(png|jpeg|webp)$/.test(asset.mimeType)) assetMap.set(id, `data:${asset.mimeType};base64,${asset.buffer.toString('base64')}`);
      if (/^audio\/(wav|mpeg|ogg|mp4)$/.test(asset.mimeType)) {
        const nativePath = asset.nativePath;
        if (nativePath !== undefined && !/^assets\/audio\/[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(nativePath)) throw failure('INVALID_AUDIO_ASSET');
        const extension = { 'audio/wav': 'wav', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a' }[asset.mimeType];
        const file = nativePath ? join(deckDir, nativePath) : join(deckDir, 'assets/audio', `${id}.${extension}`);
        await mkdir(dirname(file), { recursive: true }); await writeFile(file, asset.buffer);
        assetMap.set(id, file);
      }
    }
    await materializeNativeWorkspace(document, { directory: deckDir, includeNotes: kind === 'review' || kind === 'budget' || kind === 'prepare_audio' && options.kind === 'narration', assetUrl: id => assetMap.get(id) });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(join(root, 'index.html'), await readFile(join(cliRoot, 'src/templates/project/index.html')));
    await writeFile(join(root, 'src/main.js'), await readFile(join(cliRoot, 'src/templates/project/src/main.js')));
    await writeFile(join(root, 'decks/registry.js'), `import '@55aaseclab/lattice-runtime/themes/simple-light/styles.css';\nimport {buildSlides} from './${deckId}/slides.js';\nexport const deckRegistry={${JSON.stringify(deckId)}:{id:${JSON.stringify(deckId)},title:${JSON.stringify(htmlText(document.title))},buildSlides}};export const deckList=Object.values(deckRegistry);\n`);
    for (const artifact of context.priorArtifacts || []) {
      if (!Buffer.isBuffer(artifact.buffer) || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,199}$/.test(artifact.fileName || '')) throw failure('INVALID_PRIOR_ARTIFACT');
      let destination;
      if (/^session-\d+\.json$/.test(artifact.fileName)) destination = join(root, '.lattice/audience-sessions', deckId, artifact.fileName);
      else if (artifact.role === 'pack') destination = join(root, '.lattice/audience-packs', deckId, ...(artifact.format === 'png' ? ['stills'] : []), artifact.fileName);
      else if (artifact.role === 'review') destination = join(root, '.lattice/audience-reviews', deckId, artifact.fileName);
      if (!destination) continue;
      await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, artifact.buffer);
    }
    const runtime = join(root, '.runtime'); await mkdir(runtime, { mode: 0o700 });
    const env = { ...process.env, XDG_CONFIG_HOME: runtime, XDG_CACHE_HOME: runtime, XDG_RUNTIME_DIR: runtime };
    const run = (args, overrides = {}) => runNativeCommand(args, { cwd: root, signal, env, ...overrides });
    const artifacts = [];
    let report;
    if (kind === 'validate' || kind === 'budget' || kind === 'lint') {
      const args = kind === 'validate' ? ['validate', '--deck', deckId]
        : kind === 'budget' ? ['deck', 'budget', '--deck', deckId, '--unit', options.unit]
        : ['inspect', '--rendered', '--lint', '--deck', deckId, '--out', join(root, '.lattice/generated/lint.json')];
      report = await run(args, { allowRefusalReport: true });
      if (kind === 'lint') await collectArtifacts(join(root, '.lattice/generated'), root, artifacts, { accept: name => name === 'lint.json' });
    } else if (kind === 'prepare_audio') {
      const args = ['audio', options.kind === 'narration' ? 'narrate' : 'bgm', '--deck', deckId];
      for (const name of ['engine', 'voice', 'speed', 'style', 'seed', 'volume']) if (options[name] !== undefined) args.push(`--${name}`, String(options[name]));
      if (options.sourceAssetId) {
        const source = assetMap.get(options.sourceAssetId); if (!source || !source.startsWith(`${deckDir}/assets/audio/`)) throw failure('INVALID_AUDIO_ASSET');
        args.push('--src', source);
      }
      report = await run(args);
      await collectArtifacts(join(deckDir, 'assets/audio'), root, artifacts);
      for (const artifact of artifacts) artifact.nativePath = relative(deckDir, artifact.filePath);
      const manifest = JSON.parse(await readFile(join(deckDir, 'manifest.json'), 'utf8'));
      report = { ...report, timeline: manifest.timeline, adoption: 'Attach the returned audio artifact through the current-revision audio edit before using it in another job.' };
    } else if (kind === 'render_video') {
      const args = ['video', options.operation];
      if (options.operation === 'doctor') args.push('--backend', options.backend);
      else {
        args.push('--deck', deckId);
        if (['plan', 'still', 'render'].includes(options.operation)) {
          const bundle = join(root, '.lattice/generated/bundle');
          await run(['export', '--deck', deckId, '--out', bundle]);
          args.push('--bundle-dir', bundle);
          if (options.route) args.push('--route', options.route);
        }
        if (['still', 'render'].includes(options.operation)) args.push('--backend', options.backend);
        if (options.operation === 'still') {
          if (options.frame !== undefined && options.frames !== undefined || options.frame === undefined && !options.frames?.length) throw failure('INVALID_FRAME_SELECTION');
          args.push(options.frames ? '--frames' : '--frame', options.frames ? options.frames.join(',') : String(options.frame));
        }
        if (options.operation === 'plan') args.push('--output', join(root, '.lattice/generated/plan.json'));
      }
      report = await run(args);
      await collectArtifacts(join(root, '.lattice/generated'), root, artifacts, { exclude: ['.lattice/generated/bundle'], accept: name => /^(?:plan\.json|video\.mp4|(?:still-frame-|frame-)\d+\.png|chapters\.txt|subtitles\.srt)$/.test(name) });
      if (options.operation === 'subtitles' && !artifacts.some(artifact => artifact.format === 'srt')) throw failure('NARRATION_REQUIRED');
    } else {
      const args = ['audience'];
      if (options.operation === 'personas') args.push('personas');
      else if (options.operation === 'verify') {
        const checked = validateAudienceReview(options.review); if (!checked.ok) throw failure('INVALID_REVIEW');
        const file = join(root, 'review.json'); await writeFile(file, JSON.stringify(options.review)); args.push('verify', '--review', file);
      } else if (options.operation.startsWith('session_')) {
        args.push('session', '--deck', deckId, options.operation.slice(8));
        if (context.session) {
          const directory = join(root, '.lattice/audience-sessions', deckId); await mkdir(directory, { recursive: true });
          await writeFile(join(directory, 'session-001.json'), JSON.stringify(context.session));
        }
        if (options.operation === 'session_append') {
          args.push('--round', String(options.round));
          const reviews = [...(options.reviews || [])];
          for (const artifact of context.priorArtifacts || []) if (artifact.role === 'review' && artifact.format === 'json') {
            let review; try { review = JSON.parse(artifact.buffer); } catch { continue; }
            if (validateAudienceReview(review).ok) reviews.push(review);
          }
          for (const [index, review] of reviews.entries()) {
            if (!validateAudienceReview(review).ok) throw failure('INVALID_REVIEW');
            const file = join(root, `review-${index}.json`); await writeFile(file, JSON.stringify(review)); args.push('--review', file);
          }
          for (const [name, value] of [['improvements', options.improvements], ['conclusion', options.conclusion]]) if (value !== undefined) {
            const file = join(root, `${name}.json`); await writeFile(file, JSON.stringify(value)); args.push(`--${name}`, file);
          }
          if (options.packHash) args.push('--pack-hash', options.packHash);
        }
      } else {
        args.push(options.operation, '--deck', deckId, '--stills', options.stills);
        if (options.personas) args.push('--personas', options.personas.join(','));
        if (options.round) args.push('--round', String(options.round));
      }
      report = await run(args, { allowRefusalReport: options.operation === 'session_check' });
      for (const [directory, role] of [['audience-packs', 'pack'], ['audience-sessions', 'session'], ['audience-reviews', 'review']]) {
        const start = artifacts.length;
        await collectArtifacts(join(root, '.lattice', directory), root, artifacts);
        for (const artifact of artifacts.slice(start)) artifact.role = role;
      }
      const sessionArtifact = artifacts.filter(artifact => artifact.role === 'session' && /^session-\d+\.json$/.test(artifact.fileName)).sort((a, b) => a.fileName.localeCompare(b.fileName)).at(-1);
      if (sessionArtifact) report = { ...report, session: JSON.parse(await readFile(sessionArtifact.filePath, 'utf8')) };
    }
    const safeReport = redacted(report);
    artifacts.push({ buffer: Buffer.from(JSON.stringify(safeReport)), mimeType: 'application/json', format: 'json', fileName: `${kind}-report.json` });
    return { artifacts, issues: [], fidelityWarnings: [], report: safeReport, cleanup };
  } catch (error) { await cleanup(); throw error; }
}
