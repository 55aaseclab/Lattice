import { build } from "vite";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/index.js";

export async function buildCommand({ args }) {
  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  const outDir = path.resolve(cwd, args.out ?? config.outDir);
  const decksDir = path.resolve(cwd, config.decksDir);

  await build({
    root: cwd,
    base: "./",
    publicDir: false,
    build: { outDir, emptyOutDir: true },
  });

  for (const deckId of listDeckIds(decksDir)) {
    for (const dirName of ["assets", "references"]) {
      const source = path.join(decksDir, deckId, dirName);
      if (fs.existsSync(source)) {
        fs.cpSync(source, path.join(outDir, "decks", deckId, dirName), { recursive: true });
      }
    }
  }

  console.log(`[lattice] built business project to ${outDir}`);
}

function listDeckIds(decksDir) {
  if (!fs.existsSync(decksDir)) return [];
  return fs
    .readdirSync(decksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
}
