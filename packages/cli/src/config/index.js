import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

export const DEFAULT_CONFIG = {
  title: "Slides",
  decksDir: "decks",
  outDir: "dist",
  registry: "./decks/registry.js",
  theme: "simple-light",
  dev: { port: 4666, host: "localhost" },
};

export async function loadConfig(cwd = process.cwd()) {
  const configPath = path.join(cwd, "lattice.config.js");
  if (!fs.existsSync(configPath)) {
    throw new Error(`lattice.config.js not found in ${cwd} (run inside a Lattice business project)`);
  }
  const module = await import(pathToFileURL(configPath).href);
  const userConfig = module.default ?? {};
  return {
    ...DEFAULT_CONFIG,
    ...userConfig,
    dev: { ...DEFAULT_CONFIG.dev, ...userConfig.dev },
  };
}

export function resolveRuntimeRoot(fromUrl = import.meta.url) {
  const require = createRequire(fromUrl);
  const runtimeEntry = require.resolve("@55aaseclab/lattice-runtime");
  return path.resolve(path.dirname(runtimeEntry), "..");
}
