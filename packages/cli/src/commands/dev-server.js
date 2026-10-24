import { createServer } from "vite";
import fs from "node:fs";
import path from "node:path";
import { resolveRuntimeRoot } from "../config/index.js";

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

const moduleExtensions = new Set([".js", ".mjs", ".cjs", ".css", ".html", ".json"]);

export function deckAssetsPlugin(cwd, decksDir) {
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
        if (moduleExtensions.has(path.extname(filePath).toLowerCase())) {
          next();
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

/**
 * The runtime package's own dependencies can be hoisted above it (npm
 * workspaces monorepo when linked via `file:`, or the consuming project's
 * node_modules when installed from the registry), so allow the nearest
 * ancestor that actually contains a node_modules directory.
 */
function runtimeDependencyRoots(runtimeRoot) {
  const roots = [runtimeRoot];
  let current = runtimeRoot;
  for (let depth = 0; depth < 4; depth += 1) {
    current = path.dirname(current);
    if (fs.existsSync(path.join(current, "node_modules"))) {
      roots.push(current);
      break;
    }
  }
  return roots;
}

/**
 * Start the shared Vite dev server used by `lattice dev` and `lattice inspect`
 * so both commands serve decks (and their assets) identically. Runtime
 * dependency roots are allow-listed because bundled assets (e.g. KaTeX fonts)
 * resolve to `/@fs/` URLs inside the engine's node_modules when the engine is
 * linked with `file:` dependencies. An optional `cacheDir` isolates the
 * dependency optimizer from other servers (dev, validate, editors) that share
 * the project's default cache — a config-hash mismatch in the shared cache
 * otherwise invalidates optimized-dep URLs while pages load (HTTP 504
 * "Outdated Optimize Dep").
 */
export async function startProjectServer({ cwd, config, port, host, open = false, cacheDir = null }) {
  const server = await createServer({
    root: cwd,
    publicDir: false,
    base: "./",
    ...(cacheDir ? { cacheDir } : {}),
    plugins: [deckAssetsPlugin(cwd, config.decksDir)],
    server: {
      port,
      host,
      strictPort: false,
      open,
      fs: { allow: [cwd, ...runtimeDependencyRoots(resolveRuntimeRoot())] },
    },
  });
  await server.listen();

  const baseUrl = server.resolvedUrls?.local?.[0] ?? server.resolvedUrls?.network?.[0] ?? `http://localhost:${port}/`;
  return { server, baseUrl };
}
