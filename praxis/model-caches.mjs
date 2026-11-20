import { lstat, readdir, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';

const kinds = Object.freeze({ piper: { names: ['piper'], variable: 'LATTICE_PIPER_DIR' }, tts: { names: ['kokoro', 'tts'], variable: 'LATTICE_TTS_CACHE' }, asr: { names: ['whisper', 'asr'], variable: 'LATTICE_ASR_CACHE' } });
const forbiddenSegments = new Set(['.git','.ssh','.gnupg','.aws','.kube','.docker','.config','.codex','.agents','.paseo','.harness','paseo','codex','agents','harness','credentials','secrets']);
const forbiddenFiles = /^(?:\.env(?:\..*)?|credentials(?:\..*)?|secrets?(?:\..*)?|passwords?(?:\..*)?|tokens?(?:\..*)?|id_(?:rsa|ed25519)(?:\.pub)?)$|\.(?:pem|key|p12|pfx|kdbx|db|sqlite)$/i;
const within = (parent, child) => child === parent || child.startsWith(parent + '/');
const overlaps = (left, right) => within(left, right) || within(right, left);
const fail = () => { throw Object.assign(new Error('Model caches require specific owned model directories without writable peers, external aliases or private data.'), { code: 'UNSAFE_MODEL_CACHE', status: 500 }); };

export function validateSlidesModelCacheConfig(value) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(kind => !Object.hasOwn(kinds, kind))) fail();
  const paths = [];
  for (const [kind, source] of Object.entries(value)) {
    if (typeof source !== 'string' || !isAbsolute(source) || resolve(source) !== source || /[\x00-\x1f\x7f]/.test(source) || source === homedir() || source.split('/').filter(Boolean).length < 3 || !kinds[kind].names.includes(basename(source)) || source.split('/').some(segment => forbiddenSegments.has(segment))) fail();
    if (paths.some(path => overlaps(path, source))) fail();
    paths.push(source);
  }
}

async function inspectTree(source, uid) {
  if (await realpath(source) !== source) fail();
  const queue = [source]; let entries = 0;
  while (queue.length) {
    const path = queue.pop(), info = await lstat(path);
    if (++entries > 50000 || info.uid !== uid || forbiddenFiles.test(basename(path))) fail();
    if (info.isSymbolicLink()) {
      const target = await realpath(path);
      if (!within(source, target)) fail();
      const destination = await lstat(target);
      if (!destination.isFile() || destination.uid !== uid || destination.nlink !== 1 || destination.mode & 0o022 || forbiddenFiles.test(basename(target))) fail();
      continue;
    }
    if (info.mode & 0o022 || !(info.isDirectory() || info.isFile()) || info.isFile() && info.nlink !== 1) fail();
    if (info.isDirectory()) {
      for (const name of await readdir(path)) {
        if (forbiddenSegments.has(name)) fail();
        queue.push(join(path, name));
      }
    }
  }
}

export async function resolveSlidesModelCaches(value, { uid = process.getuid?.() ?? 1000, protectedPaths = [] } = {}) {
  validateSlidesModelCacheConfig(value);
  const environment = {}, volumes = [];
  for (const [kind, source] of Object.entries(value || {})) {
    if (protectedPaths.filter(Boolean).some(path => overlaps(source, path))) fail();
    const info = await lstat(source);
    if (!info.isDirectory() || info.isSymbolicLink()) fail();
    await inspectTree(source, uid);
    const target = `/opt/lattice-model-cache/${kind}`;
    environment[kinds[kind].variable] = target;
    volumes.push({ type: 'bind', source, target, read_only: true, bind: { create_host_path: false } });
  }
  return { environment, volumes };
}
