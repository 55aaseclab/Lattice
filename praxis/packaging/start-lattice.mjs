import { fileURLToPath } from 'node:url';
import { constants } from 'node:fs';
import { copyFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';

await Promise.all([
  '/app/decks',
  '/app/.lattice/runtime/viewer',
  '/app/.lattice/runtime/workbench',
  '/app/.lattice/runtime/business',
  '/app/dist/static-decks',
  '/data/slides/home',
  '/data/slides/cache',
].map(directory => mkdir(directory, { recursive: true, mode: 0o700 })));
try {
  await copyFile('/app/default-decks/registry.js', '/app/decks/registry.js', constants.COPYFILE_EXCL);
} catch (error) {
  if (error.code !== 'EEXIST') throw error;
}
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('./build-slides-public.mjs', import.meta.url))], {
    cwd: '/app',
    stdio: 'inherit',
  });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve() : reject(new Error('Slides asset build failed.')));
});
await import('./serve-slides-public.mjs');
