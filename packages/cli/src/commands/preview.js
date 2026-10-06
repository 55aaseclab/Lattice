import { resolve } from "node:path";
import { loadConfig } from "../config/index.js";

export async function previewCommand({ args }) {
  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  const port = args.port ? Number(args.port) : config.dev.port;
  const host = args.host ?? config.dev.host;

  const { preview } = await import("vite");
  const server = await preview({
    root: cwd,
    base: "./",
    build: { outDir: resolve(cwd, config.outDir) },
    preview: { port, host, strictPort: false, open: Boolean(args.open) },
  });

  const baseUrl = server.resolvedUrls?.local?.[0] ?? `http://localhost:${port}/`;
  console.log(`[lattice] preview: ${baseUrl}`);
}
