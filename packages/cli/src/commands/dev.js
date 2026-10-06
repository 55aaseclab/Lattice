import { createServer } from "vite";
import { resolve } from "node:path";
import { loadConfig } from "../config/index.js";

export async function devCommand({ args }) {
  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  const port = args.port ? Number(args.port) : config.dev.port;
  const host = args.host ?? config.dev.host;

  const server = await createServer({
    root: cwd,
    publicDir: resolve(cwd, config.publicDir),
    base: "./",
    server: { port, host, strictPort: false, open: Boolean(args.open) },
  });
  await server.listen();

  const baseUrl = server.resolvedUrls?.local?.[0] ?? server.resolvedUrls?.network?.[0] ?? `http://localhost:${port}/`;
  console.log(`[lattice] dev server: ${baseUrl}`);
  if (args.deck) {
    const deckUrl = `${baseUrl.replace(/\/$/, "")}/?deck=${args.deck}${args.grid ? "&grid=1" : ""}`;
    console.log(`[lattice] deck "${args.deck}": ${deckUrl}`);
    if (args.grid) console.log(`[lattice] grid overlay enabled via grid=1`);
  } else {
    console.log(`[lattice] tip: append ?deck=<deck-id>&grid=1 to inspect a deck with its grid overlay`);
  }
}
