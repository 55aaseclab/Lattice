import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/index.js";
import { startProjectServer } from "./dev-server.js";
import { validateDeckManifestV2 } from "@55aaseclab/lattice-runtime/deck-v2";

// M2 A14 — `lattice present --deck <id>`: start the project server and open
// the Lattice Presentation for one v2 deck. Presentation is Lattice-owned and
// never requires, probes, or initializes a video backend. The deck manifest
// must be explicit lattice.deck.v2 — v1 sources fail with migration guidance
// instead of being silently presented.

export async function presentCommand({ args }) {
  const cwd = process.cwd();
  if (typeof args.deck !== "string" || args.deck === "") {
    console.error("[lattice] present requires --deck <id> (see `lattice help`)");
    process.exit(2);
  }
  const config = await loadConfig(cwd);
  const deckId = args.deck;
  const deckDir = path.resolve(cwd, config.decksDir, deckId);
  const manifestPath = path.join(deckDir, "manifest.json");

  if (!fs.existsSync(manifestPath)) {
    console.error(`[lattice] unknown deck id: ${deckId} (no manifest at ${manifestPath})`);
    process.exit(1);
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    console.error(`[lattice] deck "${deckId}" manifest is not readable JSON: ${error.message}`);
    process.exit(1);
  }
  const report = validateDeckManifestV2(manifest, { expectedId: deckId });
  if (!report.ok) {
    console.error(`[lattice] deck "${deckId}" is not a valid presentation deck (lattice.deck.v2 required):`);
    for (const error of report.errors) console.error(`  - [${error.type}] ${error.element ?? ""}: ${error.message}`);
    if (manifest.schema === "lattice.deck.v1") {
      console.error(`[lattice] run \`lattice migrate --deck ${deckId}\` to upgrade v1 sources explicitly.`);
    }
    process.exit(1);
  }

  const port = args.port ? Number(args.port) : config.dev.port;
  const host = args.host ?? config.dev.host;
  const { baseUrl } = await startProjectServer({ cwd, config, port, host, open: Boolean(args.open) });

  const url = new URL(baseUrl);
  url.searchParams.set("deck", deckId);
  url.searchParams.set("present", "1");
  if (args.presenter) url.searchParams.set("presenter", "1");
  if (typeof args.route === "string" && args.route !== "" && args.route !== "main") url.searchParams.set("route", args.route);

  console.log(`[lattice] presentation server: ${baseUrl}`);
  console.log(`[lattice] present deck "${deckId}": ${url.pathname}${url.search}`);
  if (args.presenter) console.log(`[lattice] presenter view enabled (notes panel visible to the presenter only)`);
  console.log(`[lattice] press Ctrl+C to stop`);
}
