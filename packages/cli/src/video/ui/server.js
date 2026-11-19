// The M7 video workbench, hosted as a deck-scoped portal route (issue 005).
//
// Video is a subordinate capability of a deck: the workbench is served by the
// `lattice dev` process itself under /workbench/<deck-id> — no second
// listening port, no lazy start, no separate process lifecycle. This module
// exports a connect-compatible request handler that the portal loads
// dynamically when the first /workbench request arrives (the A35 load
// boundary: dev/present/export static module graphs never reach video code,
// and this module never opens a port of its own).
//
// Surfaces:
//   GET /workbench                 → deck picker (fallback entry without an id)
//   GET /workbench/<deck-id>       → strictly deck-scoped view: one deck's
//                                    timeline (segments × stops × narration/bgm
//                                    lanes), doctor, render progress, preview,
//                                    deck-filtered artifacts, "← Portal" — no
//                                    deck list, no switcher, no other decks
//   /workbench/api/…               → the JSON API over the exact compile/render
//                                    path the CLI uses
//
// The render queue runs inside the portal process (serial, as before).
// Accepted trade: a portal restart interrupts in-flight renders; artifacts
// under .lattice/generated/ are re-renderable. Every artifact path stays
// server-enforced inside .lattice/generated/.

import fsSync from "node:fs";
import fsp from "node:fs/promises";
import { createReadStream } from "node:fs";
import { imageCache } from "../../http/image-cache.js";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { listDeckIds, readManifest } from "../../edit/deck-view.js";
import { compileDeckVideoPlan } from "../../commands/video.js";
import { ensureBackendsInitialized, getBackend, listBackendIds } from "../registry.js";
import { resolveTimeline } from "@55aaseclab/lattice-runtime/timeline";
import { validateStopRevealAnimation } from "@55aaseclab/lattice-runtime/themes/simple-light/presets";

const GENERATED_ROOT_SEGMENTS = [".lattice", "generated"];
const UI_OUTPUT_SEGMENTS = [...GENERATED_ROOT_SEGMENTS, "video-ui"];

// Issue 007: the preview audio layer streams the deck's own frame-aligned
// audio assets (timeline.audioTracks srcs) from the deck directory.
const AUDIO_ASSET_EXTENSIONS = new Set([".wav", ".mp3", ".m4a", ".ogg", ".flac"]);

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "app");
// `?direct` makes the portal's Vite serve the stylesheet as plain CSS for the
// <link> (without it, dev serves CSS as an HMR JS module).
const APP_CSS_URL = `/@fs${APP_DIR}/app.css?direct`;
const APP_JS_URL = `/@fs${APP_DIR}/app.js`;
// Workbench modules whose contents version the /@fs URLs (issue 008): any
// edit produces a fresh module URL, so a normal refresh loads the new code —
// no hard reload, no dependence on browser revalidation of a stable URL.
const WORKBENCH_VERSIONED_FILES = ["app.js", "player.js", "app.css"];

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".avif": "image/avif",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
  ".webp": "image/webp",
};

function json(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (error) {
        reject(Object.assign(new Error(`request body is not valid JSON: ${error.message}`), { code: "invalid-json" }));
      }
    });
    req.on("error", reject);
  });
}

class ProcessExitSentinel extends Error {
  constructor(code) {
    super(`process.exit(${code}) was called by a reused CLI helper`);
    this.code = code;
    this.exitCode = code;
  }
}

/**
 * Reused CLI helpers signal failures with process.exit. The workbench must
 * survive failed renders, so the exit is converted into a thrown sentinel for
 * the duration of one job and every console line is captured into the job
 * log. The helpers themselves are untouched (M1–M6 behavior unchanged).
 */
async function withCapturedIO(log, fn) {
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;
  const originalWarn = console.warn;
  const append = (line) => log(String(line));
  process.exit = (code) => {
    throw new ProcessExitSentinel(code);
  };
  console.log = (...parts) => append(parts.map((part) => String(part)).join(" "));
  console.error = (...parts) => append(`[stderr] ${parts.map((part) => String(part)).join(" ")}`);
  console.warn = (...parts) => append(`[warn] ${parts.map((part) => String(part)).join(" ")}`);
  try {
    return await fn();
  } finally {
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
    console.warn = originalWarn;
  }
}

/**
 * Resolve a client-supplied artifact path against .lattice/generated/.
 * Anything outside the generated root — traversal, absolute paths, symlinks
 * escaping it — is rejected with a 400, never a 404, so the boundary is
 * explicit.
 */
function resolveGeneratedPath(cwd, relativePath) {
  const generatedRoot = path.resolve(cwd, ...GENERATED_ROOT_SEGMENTS);
  if (typeof relativePath !== "string" || relativePath === "") {
    return { error: "path is required" };
  }
  if (path.isAbsolute(relativePath)) {
    return { error: "absolute paths are not allowed; artifacts live under .lattice/generated/" };
  }
  // Clients address artifacts either relative to the generated root or by
  // their full .lattice/generated/… path (the artifact listing's form).
  const relative = relativePath.startsWith(`${GENERATED_ROOT_SEGMENTS.join("/")}/`)
    ? relativePath.slice(GENERATED_ROOT_SEGMENTS.join("/").length + 1)
    : relativePath;
  if (relative === "") {
    return { error: "path is required" };
  }
  const resolved = path.resolve(generatedRoot, relative);
  const rel = path.relative(generatedRoot, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    return { error: `path escapes .lattice/generated/: ${relativePath}` };
  }
  return { generatedRoot, resolved, relative: rel.split(path.sep).join("/") };
}

function createJobRunner({ cwd, config }) {
  const jobs = new Map();
  let jobSequence = 0;
  let queueTail = Promise.resolve();

  function enqueueJob(request) {
    const jobId = `job-${String(++jobSequence).padStart(4, "0")}`;
    const job = {
      id: jobId,
      deck: request.deck,
      backend: request.backend,
      route: request.route ?? "main",
      status: "queued",
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      log: [],
      result: null,
      error: null,
    };
    jobs.set(jobId, job);
    queueTail = queueTail
      .then(() => runJob(job))
      .catch(() => {});
    return job;
  }

  function log(job, line) {
    job.log.push(`${new Date().toISOString()} ${line}`);
    if (job.log.length > 2000) job.log.splice(0, job.log.length - 2000);
  }

  async function runJob(job) {
    job.status = "running";
    job.startedAt = new Date().toISOString();
    try {
      await withCapturedIO((line) => log(job, line), async () => {
        // 1. Ensure a real Slide Web Bundle exists (rendering needs one).
        //    Paths resolve against the project root (the handler's cwd), not
        //    the host process's working directory — the portal may have been
        //    started anywhere.
        const deckDir = path.resolve(cwd, config.decksDir, job.deck);
        const exportBundleDir = path.resolve(cwd, config.outDir, "static-decks", job.deck);
        if (!fsSync.existsSync(exportBundleDir)) {
          log(job, `no Slide Web Bundle at ${exportBundleDir}; running "lattice export --deck ${job.deck}"`);
          const cliEntry = fileURLToPath(new URL("../../index.js", import.meta.url));
          const exported = spawnSync(process.execPath, [cliEntry, "export", "--deck", job.deck], {
            cwd,
            encoding: "utf8",
            timeout: 10 * 60 * 1000,
          });
          for (const line of `${exported.stdout ?? ""}${exported.stderr ?? ""}`.split("\n").filter(Boolean)) log(job, `[export] ${line}`);
          if (exported.status !== 0) {
            throw new Error(`lattice export --deck ${job.deck} exited ${exported.status}; the workbench needs a real Slide Web Bundle to render`);
          }
        }

        // 2. Compile the plan through the exact CLI path.
        const { completePlan, planHash } = await compileDeckVideoPlan({
          args: { deck: job.deck, route: job.route },
          config,
          projectRoot: cwd,
        });
        log(job, `plan ${planHash.slice(0, 12)} compiled: ${completePlan.totalFrames} frames @ ${completePlan.fps} fps, ${completePlan.clips.length} clip(s), ${completePlan.audioTracks.length} audio track(s)`);
        job.planHash = planHash;

        // 3. Prepare and render through the selected backend.
        const backend = getBackend(job.backend);
        const projectRoot = cwd;
        const workDir = path.resolve(projectRoot, ...GENERATED_ROOT_SEGMENTS, backend.id);
        const prepared = await backend.prepare({
          plan: completePlan,
          bundleDir: path.resolve(cwd, config.outDir, "static-decks", job.deck),
          workDir,
          projectRoot,
        });
        log(job, `backend ${backend.id} prepared at ${prepared.workDir}`);

        const output = path.resolve(cwd, ...UI_OUTPUT_SEGMENTS, `${job.deck}-${backend.id}.mp4`);
        await fsp.mkdir(path.dirname(output), { recursive: true });
        const artifact = await backend.renderVideo({ prepared, output });
        log(job, `render complete: ${artifact.path}`);
        job.result = {
          planHash,
          path: path.relative(cwd, artifact.path).split(path.sep).join("/"),
          metadata: artifact.metadata,
        };
      });
      job.status = "done";
    } catch (error) {
      job.status = "failed";
      job.error = error instanceof ProcessExitSentinel
        ? `reused CLI helper exited (${error.exitCode}); see log`
        : String(error?.stack ?? error?.message ?? error);
      log(job, `FAILED: ${job.error}`);
    } finally {
      job.finishedAt = new Date().toISOString();
    }
  }

  return { jobs, enqueueJob };
}

/**
 * Issue 007 — resolve a timeline audioTrack's src against the deck directory
 * for the preview audio layer. Only existing audio files are exposed (decks
 * without narration/bgm assets preview silently); the returned URL is served
 * by the deck-assets route below with Range support for frame-addressed
 * seeking.
 */
function resolveDeckAudioAssets({ cwd, config, deckId, audioTracks }) {
  const deckDir = path.resolve(cwd, config.decksDir, deckId);
  const assets = [];
  for (const track of audioTracks ?? []) {
    if (typeof track?.src !== "string" || track.src.trim() === "") continue;
    const relative = track.src.replace(/^\.\//, "");
    const resolved = path.resolve(deckDir, relative);
    const rel = path.relative(deckDir, resolved);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) continue;
    if (!AUDIO_ASSET_EXTENSIONS.has(path.extname(resolved).toLowerCase())) continue;
    if (!fsSync.existsSync(resolved) || !fsSync.statSync(resolved).isFile()) continue;
    assets.push({
      id: track.id ?? path.basename(resolved),
      src: track.src,
      url: `/api/decks/${encodeURIComponent(deckId)}/assets/${rel.split(path.sep).join("/")}`,
      volume: typeof track.volume === "number" && Number.isFinite(track.volume) ? track.volume : 1,
      startFrame: Number.isInteger(track.startFrame) ? track.startFrame : 0,
    });
  }
  return assets;
}

async function loadDeckDescriptor({ cwd, config, deckId }) {
  const deckDir = path.resolve(cwd, config.decksDir, deckId);
  if (!fsSync.existsSync(path.join(deckDir, "manifest.json"))) {
    return null;
  }
  const manifest = readManifest(deckDir);
  if (manifest.schema !== "lattice.deck.v2") {
    return { error: `deck "${deckId}" is ${manifest.schema}; the workbench presents lattice.deck.v2 decks` };
  }
  const entrySlides = manifest.entry?.slides;
  if (typeof entrySlides !== "string" || entrySlides === "") {
    return { error: `deck "${deckId}" must declare manifest.entry.slides` };
  }
  const { createProjectModuleLoader } = await import("../../deck-v2/project-module-loader.js");
  const loader = await createProjectModuleLoader(cwd);
  try {
    const module = await loader.load(path.resolve(deckDir, entrySlides));
    const slideDefinitions = module?.slideDefinitions;
    if (!Array.isArray(slideDefinitions) || slideDefinitions.length === 0) {
      return { error: `deck "${deckId}": ${entrySlides} must export a non-empty slideDefinitions array` };
    }
    let resolved = null;
    if (manifest.timeline !== undefined) {
      const resolution = resolveTimeline({
        manifest,
        slides: slideDefinitions,
        validateAnimation: (animation, options) => validateStopRevealAnimation(animation, options),
      });
      if (!resolution.ok) {
        return { error: `deck "${deckId}" declares an invalid timeline: ${resolution.errors.map((error) => error.message).join("; ")}` };
      }
      resolved = resolution.timeline;
    }
    const entriesById = new Map((resolved?.slides ?? []).map((entry) => [entry.slideId, entry]));
    const slides = slideDefinitions.map((slide) => {
      const entry = entriesById.get(slide.id);
      const html = typeof slide.html === "function" ? slide.html() : slide.html;
      const descriptorSlide = {
        id: slide.id,
        html,
        durationFrames: entry?.durationFrames ?? slide.durationFrames,
        stops: entry
          ? entry.stops.map((timedStop) => {
              const definitionStop = (slide.stops ?? []).find((stop) => stop.id === timedStop.id);
              const stop = { id: timedStop.id, frame: timedStop.frame };
              if (definitionStop?.navigation) stop.navigation = definitionStop.navigation;
              return stop;
            })
          : (slide.stops ?? []).map((stop) => ({ id: stop.id, frame: stop.frame, navigation: stop.navigation })),
      };
      if (entry?.animation) descriptorSlide.animation = entry.animation;
      return descriptorSlide;
    });
    const { resolveRuntimeRoot } = await import("../../config/index.js");
    const themeCssPath = path.join(resolveRuntimeRoot(), "themes", "simple-light", "styles.css");
    const themeCss = await fsp.readFile(themeCssPath, "utf8");
    // M7: animation presets load only for decks that declare timeline
    // animation — the preview then plays with the exact CSS the video hosts
    // inline from the same theme file.
    const declaresAnimation = slides.some((slide) => slide.animation);
    const presetCss = declaresAnimation
      ? await fsp.readFile(path.join(resolveRuntimeRoot(), "themes", "simple-light", "presets.css"), "utf8")
      : "";
    const audioTracks = resolved?.audioTracks ?? manifest.audioTracks ?? [];
    return {
      descriptor: {
        schema: "lattice.video-ui-descriptor.v1",
        deckId,
        title: manifest.title,
        theme: manifest.theme,
        fps: manifest.fps,
        canvas: manifest.canvas,
        routes: manifest.routes,
        hasTimeline: manifest.timeline !== undefined,
        timeline: resolved,
        slides,
        themeCss,
        presetCss,
        audioTracks,
        // Issue 007: the preview audio layer — only tracks whose assets
        // actually exist on disk; a silent deck carries an empty list.
        audioAssets: resolveDeckAudioAssets({ cwd, config, deckId, audioTracks }),
      },
    };
  } finally {
    await loader.close();
  }
}

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);

/**
 * Build the workbench app shell from the app template. Both shells load the
 * same single-page app through the portal's own Vite (`/@fs/` URLs into the
 * CLI package — the same mechanism bundled theme assets already use); the
 * injected globals carry the API base and, for the scoped route, the strict
 * deck scope. The scoped shell adds the "← Portal" link and marks the body
 * so the deck picker stays hidden — no deck list, no switcher, no other deck.
 *
 * Issue 008: the module URLs carry a content-version query (`?v=<hash>`).
 * The workbench app is served through stable /@fs URLs whose browser
 * revalidation is not reliable across edits (the transform cache can answer
 * a conditional request from a not-yet-invalidated module), so the shell
 * versions the URLs itself: an edit changes the hash, the next shell (the
 * shell is re-read per request, below) hands the browser a URL it has never
 * cached, and the new code loads on a plain refresh.
 */
function renderWorkbenchShell({ template, deck, version }) {
  // The stylesheet URL already carries the `?direct` query; the module URLs
  // start their query with the version.
  let html = template
    .replace('href="./app.css"', `href="${APP_CSS_URL}${version ? `&v=${version}` : ""}"`)
    .replace('src="./app.js"', `src="${APP_JS_URL}${version ? `?v=${version}` : ""}"`);
  const globals = [
    `window.__LATTICE_WORKBENCH_BASE = ${JSON.stringify("/workbench")};`,
    `window.__LATTICE_WORKBENCH_ASSET_VERSION = ${JSON.stringify(version ?? null)};`,
  ];
  if (deck !== null) {
    globals.push(`window.__LATTICE_WORKBENCH_DECK = ${JSON.stringify(deck)};`);
    html = html
      .replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(deck)} · Video workbench</title>`)
      .replace('<body>', '<body class="wb-scoped">')
      .replace(
        '<header class="wb-header">',
        '<header class="wb-header"><a class="wb-back" href="/" data-zh="全部文稿">All decks</a>',
      );
  }
  html = html.replace("</head>", `  <script>${globals.join("\n")}</script>\n  </head>`);
  return html;
}

/**
 * Issue 008: read the shell fresh on every request. The template and the
 * versioned module sources are tiny; re-reading them means workbench code
 * and shell edits are visible on a normal refresh without restarting the
 * portal (the handler previously cached the template at creation time, so
 * edits showed only after a restart).
 */
async function readWorkbenchShell(deck) {
  const [template, ...sources] = await Promise.all([
    fsp.readFile(path.join(APP_DIR, "index.html"), "utf8"),
    ...WORKBENCH_VERSIONED_FILES.map((name) => fsp.readFile(path.join(APP_DIR, name), "utf8")),
  ]);
  const version = createHash("sha256").update(sources.join("\n")).digest("hex").slice(0, 16);
  return renderWorkbenchShell({ template, deck, version });
}

/**
 * Create the workbench route handler for one project. Called once per portal
 * server, lazily, when the first /workbench request hits; `await` performs
 * the dynamic backend initialization inside the portal process (the route
 * hit is the load boundary). The returned handler is a connect middleware
 * mounted at /workbench — req.url arrives with the mount prefix already
 * stripped (same semantics as the portal's other middlewares).
 */
export async function createWorkbenchHandler({ cwd, config }) {
  ensureBackendsInitialized();
  const runner = createJobRunner({ cwd, config });

  async function handleApi(req, res, pathname, searchParams) {
    if (req.method === "GET" && pathname === "/api/decks") {
      const decks = listDeckIds(path.resolve(cwd, config.decksDir)).map((deckId) => {
        let title = deckId;
        let schema = null;
        let hasTimeline = false;
        try {
          const manifest = readManifest(path.resolve(cwd, config.decksDir, deckId));
          title = manifest.title ?? deckId;
          schema = manifest.schema;
          hasTimeline = manifest.timeline !== undefined;
        } catch {
          // Unreadable manifest: listed with defaults, details surface on demand.
        }
        return { id: deckId, title, schema, hasTimeline };
      });
      json(res, 200, { decks, backends: listBackendIds() });
      return true;
    }

    if (req.method === "GET" && pathname === "/api/backends") {
      // The scoped view bootstraps from this endpoint instead of /api/decks,
      // so a strictly scoped page never pulls the project's other decks.
      json(res, 200, { backends: listBackendIds() });
      return true;
    }

    const descriptorMatch = req.method === "GET" && pathname.match(/^\/api\/decks\/([^/]+)\/descriptor$/);
    if (descriptorMatch) {
      const result = await loadDeckDescriptor({ cwd, config, deckId: decodeURIComponent(descriptorMatch[1]) });
      if (!result) {
        json(res, 404, { error: "deck not found" });
      } else if (result.error) {
        json(res, 422, { error: result.error });
      } else {
        json(res, 200, result.descriptor);
      }
      return true;
    }

    // AI audience v1.2 — the scoped workbench's 观众席 panel: the deck's
    // recorded rehearsal sessions (history, residual findings, verdict
    // status, score curve), aggregated from .lattice/audience-sessions/<deck>/
    // by the deterministic audience panel module. Strictly deck-scoped by
    // the route; no-store comes with json().
    const audienceMatch = req.method === "GET" && pathname.match(/^\/api\/decks\/([^/]+)\/audience$/);
    if (audienceMatch) {
      const deckId = decodeURIComponent(audienceMatch[1]);
      if (!fsSync.existsSync(path.resolve(cwd, config.decksDir, deckId, "manifest.json"))) {
        json(res, 404, { error: "deck not found" });
        return true;
      }
      const { buildAudiencePanelData } = await import("../../audience/panel.js");
      json(res, 200, buildAudiencePanelData(cwd, deckId));
      return true;
    }

    const assetMatch = req.method === "GET" && pathname.match(/^\/api\/decks\/([^/]+)\/assets\/(.+)$/);
    if (assetMatch) {
      // Issue 007: stream one deck audio asset (narration.wav / bgm.wav) so
      // the preview player can bind audio.currentTime to the frame clock.
      const deckId = decodeURIComponent(assetMatch[1]);
      const relative = decodeURIComponent(assetMatch[2]);
      const deckDir = path.resolve(cwd, config.decksDir, deckId);
      if (!fsSync.existsSync(path.join(deckDir, "manifest.json"))) {
        json(res, 404, { error: "deck not found" });
        return true;
      }
      const resolvedPath = path.resolve(deckDir, relative);
      const rel = path.relative(deckDir, resolvedPath);
      if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
        json(res, 400, { error: `path escapes the deck directory: ${relative}` });
        return true;
      }
      if (!AUDIO_ASSET_EXTENSIONS.has(path.extname(resolvedPath).toLowerCase())) {
        json(res, 400, { error: `not an audio asset: ${relative}` });
        return true;
      }
      let stat;
      try {
        stat = await fsp.stat(resolvedPath);
      } catch {
        json(res, 404, { error: `no audio asset at ${rel.split(path.sep).join("/")}` });
        return true;
      }
      if (!stat.isFile()) {
        json(res, 400, { error: `${rel.split(path.sep).join("/")} is not a file` });
        return true;
      }
      const headers = { "Content-Type": "audio/wav", "Cache-Control": "no-store", "Accept-Ranges": "bytes" };
      const range = req.headers.range;
      if (range) {
        const match = range.match(/^bytes=(\d*)-(\d*)$/);
        const start = match && match[1] !== "" ? Number(match[1]) : 0;
        const end = match && match[2] !== "" ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
        if (Number.isInteger(start) && Number.isInteger(end) && start <= end && start < stat.size) {
          res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": end - start + 1 });
          createReadStream(resolvedPath, { start, end }).pipe(res);
          return true;
        }
      }
      res.writeHead(200, { ...headers, "Content-Length": stat.size });
      createReadStream(resolvedPath).pipe(res);
      return true;
    }

    const doctorMatch = req.method === "GET" && pathname.match(/^\/api\/doctor\/([^/]+)$/);
    if (doctorMatch) {
      const backendId = decodeURIComponent(doctorMatch[1]);
      let backend;
      try {
        backend = getBackend(backendId);
      } catch (error) {
        json(res, 404, { error: error.message });
        return true;
      }
      const report = await backend.doctor();
      json(res, 200, { backend: backendId, status: report.status, exitCode: report.exitCode, diagnostics: report.diagnostics, installInstructions: report.installInstructions });
      return true;
    }

    if (req.method === "GET" && pathname === "/api/artifacts") {
      const generatedRoot = path.resolve(cwd, ...GENERATED_ROOT_SEGMENTS);
      // ?deck=<id> scopes the listing to that deck's outputs — the scoped
      // view must not reveal another deck's artifacts.
      const deckFilter = searchParams.get("deck");
      const artifacts = [];
      async function walk(dir, relPrefix) {
        let entries;
        try {
          entries = await fsp.readdir(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
          const rel = relPrefix === "" ? entry.name : `${relPrefix}/${entry.name}`;
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) await walk(full, rel);
          else if (entry.isFile()) {
            const stat = await fsp.stat(full);
            artifacts.push({ path: `${GENERATED_ROOT_SEGMENTS.join("/")}/${rel}`, bytes: stat.size, modifiedAt: stat.mtime.toISOString() });
          }
        }
      }
      await walk(generatedRoot, "");
      const listing = deckFilter
        ? artifacts.filter((artifact) => artifact.path.startsWith(`${UI_OUTPUT_SEGMENTS.join("/")}/${deckFilter}-`))
        : artifacts;
      json(res, 200, { root: ".lattice/generated/", artifacts: listing });
      return true;
    }

    const filesMatch = ["GET", "HEAD"].includes(req.method) && pathname.startsWith("/api/files/");
    if (filesMatch) {
      const relative = decodeURIComponent(pathname.slice("/api/files/".length));
      const resolvedPath = resolveGeneratedPath(cwd, relative);
      if (resolvedPath.error) {
        json(res, 400, { error: resolvedPath.error });
        return true;
      }
      let stat;
      try {
        stat = await fsp.stat(resolvedPath.resolved);
      } catch {
        json(res, 404, { error: `no artifact at ${resolvedPath.relative}` });
        return true;
      }
      if (!stat.isFile()) {
        json(res, 400, { error: `${resolvedPath.relative} is not a file` });
        return true;
      }
      const file = await fsp.realpath(resolvedPath.resolved);
      const root = await fsp.realpath(path.resolve(cwd, ...GENERATED_ROOT_SEGMENTS));
      const inside = path.relative(root, file);
      if (inside === ".." || inside.startsWith(".." + path.sep) || path.isAbsolute(inside)) {
        json(res, 400, { error: "Artifact path escapes the generated directory" });
        return true;
      }
      const type = MIME_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream";
      const cache = await imageCache(req, { file, stat, type, policy: "private, no-cache, must-revalidate", vary: res.getHeader("Vary") });
      const headers = { "Content-Type": type, "Cache-Control": "no-store", "Accept-Ranges": "bytes", ...cache?.headers };
      if (cache?.notModified) {
        res.removeHeader("Content-Length");
        res.writeHead(304, headers);
        res.end();
        return true;
      }
      const range = req.headers.range;
      if (range) {
        const match = range.match(/^bytes=(\d*)-(\d*)$/);
        const start = match && match[1] !== "" ? Number(match[1]) : 0;
        const end = match && match[2] !== "" ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
        if (Number.isInteger(start) && Number.isInteger(end) && start <= end && start < stat.size) {
          res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": end - start + 1 });
          if (req.method === "HEAD") res.end();
          else createReadStream(file, { start, end }).pipe(res);
          return true;
        }
      }
      res.writeHead(200, { ...headers, "Content-Length": stat.size });
      if (req.method === "HEAD") res.end();
      else createReadStream(file).pipe(res);
      return true;
    }

    if (req.method === "POST" && pathname === "/api/render") {
      let body;
      try {
        body = await readRequestBody(req);
      } catch (error) {
        json(res, 400, { error: error.message });
        return true;
      }
      const deckId = body.deck;
      if (typeof deckId !== "string" || deckId === "" || !fsSync.existsSync(path.resolve(cwd, config.decksDir, deckId, "manifest.json"))) {
        json(res, 400, { error: `unknown deck: ${JSON.stringify(deckId ?? null)}` });
        return true;
      }
      const backendId = body.backend;
      if (typeof backendId !== "string" || !listBackendIds().includes(backendId)) {
        json(res, 400, { error: `unknown backend: ${JSON.stringify(backendId ?? null)} (available: ${listBackendIds().join(", ")})` });
        return true;
      }
      if (body.route !== undefined && (typeof body.route !== "string" || body.route === "")) {
        json(res, 400, { error: "route must be a non-empty string when present" });
        return true;
      }
      if (body.output !== undefined) {
        // Client-requested outputs are allowed only inside the workbench's
        // generated directory; anything else is a hard 400.
        const requested = typeof body.output === "string" ? body.output : null;
        const check = resolveGeneratedPath(cwd, requested && requested.startsWith(".lattice/generated/")
          ? requested.slice(".lattice/generated/".length)
          : requested ?? "");
        if (check.error || !check.resolved?.startsWith(path.resolve(cwd, ...UI_OUTPUT_SEGMENTS))) {
          json(res, 400, { error: `output must stay inside .lattice/generated/video-ui/ (got ${JSON.stringify(body.output ?? null)})` });
          return true;
        }
      }
      const job = runner.enqueueJob({ deck: deckId, backend: backendId, route: body.route });
      json(res, 202, { jobId: job.id, status: job.status });
      return true;
    }

    if (req.method === "GET" && pathname === "/api/jobs") {
      json(res, 200, { jobs: [...runner.jobs.values()].sort((a, b) => (a.id < b.id ? 1 : -1)) });
      return true;
    }

    const jobMatch = req.method === "GET" && pathname.match(/^\/api\/jobs\/([^/]+)$/);
    if (jobMatch) {
      const job = runner.jobs.get(decodeURIComponent(jobMatch[1]));
      if (!job) {
        json(res, 404, { error: "unknown job" });
        return true;
      }
      json(res, 200, job);
      return true;
    }

    return false;
  }

  return async function workbenchHandler(req, res, next) {
    let pathname = "/";
    let searchParams = new URLSearchParams();
    try {
      const url = new URL(req.url ?? "/", "http://workbench.invalid");
      pathname = decodeURIComponent(url.pathname);
      searchParams = url.searchParams;
    } catch {
      next();
      return;
    }
    try {
      if (pathname.startsWith("/api/")) {
        if (await handleApi(req, res, pathname, searchParams)) return;
        next();
        return;
      }
      if (req.method !== "GET") {
        next();
        return;
      }
      if (pathname === "/" || pathname === "/index.html") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        res.end(await readWorkbenchShell(null));
        return;
      }
      const deckId = pathname.replace(/^\/+/, "").replace(/\/+$/, "");
      if (deckId === "" || deckId === "." || deckId === ".." || deckId.includes("/")) {
        next();
        return;
      }
      if (!fsSync.existsSync(path.resolve(cwd, config.decksDir, deckId, "manifest.json"))) {
        res.writeHead(404, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
        const zh = /(?:^|;\s*)praxis_locale=zh(?:;|$)/.test(req.headers.cookie || '');
        const txt = (english, chinese) => zh ? chinese : english;
        res.end(`<!doctype html><html lang="${zh ? 'zh-CN' : 'en'}"><head><meta charset="utf-8" /><meta name="viewport" content="width=device-width, initial-scale=1" /><title>${txt("Deck not found · Slides","文稿不存在 · Slides")}</title><style>body{margin:32px;background:#fafafa;color:#252529;font:16px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}main{max-width:800px;margin:auto}h1{font-size:1.45rem;font-weight:650}p{color:#606069}nav{display:flex;gap:20px;flex-wrap:wrap}a{display:inline-flex;align-items:center;min-height:44px;color:#1672d4}a:focus-visible{outline:2px solid #1672d4;outline-offset:3px}@media(max-width:760px){body{margin:16px}}</style></head><body><main><h1>${txt("Deck not found","文稿不存在")}</h1><p>${txt("This deck is missing or inaccessible.","这份文稿不存在或已无法访问。")}</p><nav aria-label="${txt("Deck navigation","文稿导航")}"><a href="/workbench">${txt("Choose deck","选择文稿")}</a><a href="/">${txt("All decks","全部文稿")}</a></nav></main></body></html>`);
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(await readWorkbenchShell(deckId));
    } catch (error) {
      if (!res.headersSent) {
        json(res, 500, { error: String(error?.stack ?? error) });
        return;
      }
      res.end();
    }
  };
}
