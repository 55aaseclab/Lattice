import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VideoBackendError } from "../backend-contract.js";
import {
  HOST_ENTRY_NAME,
  HOST_PUBLIC_MANIFEST_NAME,
  REMOTION_HOST_SCHEMA,
} from "./host-template.js";

const REMOTION_BACKEND_ID = "remotion";
const REMOTION_HOST_DIRNAME = "host";
const REMOTION_BUNDLE_OUT_DIRNAME = "bundle";
const REMOTION_FAILURES_DIRNAME = "failures";

// One webpack bundle per (workDir, planHash) per backend instance: stills and
// video from the same prepared render reuse it. The cache lives inside the
// backend instance, so a fresh process always rebuilds from the generated
// host on disk.
const bundleCache = new Map();

function renderSupportError(message, cause, diagnostics = []) {
  return new VideoBackendError(message, { backendId: REMOTION_BACKEND_ID, diagnostics, cause });
}

/**
 * The generated host lives in an arbitrary project that need not install
 * Remotion or React. Webpack therefore resolves them from the adapter's own
 * dependency tree, located through the real remotion package resolution.
 */
function resolveAdapterNodeModulesDir() {
  try {
    const resolved = import.meta.resolve("remotion");
    let dir = path.dirname(fileURLToPath(resolved));
    for (;;) {
      if (path.basename(dir) === "node_modules") return dir;
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  } catch {
    return null;
  }
}

export async function readHostManifest({ workDir, planHash }) {
  const manifestPath = path.join(workDir, REMOTION_HOST_DIRNAME, "public", HOST_PUBLIC_MANIFEST_NAME);
  let raw;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch {
    throw renderSupportError(
      `no generated Remotion host found at ${manifestPath}. Run backend prepare first ` +
      `(the CLI video still/render commands prepare automatically).`,
      "missing-host",
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch (error) {
    throw renderSupportError(`generated host manifest is not valid JSON: ${error.message}`, "invalid-host");
  }
  if (manifest?.schema !== REMOTION_HOST_SCHEMA) {
    throw renderSupportError(
      `generated host manifest has unexpected schema ${JSON.stringify(manifest?.schema ?? null)}; regenerate the host with prepare.`,
      "invalid-host",
    );
  }
  if (manifest.planHash !== planHash) {
    throw renderSupportError(
      `generated host manifest was built for plan ${manifest.planHash} but the prepared render carries plan ${planHash}. Re-run prepare.`,
      "host-mismatch",
    );
  }
  return { manifest, manifestPath };
}

export function assertHostClipsBound(manifest) {
  const unbound = (manifest.clips ?? [])
    .filter((clip) => clip.contentIndex === null || clip.contentIndex === undefined)
    .map((clip) => clip.slideId);
  if (unbound.length > 0) {
    throw renderSupportError(
      `generated host has unbound clips (${unbound.join(", ")}): the Slide Web Bundle content.json has fewer ` +
      `slides than the plan's route. Re-export the deck and re-run prepare.`,
      "unbound-slide-content",
    );
  }
}

export async function ensureHostBundle({ workDir, planHash }) {
  const cacheKey = `${workDir}::${planHash}`;
  const cached = bundleCache.get(cacheKey);
  if (cached) return cached;

  const entryPoint = path.join(workDir, REMOTION_HOST_DIRNAME, HOST_ENTRY_NAME);
  let entryStat = null;
  try {
    entryStat = await fs.stat(entryPoint);
  } catch {
    entryStat = null;
  }
  if (!entryStat || !entryStat.isFile()) {
    throw renderSupportError(
      `generated Remotion host entry is missing at ${entryPoint}. Run backend prepare first.`,
      "missing-host",
    );
  }

  const modulesDir = resolveAdapterNodeModulesDir();
  const { bundle } = await import("@remotion/bundler");
  let serveUrl;
  try {
    serveUrl = await bundle({
      entryPoint,
      outDir: path.join(workDir, REMOTION_BUNDLE_OUT_DIRNAME),
      rootDir: workDir,
      publicDir: path.join(workDir, REMOTION_HOST_DIRNAME, "public"),
      enableCaching: false,
      webpackOverride: (config) => ({
        ...config,
        resolve: {
          ...(config.resolve ?? {}),
          modules: [
            ...(config.resolve?.modules ?? []),
            "node_modules",
            ...(modulesDir ? [modulesDir] : []),
          ],
        },
      }),
    });
  } catch (error) {
    throw renderSupportError(
      `Remotion webpack bundling of the generated host failed: ${error?.message ?? String(error)}`,
      "bundle-failed",
    );
  }

  bundleCache.set(cacheKey, serveUrl);
  return serveUrl;
}

export async function resolveRenderBrowserExecutable() {
  const { resolveChromiumExecutable } = await import("../../commands/browser.js");
  const executable = resolveChromiumExecutable();
  if (!executable) {
    throw renderSupportError(
      "No Chromium/Chrome browser executable found for Remotion rendering " +
      "(searched LATTICE_CHROMIUM, Playwright cache, and system locations). " +
      "Install Chromium/Chrome or set LATTICE_CHROMIUM.",
      "missing-browser",
    );
  }
  return executable;
}

export async function selectHostComposition({ serveUrl, compositionId, browserExecutable }) {
  const { selectComposition } = await import("@remotion/renderer");
  try {
    return await selectComposition({
      serveUrl,
      id: compositionId,
      inputProps: {},
      ...(browserExecutable ? { browserExecutable } : {}),
    });
  } catch (error) {
    throw renderSupportError(
      `Remotion could not select the generated composition "${compositionId}": ${error?.message ?? String(error)}`,
      "composition-failed",
    );
  }
}

/**
 * Failure logs keep render failures diagnosable after the process exits:
 * error message, stack, and the diagnostics envelope are written under
 * `<workDir>/failures/` with a deterministic, content-derived name.
 */
export async function writeRemotionFailureLog({ workDir, kind, planHash, context = {}, error, diagnostics = [] }) {
  try {
    const dir = path.join(workDir, REMOTION_FAILURES_DIRNAME);
    await fs.mkdir(dir, { recursive: true });
    let existing = [];
    try {
      existing = await fs.readdir(dir);
    } catch {
      existing = [];
    }
    const prefix = `${kind}-${String(planHash ?? "unknown").slice(0, 8)}`;
    const sequence = existing.filter((name) => name.startsWith(prefix) && name.endsWith(".log")).length + 1;
    const logPath = path.join(dir, `${prefix}-${String(sequence).padStart(3, "0")}.log`);
    const lines = [
      "DO NOT EDIT — Lattice Remotion failure log",
      `kind: ${kind}`,
      `plan-hash: ${planHash ?? "unknown"}`,
      ...Object.entries(context).map(([key, value]) => `${key}: ${value}`),
      "",
      `error: ${error?.message ?? String(error)}`,
      `stack: ${error?.stack ?? ""}`,
      "",
      "diagnostics:",
      ...(diagnostics.length > 0
        ? diagnostics.map((diag) => `  [${diag?.level ?? "error"}] ${diag?.message ?? String(diag)}`)
        : ["  (none)"]),
      "",
    ];
    await fs.writeFile(logPath, lines.join("\n"), "utf8");
    return logPath;
  } catch {
    return null;
  }
}
