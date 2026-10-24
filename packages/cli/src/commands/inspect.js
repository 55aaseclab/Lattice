import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../config/index.js";
import { startProjectServer } from "./dev-server.js";
import {
  DEFAULT_VIEWPORT,
  HEADLESS_CACHE_DIR_NAME,
  launchHeadlessBrowser,
  resolveChromiumExecutable,
  waitForAppReady,
  warmupDeck,
} from "./browser.js";

// Test-compat re-export: the Chromium resolver now lives in browser.js.
export { resolveChromiumExecutable };

export const INSPECTION_SCHEMA = "lattice.inspection.v1";
const DEFAULT_READY_TIMEOUT_MS = 10000;

// `--rendered` is the canonical PRD spelling (3.1.4); bare `lattice inspect`
// stays as a documented compatibility alias. Any other flag is rejected so
// typos cannot silently turn into ignored options.
const KNOWN_OPTIONS = new Set(["deck", "out", "timeout", "browser", "base-url", "port", "host", "rendered"]);

function assertKnownOptions(args) {
  const unknown = Object.keys(args).filter((key) => !KNOWN_OPTIONS.has(key));
  if (unknown.length > 0) {
    throw new Error(`unknown inspect option(s): --${unknown.join(", --")} (see lattice inspect --help)`);
  }
}

function listDeckIds(decksDir) {
  if (!fs.existsSync(decksDir)) return [];
  return fs
    .readdirSync(decksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
}

function inspectionIssue(type, deck, element, message, extra = {}) {
  return { type, slide: deck, area: null, element, message, ...extra };
}

function pageErrorIssues(deck, pageErrors) {
  return pageErrors.map((text) => inspectionIssue(
    "page-error",
    deck,
    "page",
    `deck "${deck}": uncaught page error: ${text}`,
  ));
}

async function inspectDeck({ page, deck, deckUrl, timeoutMs }) {
  const startedAt = Date.now();
  const consoleErrors = [];
  const pageErrors = [];
  const onConsole = (message) => {
    if (message.type() !== "error") return;
    const entry = { text: message.text() };
    const url = message.location()?.url;
    if (url) entry.url = url;
    consoleErrors.push(entry);
  };
  const onPageError = (error) => pageErrors.push(String(error?.message ?? error));
  page.on("console", onConsole);
  page.on("pageerror", onPageError);

  try {
    try {
      await page.goto(deckUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    } catch (error) {
      return {
        deck,
        url: deckUrl,
        ok: false,
        slides: 0,
        errors: [
          inspectionIssue("navigation-failed", deck, "page load", `deck "${deck}": page load failed: ${error.message.split("\n")[0]}`),
          ...pageErrorIssues(deck, pageErrors),
        ],
        consoleErrors,
        pageErrors,
        durationMs: Date.now() - startedAt,
      };
    }

    try {
      await waitForAppReady(page, timeoutMs);
    } catch {
      return {
        deck,
        url: deckUrl,
        ok: false,
        slides: 0,
        errors: [
          inspectionIssue(
            "ready-timeout",
            deck,
            "document readiness",
            `deck "${deck}": app-ready signal (window.__latticeInspection) not published within ${timeoutMs}ms; fonts, images, or the app itself never became ready`,
          ),
          ...pageErrorIssues(deck, pageErrors),
        ],
        consoleErrors,
        pageErrors,
        durationMs: Date.now() - startedAt,
      };
    }

    const report = await page.evaluate(() => window.__latticeInspection);
    // Uncaught page errors block the deck even when the app managed to publish
    // a clean inspection report; ordinary console.error noise stays
    // diagnostic-only (captured in consoleErrors, never in errors).
    const errors = [...(report.errors ?? []), ...pageErrorIssues(deck, pageErrors)];
    return {
      deck,
      url: deckUrl,
      ok: errors.length === 0,
      slides: report.slides ?? 0,
      readiness: report.readiness ?? null,
      errors,
      consoleErrors,
      pageErrors,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    page.off("console", onConsole);
    page.off("pageerror", onPageError);
  }
}

function buildArtifact({ project, baseUrl, timeoutMs, viewport, browser, decks, generatedAt }) {
  const errorCount = decks.reduce((total, deck) => total + deck.errors.length, 0);
  return {
    schema: INSPECTION_SCHEMA,
    generatedAt,
    project,
    baseUrl,
    timeoutMs,
    viewport,
    browser,
    decks,
    errorCount,
    ok: errorCount === 0 && decks.length > 0,
  };
}

/**
 * Run the full rendered-inspection pipeline and return a machine-readable
 * artifact plus the process exit code. No process.exit here so tests (and the
 * command wrapper) can consume the result directly.
 */
export async function runInspection({
  cwd = process.cwd(),
  args = {},
  env = process.env,
  homedir = os.homedir(),
  platform = process.platform,
  exists = (candidate) => fs.existsSync(candidate),
  readdir = (directory) => fs.existsSync(directory) ? fs.readdirSync(directory) : [],
  generatedAt = new Date().toISOString(),
} = {}) {
  assertKnownOptions(args);
  const config = await loadConfig(cwd);
  const timeoutMs = args.timeout ? Number(args.timeout) : DEFAULT_READY_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`invalid --timeout: ${args.timeout}`);
  }

  const decksDir = path.resolve(cwd, config.decksDir);
  const deckIds = args.deck ? String(args.deck).split(",") : listDeckIds(decksDir);
  if (deckIds.length === 0) {
    throw new Error(`no decks found in ${config.decksDir} (pass --deck <id> or add decks)`);
  }

  const executable = resolveChromiumExecutable({ explicitPath: args.browser ?? null, env, platform, homedir, exists, readdir });
  if (!executable) {
    throw new Error(
      "no headless Chromium found; pass --browser <path>, set LATTICE_CHROMIUM, install browsers via `npx playwright install chromium`, or install Chrome/Chromium system-wide",
    );
  }

  let server = null;
  let baseUrl = args["base-url"] ? String(args["base-url"]).replace(/\/$/, "") : null;
  let browser = null;
  try {
    if (!baseUrl) {
      const started = await startProjectServer({
        cwd,
        config,
        port: args.port ? Number(args.port) : 0,
        host: args.host ?? config.dev.host,
        // Isolate the dependency optimizer from concurrent dev/validate
        // servers sharing the project's default Vite cache: their config-hash
        // mismatch invalidates optimized-dep URLs while pages load.
        cacheDir: path.join(cwd, "node_modules", HEADLESS_CACHE_DIR_NAME),
      });
      server = started.server;
      baseUrl = started.baseUrl.replace(/\/$/, "");
    }

    browser = await launchHeadlessBrowser(executable);
    const browserVersion = browser.version();

    const decks = [];
    for (const deckId of deckIds) {
      const page = await browser.newPage({
        viewport: DEFAULT_VIEWPORT,
        deviceScaleFactor: 1,
      });
      const deckUrl = `${baseUrl}/?deck=${deckId}&inspect=1`;
      try {
        await warmupDeck({ page, deck: deckId, deckUrl, timeoutMs });
        decks.push(await inspectDeck({ page, deck: deckId, deckUrl, timeoutMs }));
      } finally {
        await page.close();
      }
    }

    const report = buildArtifact({
      project: config.title,
      baseUrl,
      timeoutMs,
      viewport: DEFAULT_VIEWPORT,
      browser: { executable, version: browserVersion },
      decks,
      generatedAt,
    });
    return { report, exitCode: report.ok ? 0 : 1 };
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await server.close().catch(() => {});
  }
}

export function inspectHelpText() {
  return `lattice inspect --rendered — headless rendered inspection

Usage:
  lattice inspect --rendered [--deck <id>] [--out <file>] [--timeout <ms>]
                  [--browser <path>] [--base-url <url>] [--port <port>] [--host <host>]

Options:
  --rendered       Canonical form (PRD 3.1.4); rendered inspection is the only mode today.
  --deck <id[,id…]>  Inspect one deck or a comma-separated list (default: every
                     deck in decks/).
  --out <file>     Additionally write the JSON artifact to <file>.
  --timeout <ms>   Per-deck readiness timeout in milliseconds (default: 10000).
  --browser <path> Chromium executable (else LATTICE_CHROMIUM, the Playwright
                   browser cache, or a system Chrome/Chromium install).
  --base-url <url> Inspect an already-running server instead of starting one.
  --port <port>    Port for the temporary dev server (default: a random free port).
  --host <host>    Host for the temporary dev server (default: config.dev.host).

Behavior:
  - Launches headless Chromium, renders each deck with ?inspect=1, and waits
    for the explicit app-ready signal (window.__latticeInspection), which the
    runtime publishes only after document.fonts.ready and every image has
    finished loading and decoding.
  - Prewarms each deck's real module graph with a dedicated Vite dependency
    cache, so cold starts or concurrent dev/validate servers cannot turn
    "Outdated Optimize Dep" races into false ready-timeouts. The measurement
    pass itself is single-shot and never retried.
  - stdout always carries the JSON report (schema lattice.inspection.v1);
    --out additionally writes it to a file.
  - Exit codes: 0 clean; 1 blocking findings (overflow/contrast/density,
    ready-timeout, missing-asset, navigation-failed, uncaught page errors);
    2 infrastructure failure (e.g. no Chromium found). console.error noise is
    recorded as diagnostics only.
  - "lattice inspect" without --rendered is a documented compatibility alias;
    unknown options are rejected with exit code 2.
`;
}

export async function inspectCommand({ args }) {
  if (args.help) {
    process.stdout.write(inspectHelpText());
    return;
  }
  let report;
  try {
    ({ report } = await runInspection({ cwd: process.cwd(), args }));
  } catch (error) {
    console.error(`[lattice] inspect failed: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (args.out) {
    const outFile = path.resolve(args.out);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (!report.ok) process.exitCode = 1;
}
