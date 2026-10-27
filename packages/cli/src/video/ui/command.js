// lattice video ui — the M7 video workbench.
//
// One local process serving:
//   - the workbench single-page app (deck list, unified timeline
//     visualization, backend doctor, render queue, artifact preview), and
//   - a JSON API over the exact same compile/render path the CLI uses
//     (compileDeckVideoPlan + backend.prepare/renderVideo), so a workbench
//     artifact and a CLI artifact share one planHash.
//
// The in-page preview plays the deck's timeline through the real Slide
// Runtime (the same frame-state surface present-play uses), loaded over the
// vite middleware so the bare runtime import resolves exactly like the dev
// server. Rendering is serialized; every artifact path is server-enforced to
// stay inside .lattice/generated/ (anything else is a 400).

import http from "node:http";
import fsSync from "node:fs";
import fsp from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadConfig } from "../../config/index.js";
import { listDeckIds, readManifest } from "../../edit/deck-view.js";
import { compileDeckVideoPlan } from "../../commands/video.js";
import { ensureBackendsInitialized, getBackend, listBackendIds } from "../registry.js";
import { resolveTimeline } from "@55aaseclab/lattice-runtime/timeline";
import { validateStopRevealAnimation } from "@55aaseclab/lattice-runtime/themes/simple-light/presets";

const WORKBENCH_DEFAULT_PORT = 4700;
const WORKBENCH_HOST = "127.0.0.1";
const GENERATED_ROOT_SEGMENTS = [".lattice", "generated"];
const UI_OUTPUT_SEGMENTS = [...GENERATED_ROOT_SEGMENTS, "video-ui"];

const APP_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "app");

const MIME_TYPES = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webm": "video/webm",
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
        const deckDir = path.resolve(cwd, config.decksDir, job.deck);
        const exportBundleDir = path.resolve(config.outDir, "static-decks", job.deck);
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
        });
        log(job, `plan ${planHash.slice(0, 12)} compiled: ${completePlan.totalFrames} frames @ ${completePlan.fps} fps, ${completePlan.clips.length} clip(s), ${completePlan.audioTracks.length} audio track(s)`);
        job.planHash = planHash;

        // 3. Prepare and render through the selected backend.
        const backend = getBackend(job.backend);
        const projectRoot = cwd;
        const workDir = path.resolve(projectRoot, ...GENERATED_ROOT_SEGMENTS, backend.id);
        const prepared = await backend.prepare({
          plan: completePlan,
          bundleDir: path.resolve(config.outDir, "static-decks", job.deck),
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
        audioTracks: resolved?.audioTracks ?? manifest.audioTracks ?? [],
      },
    };
  } finally {
    await loader.close();
  }
}

export async function videoUiCommand({ args }) {
  let config;
  try {
    config = await loadConfig(process.cwd());
  } catch (error) {
    console.error(`[lattice] ${error.message}`);
    process.exit(2);
  }
  const cwd = process.cwd();
  const requestedPort = args.port !== undefined ? Number(args.port) : WORKBENCH_DEFAULT_PORT;
  if (!Number.isInteger(requestedPort) || requestedPort < 0 || requestedPort > 65535) {
    console.error(`[lattice] --port must be an integer between 0 (ephemeral) and 65535, got ${JSON.stringify(args.port ?? null)}`);
    process.exit(2);
  }

  ensureBackendsInitialized();

  const { createServer: createViteServer } = await import("vite");
  const vite = await createViteServer({
    root: APP_DIR,
    logLevel: "silent",
    // No HMR: the workbench is a static single page and must never compete
    // for the default HMR port with the project vite servers the render
    // pipeline (export, module loader) spawns in child processes.
    server: { middlewareMode: true, hmr: false },
  });

  const runner = createJobRunner({ cwd, config });

  async function handleApi(req, res, pathname) {
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
      json(res, 200, { root: ".lattice/generated/", artifacts });
      return true;
    }

    const filesMatch = req.method === "GET" && pathname.startsWith("/api/files/");
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
      const type = MIME_TYPES[path.extname(resolvedPath.resolved).toLowerCase()] ?? "application/octet-stream";
      const headers = { "Content-Type": type, "Cache-Control": "no-store", "Accept-Ranges": "bytes" };
      const range = req.headers.range;
      if (range) {
        const match = range.match(/^bytes=(\d*)-(\d*)$/);
        const start = match && match[1] !== "" ? Number(match[1]) : 0;
        const end = match && match[2] !== "" ? Math.min(Number(match[2]), stat.size - 1) : stat.size - 1;
        if (Number.isInteger(start) && Number.isInteger(end) && start <= end && start < stat.size) {
          res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${stat.size}`, "Content-Length": end - start + 1 });
          createReadStream(resolvedPath.resolved, { start, end }).pipe(res);
          return true;
        }
      }
      res.writeHead(200, { ...headers, "Content-Length": stat.size });
      createReadStream(resolvedPath.resolved).pipe(res);
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

  const server = http.createServer(async (req, res) => {
    const pathname = (req.url ?? "/").split("?")[0];
    try {
      if (await handleApi(req, res, pathname)) return;
    } catch (error) {
      if (!res.headersSent) json(res, 500, { error: String(error?.stack ?? error) });
      return;
    }
    vite.middlewares(req, res);
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(requestedPort, WORKBENCH_HOST, resolve);
  });
  const address = server.address();
  const actualPort = address?.port ?? requestedPort;
  const url = `http://${WORKBENCH_HOST}:${actualPort}/`;
  console.log(`[lattice] video workbench: ${url}`);
  console.log(`[lattice] artifacts: ${path.resolve(cwd, ...GENERATED_ROOT_SEGMENTS, "video-ui")}`);
  console.log(`[lattice] press Ctrl+C to stop`);
}
