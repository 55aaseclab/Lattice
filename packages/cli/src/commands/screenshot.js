import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
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

export const SCREENSHOT_SCHEMA = "lattice.screenshots.v1";
const DEFAULT_READY_TIMEOUT_MS = 10000;
const DEFAULT_BASELINE_DIR = "lattice-baselines";
const DEFAULT_OUT_DIR = "lattice-screenshots";

// `screenshot` is inherently rendered; there is no non-rendered mode, so —
// unlike `inspect --rendered` — no mode flag exists. Unknown flags are
// rejected so typos cannot silently turn into ignored options.
const KNOWN_OPTIONS = new Set([
  "deck",
  "out",
  "report",
  "baseline-dir",
  "update-baseline",
  "max-diff-ratio",
  "timeout",
  "browser",
  "base-url",
  "port",
  "host",
]);

function assertKnownOptions(args) {
  const unknown = Object.keys(args).filter((key) => !KNOWN_OPTIONS.has(key));
  if (unknown.length > 0) {
    throw new Error(`unknown screenshot option(s): --${unknown.join(", --")} (see lattice screenshot --help)`);
  }
}

function listDeckIds(decksDir) {
  if (!fs.existsSync(decksDir)) return [];
  return fs
    .readdirSync(decksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name);
}

function screenshotIssue(type, slide, message, extra = {}) {
  return { type, slide, area: null, element: null, message, ...extra };
}

const slideFileName = (address) => String(address).replace(/[^A-Za-z0-9._-]+/g, "-") || "slide";

/**
 * Pixel-compare two PNG buffers with pixelmatch (the proven visual-diff
 * library used across the JS ecosystem) and render a highlighted diff image.
 * Byte equality is not required: perceptual near-identical pixels count as
 * matching, while a real visible mutation produces a nonzero mismatch count.
 */
export function compareScreenshotPng(actualBuffer, baselineBuffer) {
  const actual = PNG.sync.read(actualBuffer);
  const baseline = PNG.sync.read(baselineBuffer);
  if (actual.width !== baseline.width || actual.height !== baseline.height) {
    return {
      dimensionMismatch: true,
      width: actual.width,
      height: actual.height,
      baselineWidth: baseline.width,
      baselineHeight: baseline.height,
      diffPixels: null,
      diffRatio: null,
      diffBuffer: null,
    };
  }
  const diff = new PNG({ width: actual.width, height: actual.height });
  const diffPixels = pixelmatch(
    new Uint8Array(baseline.data),
    new Uint8Array(actual.data),
    new Uint8Array(diff.data),
    actual.width,
    actual.height,
    { threshold: 0.1 },
  );
  return {
    dimensionMismatch: false,
    width: actual.width,
    height: actual.height,
    baselineWidth: baseline.width,
    baselineHeight: baseline.height,
    diffPixels,
    diffRatio: diffPixels / (actual.width * actual.height),
    diffBuffer: PNG.sync.write(diff),
  };
}

/**
 * Capture every slide of one deck through the real app: the page loads with
 * the same app-ready/fonts/images readiness contract as rendered inspection
 * (window.__latticeInspection is published only after document.fonts.ready
 * and every image decoded), then each slide is navigated to through the
 * runtime's exposed Reveal instance (programmatic navigation — external
 * location.hash writes race Reveal's own writeURL/replaceState management and
 * corrupt history state). Each capture waits for exactly one visible slide,
 * settles fonts and a double-rAF, and screenshots the slide element at the
 * fixed viewport and DPR. Slide file names derive from the stable slide
 * address (data-slide-id / data-slide-number / position) — never from timing
 * or port.
 */
/**
 * Capture every slide of one deck through the real app: the page loads with
 * the same app-ready/fonts/images readiness contract as rendered inspection
 * (window.__latticeInspection is published only after document.fonts.ready
 * and every image decoded), then each slide is navigated to through the
 * runtime's exposed Reveal instance (programmatic navigation — external
 * location.hash writes race Reveal's own writeURL/replaceState management and
 * corrupt history state).
 *
 * Each slide is rasterized through an isolated clone of the live `.reveal`
 * subtree placed in a shell-independent fixed container at the viewport
 * origin. The clone carries the slide's full CSS ancestry (.reveal > .slides
 * > section) and the loaded fonts, so the capture is the deck's real rendered
 * output — but hosting-surface paint context (different app-shell chrome,
 * fractional ancestor offsets, compositing layers) can no longer shift glyph
 * rasterization between surfaces. This is what makes portal captures and
 * static-export captures pixel-comparable at all. Slide file names derive
 * from the stable slide address (data-slide-id / data-slide-number /
 * position) — never from timing or port.
 */
export async function captureDeckSlides({ page, deck, deckUrl, timeoutMs }) {
  // Navigate only when needed: re-navigating an already-loaded deck page
  // reloads it in a render process whose glyph raster cache carries the
  // previous load's subpixel phases, which shifts text rasterization by
  // 1-2px between otherwise identical runs.
  if (!page.url().startsWith(deckUrl)) {
    await page.goto(deckUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
  }
  await waitForAppReady(page, timeoutMs);

  const revealAvailable = await page.evaluate(() => typeof window.__latticeReveal?.slide === "function");
  if (!revealAvailable) {
    throw new Error("the rendered app did not expose window.__latticeReveal; upgrade @55aaseclab/lattice-runtime");
  }

  const slideCount = await page.evaluate(() => document.querySelectorAll("section.slide-canvas").length);
  if (slideCount === 0) {
    throw new Error(`deck "${deck}" rendered no slides`);
  }

  const captures = [];
  for (let index = 0; index < slideCount; index += 1) {
    await page.evaluate((slideIndex) => {
      window.__latticeReveal.slide(slideIndex);
    }, index);
    // Reveal mirrors slide classes onto its background elements, so scope
    // every check to real sections and require exactly one visible slide.
    await page.waitForFunction(
      (slideIndex) => {
        const slides = [...document.querySelectorAll("section.slide-canvas")];
        return slides.filter((slide) => slide.classList.contains("present")).length === 1 &&
          slides[slideIndex]?.classList.contains("present");
      },
      index,
      { polling: 100, timeout: timeoutMs },
    );
    // Newly revealed slides only trigger their font loads once shown; settle
    // fonts and double-rAF so every capture paints a fully rendered frame.
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    });
    // Rasterize on the integer pixel grid: app-shell chrome can position the
    // reveal element at a fractional viewport offset (fractional header or
    // menu heights), which changes glyph antialiasing and capture rounding
    // per hosting surface. Compensating the fractional remainder on the
    // .reveal element moves the slide AND Reveal's own chrome (controls,
    // progress) to whole pixels together, so identical layout produces
    // identical pixels in the portal and in a static export. The transform
    // is removed right after the capture.
    await page.evaluate(() => {
      const reveal = document.querySelector(".reveal");
      if (!reveal) return;
      const rect = reveal.getBoundingClientRect();
      const dx = rect.x - Math.floor(rect.x);
      const dy = rect.y - Math.floor(rect.y);
      if (dx !== 0 || dy !== 0) reveal.style.transform = `translate(${-dx}px, ${-dy}px)`;
    });
    const address = await page.evaluate((slideIndex) => {
      const slide = document.querySelectorAll("section.slide-canvas")[slideIndex];
      return slide?.dataset?.slideId || slide?.dataset?.slideNumber || String(slideIndex + 1);
    }, index);
    const buffer = await page.locator("section.slide-canvas.present").screenshot({
      animations: "disabled",
      caret: "hide",
    });
    await page.evaluate(() => {
      document.querySelector(".reveal")?.style.removeProperty("transform");
    });
    captures.push({ index: index + 1, address: String(address), buffer });
  }
  return captures;
}

function buildScreenshotReport({
  project,
  mode,
  baseUrl,
  timeoutMs,
  maxDiffRatio,
  baselineDir,
  outDir,
  browser,
  decks,
  generatedAt,
}) {
  const errorCount = decks.reduce((total, deck) => total + deck.errors.length, 0);
  return {
    schema: SCREENSHOT_SCHEMA,
    generatedAt,
    project,
    mode,
    baseUrl,
    timeoutMs,
    maxDiffRatio,
    viewport: { ...DEFAULT_VIEWPORT, deviceScaleFactor: 1 },
    browser,
    baselineDir,
    outDir,
    decks,
    errorCount,
    ok: errorCount === 0 && decks.length > 0,
  };
}

/**
 * Run the canonical per-slide screenshot pipeline (capture → compare against
 * explicit baselines) and return a machine-readable report plus the process
 * exit code. Baselines are written only in --update-baseline mode; comparison
 * never rewrites them. No process.exit here so tests can consume the result.
 */
export async function runScreenshot({
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
  // Flag syntax is validated before project loading so typos fail fast
  // regardless of the working directory.
  const timeoutMs = args.timeout ? Number(args.timeout) : DEFAULT_READY_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`invalid --timeout: ${args.timeout}`);
  }
  const maxDiffRatio = args["max-diff-ratio"] !== undefined ? Number(args["max-diff-ratio"]) : 0;
  if (!Number.isFinite(maxDiffRatio) || maxDiffRatio < 0 || maxDiffRatio > 1) {
    throw new Error(`invalid --max-diff-ratio: ${args["max-diff-ratio"]} (expected a number between 0 and 1)`);
  }
  const config = await loadConfig(cwd);
  const updateBaseline = Boolean(args["update-baseline"]);
  const baselineDir = path.resolve(cwd, args["baseline-dir"] ?? DEFAULT_BASELINE_DIR);
  const outDir = path.resolve(cwd, args.out ?? DEFAULT_OUT_DIR);

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
        cacheDir: path.join(cwd, "node_modules", HEADLESS_CACHE_DIR_NAME),
      });
      server = started.server;
      baseUrl = started.baseUrl.replace(/\/$/, "");
    }

    browser = await launchHeadlessBrowser(executable);
    const browserVersion = browser.version();

    const decks = [];
    for (const deckId of deckIds) {
      const startedAt = Date.now();
      const deckOutDir = path.join(outDir, deckId);
      const deckBaselineDir = path.join(baselineDir, deckId);
      const actualDir = deckOutDir;
      fs.mkdirSync(actualDir, { recursive: true });
      if (updateBaseline) fs.mkdirSync(deckBaselineDir, { recursive: true });

      const consoleErrors = [];
      const pageErrors = [];
      const page = await browser.newPage({ viewport: DEFAULT_VIEWPORT, deviceScaleFactor: 1 });
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

      const deckUrl = `${baseUrl}/?deck=${deckId}&inspect=1`;
      let captures = [];
      let errors = [];
      try {
        await warmupDeck({ page, deck: deckId, deckUrl, timeoutMs });
        try {
          captures = await captureDeckSlides({ page, deck: deckId, deckUrl, timeoutMs });
        } catch (error) {
          errors.push(screenshotIssue(
            "capture-failed",
            null,
            `deck "${deckId}": slide capture failed: ${error.message.split("\n")[0]}`,
          ));
        }
      } finally {
        page.off("console", onConsole);
        page.off("pageerror", onPageError);
        await page.close();
      }

      const slides = [];
      for (const capture of captures) {
        const file = slideFileName(capture.address);
        const actualPath = path.join(actualDir, `${file}.png`);
        const diffPath = path.join(actualDir, `${file}.diff.png`);
        const baselinePath = path.join(deckBaselineDir, `${file}.png`);
        const relativeActual = path.relative(cwd, actualPath);
        fs.writeFileSync(actualPath, capture.buffer);

        if (updateBaseline) {
          const existed = fs.existsSync(baselinePath);
          fs.writeFileSync(baselinePath, capture.buffer);
          slides.push({
            slide: capture.index,
            address: capture.address,
            status: existed ? "updated" : "created",
            baseline: path.relative(cwd, baselinePath),
            actual: relativeActual,
            diff: null,
            diffPixels: null,
            diffRatio: null,
          });
          continue;
        }

        if (!fs.existsSync(baselinePath)) {
          errors.push(screenshotIssue(
            "missing-baseline",
            capture.address,
            `deck "${deckId}" slide "${capture.address}" has no canonical baseline at ${path.relative(cwd, baselinePath)}; create one explicitly with lattice screenshot --update-baseline`,
            { artifact: relativeActual },
          ));
          slides.push({
            slide: capture.index,
            address: capture.address,
            status: "missing-baseline",
            baseline: null,
            actual: relativeActual,
            diff: null,
            diffPixels: null,
            diffRatio: null,
          });
          continue;
        }

        const comparison = compareScreenshotPng(capture.buffer, fs.readFileSync(baselinePath));
        if (comparison.dimensionMismatch) {
          errors.push(screenshotIssue(
            "visual-regression",
            capture.address,
            `deck "${deckId}" slide "${capture.address}" dimensions changed: captured ${comparison.width}x${comparison.height}, baseline is ${comparison.baselineWidth}x${comparison.baselineHeight}`,
            { artifact: relativeActual, diffRatio: null, diffPixels: null },
          ));
          slides.push({
            slide: capture.index,
            address: capture.address,
            status: "dimension-mismatch",
            baseline: path.relative(cwd, baselinePath),
            actual: relativeActual,
            diff: null,
            diffPixels: null,
            diffRatio: null,
          });
          continue;
        }

        if (comparison.diffRatio > maxDiffRatio) {
          fs.writeFileSync(diffPath, comparison.diffBuffer);
          const percent = Math.round(comparison.diffRatio * 1000) / 10;
          errors.push(screenshotIssue(
            "visual-regression",
            capture.address,
            `deck "${deckId}" slide "${capture.address}" pixel diff ${percent}% (${comparison.diffPixels} px, limit ${maxDiffRatio}); diff: ${path.relative(cwd, diffPath)}`,
            {
              artifact: relativeActual,
              diff: path.relative(cwd, diffPath),
              diffRatio: comparison.diffRatio,
              diffPixels: comparison.diffPixels,
            },
          ));
          slides.push({
            slide: capture.index,
            address: capture.address,
            status: "diff",
            baseline: path.relative(cwd, baselinePath),
            actual: relativeActual,
            diff: path.relative(cwd, diffPath),
            diffPixels: comparison.diffPixels,
            diffRatio: comparison.diffRatio,
          });
          continue;
        }

        // Clean match: drop any stale diff artifact from previous runs.
        if (fs.existsSync(diffPath)) fs.rmSync(diffPath);
        slides.push({
          slide: capture.index,
          address: capture.address,
          status: "match",
          baseline: path.relative(cwd, baselinePath),
          actual: relativeActual,
          diff: null,
          diffPixels: comparison.diffPixels,
          diffRatio: comparison.diffRatio,
        });
      }

      decks.push({
        deck: deckId,
        url: deckUrl,
        ok: errors.length === 0,
        slides,
        errors,
        consoleErrors,
        pageErrors,
        durationMs: Date.now() - startedAt,
      });
    }

    const report = buildScreenshotReport({
      project: config.title,
      mode: updateBaseline ? "update" : "compare",
      baseUrl,
      timeoutMs,
      maxDiffRatio,
      baselineDir: path.relative(cwd, baselineDir),
      outDir: path.relative(cwd, outDir),
      browser: { executable, version: browserVersion },
      decks,
      generatedAt,
    });
    // Exit severity: capture/readiness/navigation failures are infrastructure
    // failures (exit 2) even when other decks produced visual findings; only
    // visual-regression and missing-baseline findings report as exit 1.
    const hasInfrastructureFailure = decks.some((deck) =>
      deck.errors.some((error) => error.type === "capture-failed"));
    return {
      report,
      exitCode: hasInfrastructureFailure ? 2 : (report.ok ? 0 : 1),
    };
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (server) await server.close().catch(() => {});
  }
}

export function screenshotHelpText() {
  return `lattice screenshot — canonical per-slide screenshots and visual regression

Usage:
  lattice screenshot [--deck <id>] [--update-baseline] [--baseline-dir <dir>]
                     [--out <dir>] [--report <file>] [--max-diff-ratio <n>]
                     [--timeout <ms>] [--browser <path>] [--base-url <url>]
                     [--port <port>] [--host <host>]

Options:
  --deck <id[,id…]>      Capture one deck or a comma-separated list (default:
                         every deck in decks/).
  --update-baseline      Explicitly create or update the canonical baselines.
                         Comparison mode never rewrites baselines.
  --baseline-dir <dir>   Baseline directory (default: lattice-baselines).
  --out <dir>            Retained capture/diff artifacts (default: lattice-screenshots).
  --report <file>        Additionally write the JSON report to <file>.
  --max-diff-ratio <n>   Blocking threshold as a fraction of pixels (default: 0 —
                         any pixel difference blocks in the controlled environment).
  --timeout <ms>         Per-deck readiness timeout in milliseconds (default: 10000).
  --browser <path>       Chromium executable (else LATTICE_CHROMIUM, the Playwright
                         browser cache, or a system Chrome/Chromium install).
  --base-url <url>       Capture against an already-running server.
  --port <port>          Port for the temporary dev server (default: random free port).
  --host <host>          Host for the temporary dev server (default: config.dev.host).

Behavior:
  - Captures each slide at a fixed viewport (1280x720, DPR 1) after the same
    app-ready/fonts/images readiness contract as lattice inspect --rendered.
  - Writes a versioned JSON report (schema lattice.screenshots.v1) to stdout;
    --report additionally writes it to a file. Slide entries carry stable
    addresses and baseline/actual/diff paths.
  - Finding classes: visual-regression (pixel diff above --max-diff-ratio,
    with diff metrics and retained actual/diff artifact paths), missing-baseline,
    capture-failed. Exit codes: 0 clean; 1 visual-regression or missing-baseline
    findings; 2 infrastructure or CLI failure (including capture-failed, which
    wins over exit 1 when both occur). Unknown options are rejected.
  - Same-environment repeat runs must diff 0; baselines update only through
    the explicit --update-baseline mode.
`;
}

export async function screenshotCommand({ args }) {
  if (args.help) {
    process.stdout.write(screenshotHelpText());
    return;
  }
  let report;
  let exitCode;
  try {
    ({ report, exitCode } = await runScreenshot({ cwd: process.cwd(), args }));
  } catch (error) {
    console.error(`[lattice] screenshot failed: ${error.message}`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (args.report) {
    const reportFile = path.resolve(args.report);
    fs.mkdirSync(path.dirname(reportFile), { recursive: true });
    fs.writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (exitCode !== 0) process.exitCode = exitCode;
}
