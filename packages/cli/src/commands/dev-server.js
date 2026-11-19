import { createServer } from "vite";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveRuntimeRoot } from "../config/index.js";
import { imageCache } from "../http/image-cache.js";
import { installPortalMiddleware } from "../portal/server.js";
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
      server.middlewares.use("/decks", async (req, res, next) => {
        if (!["GET", "HEAD"].includes(req.method)) return next();
        let relative;
        try { relative = decodeURIComponent((req.url ?? "").split("?")[0]).replace(/^\/+/, ""); }
        catch { res.writeHead(400, { "Cache-Control": "no-store" }); res.end(); return; }
        const filePath = path.resolve(root, relative);
        if (filePath !== root && !filePath.startsWith(root + path.sep)) {
          res.writeHead(403, { "Cache-Control": "no-store" });
          res.end();
          return;
        }
        if (moduleExtensions.has(path.extname(filePath).toLowerCase())) {
          next();
          return;
        }
        try {
          if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return next();
          const actual = await fs.promises.realpath(filePath);
          const base = await fs.promises.realpath(root);
          const inside = path.relative(base, actual);
          if (inside === ".." || inside.startsWith(".." + path.sep) || path.isAbsolute(inside)) {
            res.writeHead(403, { "Cache-Control": "no-store" }); res.end(); return;
          }
          const stat = await fs.promises.stat(actual);
          const type = mimeTypes[path.extname(actual).toLowerCase()] ?? "application/octet-stream";
          const cache = await imageCache(req, { file: actual, stat, type, policy: "private, max-age=3600, must-revalidate", vary: res.getHeader("Vary") });
          res.setHeader("Content-Type", type);
          if (cache) {
            for (const [name, value] of Object.entries(cache.headers)) res.setHeader(name, value);
            if (cache.notModified) { res.removeHeader("Content-Length"); res.writeHead(304); res.end(); return; }
            res.setHeader("Content-Length", stat.size);
          }
          if (req.method === "HEAD") { res.end(); return; }
          fs.createReadStream(actual).on("error", error => res.destroy(error)).pipe(res);
        } catch (error) { next(error); }
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
// The portal must intercept requests BEFORE Vite's own SPA fallback rewrites
// "/" to /index.html, so it installs through configureServer (pre phase).
function portalPlugin({ cwd, config }) {
  return {
    name: "lattice-portal",
    configureServer(server) {
      installPortalMiddleware({ cwd, config, server });
    },
  };
}

export async function startProjectServer({ cwd, config, port, host, open = false, cacheDir = null, portal = false }) {
  // The workbench route (issue 005) serves the workbench single-page app from
  // the CLI package through /@fs/ URLs, so the CLI's own root must be on the
  // serving allow-list alongside the project and the runtime dependency roots.
  const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const server = await createServer({
    root: cwd,
    publicDir: false,
    base: "./",
    ...(cacheDir ? { cacheDir } : {}),
    plugins: [
      deckAssetsPlugin(cwd, config.decksDir),
      ...(portal ? [portalPlugin({ cwd, config })] : []),
    ],
    server: {
      port,
      host,
      // The portal is meant to be reached through remote hostnames (it binds
      // 0.0.0.0 on request), so Vite's Host-header allowlist must not reject
      // the very access the bind invites.
      allowedHosts: true,
      strictPort: false,
      open,
      // Issue 008: a dev portal must always run the code on disk. Module URLs
      // are stable across edits, so every served response opts out of
      // freshness caching and revalidates — a normal refresh picks up edits
      // without a hard reload.
      headers: { "Cache-Control": "no-cache" },
      fs: { allow: [cwd, cliRoot, ...runtimeDependencyRoots(resolveRuntimeRoot())] },
    },
  });
  await server.listen();

  const baseUrl = server.resolvedUrls?.local?.[0] ?? server.resolvedUrls?.network?.[0] ?? `http://localhost:${port}/`;
  return { server, baseUrl };
}
