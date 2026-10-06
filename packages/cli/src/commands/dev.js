import { createServer } from "vite";
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/index.js";

const mimeTypes = {
  ".avif": "image/avif",
  ".css": "text/css",
  ".gif": "image/gif",
  ".html": "text/html",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".js": "text/javascript",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ttf": "font/ttf",
  ".wav": "audio/wav",
  ".webm": "video/webm",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function deckAssetsPlugin(cwd, decksDir) {
  const root = path.resolve(cwd, decksDir);
  return {
    name: "lattice-deck-assets",
    configureServer(server) {
      server.middlewares.use("/decks", (req, res, next) => {
        const relative = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\/+/, "");
        const filePath = path.resolve(root, relative);
        if (filePath !== root && !filePath.startsWith(root + path.sep)) {
          res.statusCode = 403;
          res.end();
          return;
        }
        if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
          const type = mimeTypes[path.extname(filePath).toLowerCase()] ?? "application/octet-stream";
          res.setHeader("Content-Type", type);
          fs.createReadStream(filePath).pipe(res);
          return;
        }
        next();
      });
    },
  };
}

export async function devCommand({ args }) {
  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  const port = args.port ? Number(args.port) : config.dev.port;
  const host = args.host ?? config.dev.host;

  const server = await createServer({
    root: cwd,
    publicDir: false,
    base: "./",
    plugins: [deckAssetsPlugin(cwd, config.decksDir)],
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
