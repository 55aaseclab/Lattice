import { build } from "vite";
import { resolve } from "node:path";
import { loadConfig } from "../config/index.js";

export async function buildCommand({ args }) {
  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  const outDir = resolve(cwd, args.out ?? config.outDir);

  await build({
    root: cwd,
    base: "./",
    publicDir: resolve(cwd, config.publicDir),
    build: { outDir, emptyOutDir: true },
  });

  console.log(`[lattice] built business project to ${outDir}`);
}
