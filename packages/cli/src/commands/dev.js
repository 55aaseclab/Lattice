import { loadConfig } from "../config/index.js";
import { startProjectServer } from "./dev-server.js";

export async function devCommand({ args }) {
  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  const port = args.port ? Number(args.port) : config.dev.port;
  const host = args.host ?? config.dev.host;

  const { baseUrl } = await startProjectServer({ cwd, config, port, host, open: Boolean(args.open) });

  console.log(`[lattice] dev server: ${baseUrl}`);
  if (args.deck) {
    const deckUrl = `${baseUrl.replace(/\/$/, "")}/?deck=${args.deck}${args.grid ? "&grid=1" : ""}`;
    console.log(`[lattice] deck "${args.deck}": ${deckUrl}`);
    if (args.grid) console.log(`[lattice] grid overlay enabled via grid=1`);
  } else {
    console.log(`[lattice] tip: append ?deck=<deck-id>&grid=1 to inspect a deck with its grid overlay`);
  }
}
