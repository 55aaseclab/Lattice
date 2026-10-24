import { chromium } from "playwright-core";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Fixed capture/inspection geometry: recorded in artifacts for reproducibility.
export const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

// Dedicated Vite dep-cache for headless engine servers (inspect + screenshot):
// isolates their optimizer from concurrent dev/validate servers sharing the
// project's default cache, whose config-hash mismatch invalidates
// optimized-dep URLs while pages load ("Outdated Optimize Dep" 504s).
export const HEADLESS_CACHE_DIR_NAME = ".vite-lattice-inspect";

// Vite answers HTTP 504 for optimized-dep URLs whose browserHash was
// superseded mid-load ("Outdated Optimize Dep"). The dedicated cache dir and
// the prewarm pass keep this transient out of measurement passes.
const OPTIMIZED_DEP_URL = /\/node_modules\/\.vite[^/]*\//;
const WARMUP_MAX_ATTEMPTS = 3;
const WARMUP_MIN_TIMEOUT_MS = 15000;

const PLAYWRIGHT_CACHE_DIR = {
  linux: ".cache/ms-playwright",
  darwin: "Library/Caches/ms-playwright",
  win32: "AppData/Local/ms-playwright",
};

const PLAYWRIGHT_EXECUTABLE_PATTERNS = {
  linux: [
    "chrome-linux/chrome",
    "chrome-linux64/chrome",
    "chrome-headless-shell-linux/chrome-headless-shell",
    "chrome-headless-shell-linux64/chrome-headless-shell",
  ],
  darwin: [
    "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    "chrome-headless-shell-mac/chrome-headless-shell",
  ],
  win32: [
    "chrome-win/chrome.exe",
    "chrome-win64/chrome.exe",
    "chrome-headless-shell-win/chrome-headless-shell.exe",
    "chrome-headless-shell-win64/chrome-headless-shell.exe",
  ],
};

const SYSTEM_CHROMIUM_PATHS = {
  linux: [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
  ],
  darwin: [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ],
  win32: [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ],
};

/**
 * Resolve a headless Chromium executable without requiring the Playwright
 * browser downloader. Priority: explicit path → LATTICE_CHROMIUM → newest
 * Playwright cache revision (full Chromium before headless shell) → well-known
 * system installations.
 */
export function resolveChromiumExecutable({
  explicitPath = null,
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
  exists = (candidate) => fs.existsSync(candidate),
  readdir = (directory) => fs.existsSync(directory) ? fs.readdirSync(directory) : [],
  join = path.join,
} = {}) {
  const candidates = [];
  if (explicitPath) candidates.push(explicitPath);
  if (env.LATTICE_CHROMIUM) candidates.push(env.LATTICE_CHROMIUM);

  const cacheRoots = [];
  if (env.PLAYWRIGHT_BROWSERS_PATH) cacheRoots.push(env.PLAYWRIGHT_BROWSERS_PATH);
  if (PLAYWRIGHT_CACHE_DIR[platform]) cacheRoots.push(join(homedir, PLAYWRIGHT_CACHE_DIR[platform]));

  const found = [];
  for (const cacheRoot of cacheRoots) {
    for (const entry of readdir(cacheRoot)) {
      const match = String(entry).match(/^chromium(?:-headless_shell)?-(\d+)$/);
      if (!match) continue;
      for (const relative of PLAYWRIGHT_EXECUTABLE_PATTERNS[platform] ?? []) {
        const executable = join(cacheRoot, entry, relative);
        if (exists(executable)) {
          found.push({
            executable,
            revision: Number(match[1]),
            headlessShell: entry.includes("headless_shell"),
          });
          break;
        }
      }
    }
  }
  found.sort((left, right) => right.revision - left.revision || Number(left.headlessShell) - Number(right.headlessShell));
  candidates.push(...found.map((entry) => entry.executable));

  candidates.push(...(SYSTEM_CHROMIUM_PATHS[platform] ?? []));
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

/**
 * Launch headless Chromium with the deterministic flags shared by every
 * headless engine command (rendered inspection, screenshots). LCD subpixel
 * text antialiasing is disabled: Chromium enables it per paint context based
 * on the layer backdrop, so the same slide rasterizes with different glyph
 * coverage in a multi-stylesheet portal page and in a single-bundle static
 * export. Grayscale AA makes text pixels identical across hosting surfaces.
 */
export async function launchHeadlessBrowser(executable) {
  return chromium.launch({
    headless: true,
    executablePath: executable,
    args: ["--force-color-profile=srgb", "--disable-dev-shm-usage", "--disable-lcd-text"],
  });
}

async function warmupAttempt({ page, deckUrl, timeoutMs }) {
  let outdatedOptimizeDep = false;
  const onResponse = (response) => {
    if (response.status() === 504 && OPTIMIZED_DEP_URL.test(response.url())) {
      outdatedOptimizeDep = true;
    }
  };
  page.on("response", onResponse);
  try {
    try {
      await page.goto(deckUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    } catch {
      return { published: false, outdatedOptimizeDep };
    }
    const published = await page.waitForFunction(
      () => window.__latticeInspection !== undefined,
      undefined,
      { polling: 250, timeout: timeoutMs },
    ).then(() => true, () => false);
    return { published, outdatedOptimizeDep };
  } finally {
    page.off("response", onResponse);
  }
}

/**
 * Prewarm the actual deck module graph before measurement: Vite discovers and
 * optimizes dependencies while the first pages load, and a cold or externally
 * invalidated cache (concurrent dev/validate servers) makes optimized-dep
 * requests answer HTTP 504 "Outdated Optimize Dep", killing the app before it
 * can publish its inspection report. The prewarm pass absorbs that race —
 * including Vite client's own "optimized dependencies changed" reloads — so
 * the measurement pass that follows runs against a stable graph.
 *
 * The pass is best-effort and narrowly classified: it never produces findings
 * and only retries on observed optimized-dep 504s. Genuinely broken apps time
 * out here without retries and are reported by the single-shot measurement
 * pass with its normal blocking semantics.
 */
export async function warmupDeck({ page, deck, deckUrl, timeoutMs }) {
  const warmupTimeoutMs = Math.max(timeoutMs, WARMUP_MIN_TIMEOUT_MS);
  for (let attempt = 1; attempt <= WARMUP_MAX_ATTEMPTS; attempt += 1) {
    const { published, outdatedOptimizeDep } = await warmupAttempt({ page, deckUrl, timeoutMs: warmupTimeoutMs });
    if (published) {
      // Absorb Vite's post-optimization reload window: the dev server can
      // finish optimizing dependencies and order a full reload AFTER the app
      // already published its readiness signal. The reload wipes
      // `window.__latticeInspection`, so wait, then re-verify it is present
      // before declaring the page warm.
      await sleep(750);
      const stillPublished = await page
        .waitForFunction(() => window.__latticeInspection !== undefined, undefined, { polling: 250, timeout: Math.min(warmupTimeoutMs, 5000) })
        .then(() => true, () => false);
      if (stillPublished) return true;
      continue;
    }
    if (!outdatedOptimizeDep || attempt === WARMUP_MAX_ATTEMPTS) {
      if (outdatedOptimizeDep) {
        console.error(`[lattice] inspect: deck "${deck}" kept hitting Outdated Optimize Dep responses during prewarm; continuing to measurement`);
      }
      return false;
    }
  }
  return false;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for the explicit app-ready signal published by the runtime's rendered
 * inspection hook (window.__latticeInspection, set only after fonts and image
 * decode). Shared by every headless command that consumes the readiness
 * contract.
 */
export async function waitForAppReady(page, timeoutMs) {
  return page.waitForFunction(
    () => window.__latticeInspection !== undefined,
    undefined,
    { polling: 250, timeout: timeoutMs },
  );
}
