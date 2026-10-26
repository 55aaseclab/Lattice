import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer } from "vite";

/**
 * Shared project module loader for commands that must import deck sources
 * through the project's vite pipeline (CSS imports in slide modules are
 * handled there, exactly like the portal and registry paths).
 *
 * The loader is explicit: there is no silent fallback between plain imports
 * and vite imports — commands decide which pipeline a schema requires and
 * stick to it. The dep-optimizer cache lives outside the project so command
 * runs never write artifacts into the business source tree.
 */
export async function createProjectModuleLoader(cwd) {
  const cacheKey = createHash("sha256").update(path.resolve(cwd)).digest("hex").slice(0, 16);
  const server = await createServer({
    root: cwd,
    appType: "custom",
    cacheDir: path.join(tmpdir(), `lattice-vite-cli-${cacheKey}`),
    server: { middlewareMode: true },
  });
  const toModuleId = (modulePath) => {
    const absolute = path.isAbsolute(modulePath) ? modulePath : path.resolve(cwd, modulePath);
    return `/${path.relative(cwd, absolute).split(path.sep).join("/")}`;
  };
  return {
    async load(modulePath) {
      return server.ssrLoadModule(toModuleId(modulePath));
    },
    async close() {
      await server.close();
    },
  };
}
