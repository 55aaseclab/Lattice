import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { lstat, readFile, readdir, readlink, realpath, rm, unlink } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';

const root = await realpath(resolve(process.argv[2] || process.cwd()));
if (JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).name !== 'lattice') {
  throw new Error('Expected the Lattice application root.');
}
const declarationFiles = ['package.json', 'package-lock.json', 'packages/cli/package.json', 'packages/runtime/package.json'];
const declarations = new Map();
for (const file of declarationFiles) {
  const bytes = await readFile(join(root, file));
  declarations.set(file, createHash('sha256').update(bytes).digest('hex'));
}
const moduleRoots = ['node_modules', 'packages/cli/node_modules', 'packages/runtime/node_modules'].map(path => join(root, path));
const removed = [];
for (const modules of moduleRoots) {
  const targets = ['@remotion', 'remotion', 'hyperframes'].map(name => join(modules, name));
  const binaries = join(modules, '.bin');
  let entries = [];
  try { entries = await readdir(binaries); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  for (const entry of entries) {
    const file = join(binaries, entry);
    const info = await lstat(file);
    if (!info.isSymbolicLink()) continue;
    const target = resolve(dirname(file), await readlink(file));
    if (targets.some(directory => target === directory || target.startsWith(directory + sep))) {
      await unlink(file);
    }
  }
  for (const target of targets) {
    const inside = relative(root, target);
    if (inside.startsWith('..' + sep) || isAbsolute(inside)) throw new Error('Module path escapes the application.');
    try { await lstat(target); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    await rm(target, { recursive: true, force: true });
    removed.push(inside);
  }
}
for (const [file, digest] of declarations) {
  const after = createHash('sha256').update(await readFile(join(root, file))).digest('hex');
  if (after !== digest) throw new Error('Dependency declarations changed.');
}
for (const manifest of ['package.json', 'packages/cli/package.json']) {
  const require = createRequire(join(root, manifest));
  for (const name of ['remotion', '@remotion/cli', '@remotion/renderer', '@remotion/bundler', 'hyperframes']) {
    let present = false;
    try { require.resolve(name); present = true; } catch {}
    if (present) throw new Error('Video engine is still resolvable.');
  }
}
console.log(JSON.stringify({ removed, dependencyDeclarationsUnchanged: true, videoEnginesUnavailable: true }));
