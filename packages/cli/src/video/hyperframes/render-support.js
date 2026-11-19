import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VideoBackendError } from "../backend-contract.js";
import {
  HOST_COMPOSITION_DIRNAME,
  HOST_PUBLIC_MANIFEST_NAME,
  HYPERFRAMES_HOST_SCHEMA,
} from "./host-template.js";

const HYPERFRAMES_BACKEND_ID = "hyperframes";
const HYPERFRAMES_FAILURES_DIRNAME = "failures";
const HYPERFRAMES_STILLS_DIRNAME = "stills";
const CLI_TIMEOUT_MS = 10 * 60 * 1000;

function renderSupportError(message, cause, diagnostics = []) {
  return new VideoBackendError(message, { backendId: HYPERFRAMES_BACKEND_ID, diagnostics, cause });
}

/**
 * The installed (exact-pinned) hyperframes package is the only execution
 * surface: stills and video go through the real `hyperframes` CLI. The binary
 * is resolved from the adapter's own dependency tree — never from PATH and
 * never a "latest" install.
 */
export function resolveHyperFramesCliEntry() {
  let pkgUrl;
  try {
    pkgUrl = import.meta.resolve("hyperframes/package.json");
  } catch {
    throw renderSupportError(
      "hyperframes is not installed. Install the exact pinned version with: npm install --save-dev hyperframes@0.8.206",
      "missing-hyperframes",
    );
  }
  const pkgPath = fileURLToPath(pkgUrl);
  const pkgDir = path.dirname(pkgPath);
  let pkg = null;
  try {
    pkg = JSON.parse(fsSync.readFileSync(pkgPath, "utf8"));
  } catch (error) {
    throw renderSupportError(`installed hyperframes package.json is unreadable: ${error.message}`, "invalid-hyperframes");
  }
  const binRelative = pkg?.bin?.hyperframes;
  if (typeof binRelative !== "string" || binRelative === "") {
    throw renderSupportError("installed hyperframes package does not expose a `hyperframes` bin", "invalid-hyperframes");
  }
  const binPath = path.join(pkgDir, binRelative);
  if (!fsSync.existsSync(binPath)) {
    throw renderSupportError(`hyperframes CLI entry is missing at ${binPath}; reinstall the pinned package`, "invalid-hyperframes");
  }
  return { binPath, version: typeof pkg.version === "string" ? pkg.version : null };
}

/**
 * Resolve the executable passed to `node` for the CLI child process. In a
 * packaged/stand-alone runtime process.execPath is the running Node binary,
 * which is exactly what the hyperframes CLI requires.
 */
function nodeExecutable() {
  return process.execPath;
}

/**
 * Deterministic browser environment: both backends must rasterize through the
 * same Chromium build, so the HyperFrames child process is pinned to the exact
 * executable the Remotion backend resolves (LATTICE_CHROMIUM → Playwright
 * cache → system locations). A missing browser is an error, never an
 * environment-dependent fallback.
 */
export async function resolvePinnedBrowserEnv() {
  const { resolveChromiumExecutable } = await import("../../commands/browser.js");
  const executable = resolveChromiumExecutable();
  if (!executable) {
    throw renderSupportError(
      "No Chromium/Chrome browser executable found for HyperFrames rendering " +
      "(searched LATTICE_CHROMIUM, Playwright cache, and system locations). " +
      "Install Chromium/Chrome or set LATTICE_CHROMIUM.",
      "missing-browser",
    );
  }
  return { HYPERFRAMES_BROWSER_PATH: executable };
}

export async function readHostManifest({ workDir, planHash }) {
  const manifestPath = path.join(workDir, HOST_COMPOSITION_DIRNAME, HOST_PUBLIC_MANIFEST_NAME);
  let raw;
  try {
    raw = await fs.readFile(manifestPath, "utf8");
  } catch {
    throw renderSupportError(
      `no generated HyperFrames composition found at ${manifestPath}. Run backend prepare first ` +
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
  if (manifest?.schema !== HYPERFRAMES_HOST_SCHEMA) {
    throw renderSupportError(
      `generated host manifest has unexpected schema ${JSON.stringify(manifest?.schema ?? null)}; regenerate the composition with prepare.`,
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

function runHyperframesChild(binPath, args, env, timeoutMs = CLI_TIMEOUT_MS) {
  return new Promise((resolve) => {
    execFile(
      nodeExecutable(),
      [binPath, ...args],
      {
        timeout: timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, ...env },
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        resolve({ error, stdout: stdout ?? "", stderr: stderr ?? "" });
      },
    );
  });
}

/**
 * The CLI prints progress before the final --json envelope; the envelope is
 * the last balanced JSON document on stdout (progress logs go to stderr, but
 * --json output may also be the only stdout content).
 */
function parseJsonEnvelope(stdout, stderr, label) {
  const candidates = [stdout.trim(), `${stdout}\n${stderr}`.trim()];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      // fall through to the suffix search below
    }
  }
  const combined = candidates[1];
  const start = combined.lastIndexOf("\n{");
  if (start >= 0) {
    try {
      return JSON.parse(combined.slice(start + 1));
    } catch {
      // fall through to the typed error below
    }
  }
  throw renderSupportError(
    `hyperframes ${label} did not print a parseable JSON envelope. stdout: ${stdout.slice(-2000)} stderr: ${stderr.slice(-2000)}`,
    "cli-failed",
  );
}

export async function writeHyperFramesFailureLog({ workDir, kind, planHash, context = {}, error, diagnostics = [] }) {
  try {
    const dir = path.join(workDir, HYPERFRAMES_FAILURES_DIRNAME);
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
      "DO NOT EDIT — Lattice HyperFrames failure log",
      `kind: ${kind}`,
      `plan-hash: ${planHash ?? "unknown"}`,
      ...Object.entries(context).map(([key, value]) => `${key}: ${value}`),
      "",
      `error: ${error?.message ?? String(error)}`,
      `stack: ${error?.stack ?? ""}`,
      "",
      "stdout:",
      String(error?.stdout ?? "").slice(-8000),
      "",
      "stderr:",
      String(error?.stderr ?? "").slice(-8000),
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

/**
 * Frame time as an exact decimal literal: frame / fps in seconds, computed in
 * high precision so the snapshot seek lands on the canonical integer frame
 * (the composition driver rounds virtual time × fps back to the frame).
 */
export function frameTimeSeconds(frame, fps) {
  return (frame / fps).toFixed(12);
}

/**
 * Render one still through the real `hyperframes snapshot` CLI: the captured
 * PNG is the composition's own pixels at the exact frame time, written first
 * into the generated stills directory and then copied to the requested
 * output path.
 */
export async function captureStillViaSnapshot({ compositionDir, stillsDir, frame, fps, env }) {
  const outputDir = path.join(stillsDir, `frame-${String(frame).padStart(6, "0")}`);
  await fs.rm(outputDir, { recursive: true, force: true });
  await fs.mkdir(outputDir, { recursive: true });

  const args = [
    "snapshot",
    compositionDir,
    "--at", frameTimeSeconds(frame, fps),
    "--no-end",
    "--json",
    "--output", outputDir,
  ];
  const { binPath } = resolveHyperFramesCliEntry();
  const { error, stdout, stderr } = await runHyperframesChild(binPath, args, env);

  if (error) {
    throw renderSupportError(
      `hyperframes snapshot failed for frame ${frame}: ${error.message}`,
      "render-failed",
    );
  }

  let envelope;
  try {
    envelope = parseJsonEnvelope(stdout, stderr, "snapshot");
  } catch (parseError) {
    parseError.stdout = stdout;
    parseError.stderr = stderr;
    throw parseError;
  }
  if (!envelope || envelope.ok !== true || !Array.isArray(envelope.frames) || envelope.frames.length !== 1) {
    throw renderSupportError(
      `hyperframes snapshot for frame ${frame} returned ${envelope?.frames?.length ?? 0} frames, expected exactly 1`,
      "render-failed",
    );
  }
  const capturedPath = envelope.frames[0]?.path;
  if (typeof capturedPath !== "string" || capturedPath === "" || !fsSync.existsSync(capturedPath)) {
    throw renderSupportError(
      `hyperframes snapshot for frame ${frame} did not report a readable PNG path: ${JSON.stringify(capturedPath ?? null)}`,
      "render-failed",
    );
  }
  return capturedPath;
}

/**
 * Issue 011 — warm-browser batch stills: the real `hyperframes snapshot` CLI
 * accepts comma-separated `--at` times and captures every requested instant
 * in ONE browser session ("Capturing N frames at [t0, t1, …]"). A multi-still
 * flow therefore pays one CLI child process and one browser boot instead of
 * one per still. Captures are matched back to requests by their exact
 * snapshot time (the CLI stamps each PNG with the 3-decimal time label and
 * echoes `{ path, time }` in the JSON envelope); duplicate frame times share
 * one capture and are copied to every requested output.
 */
export async function captureStillsViaSnapshot({ compositionDir, stillsDir, requests, fps, env }) {
  const byTimeKey = new Map();
  for (const request of requests) {
    const timeKey = Number((request.frame / fps).toFixed(3));
    if (!byTimeKey.has(timeKey)) byTimeKey.set(timeKey, []);
    byTimeKey.get(timeKey).push(request);
  }
  for (const [timeKey, group] of byTimeKey) {
    const distinctFrames = new Set(group.map((request) => request.frame));
    if (distinctFrames.size > 1) {
      throw renderSupportError(
        `snapshot batch time collision: distinct frames ${[...distinctFrames].join(", ")} share the same 3-decimal snapshot time ${timeKey} (fps ${fps}); reduce the frame count or split the batch`,
        "batch-time-collision",
      );
    }
  }

  const batchDir = path.join(stillsDir, "batch");
  await fs.rm(batchDir, { recursive: true, force: true });
  await fs.mkdir(batchDir, { recursive: true });

  const groups = [...byTimeKey.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([timeKey, group]) => ({ timeKey, frame: group[0].frame }));
  const args = [
    "snapshot",
    compositionDir,
    "--at", groups.map((group) => frameTimeSeconds(group.frame, fps)).join(","),
    "--no-end",
    "--json",
    "--output", batchDir,
  ];
  const { binPath } = resolveHyperFramesCliEntry();
  const { error, stdout, stderr } = await runHyperframesChild(binPath, args, env);

  if (error) {
    throw renderSupportError(
      `hyperframes snapshot failed for ${groups.length} frames [${groups.map((group) => group.frame).join(", ")}]: ${error.message}`,
      "render-failed",
    );
  }

  let envelope;
  try {
    envelope = parseJsonEnvelope(stdout, stderr, "snapshot");
  } catch (parseError) {
    parseError.stdout = stdout;
    parseError.stderr = stderr;
    throw parseError;
  }
  if (!envelope || envelope.ok !== true || !Array.isArray(envelope.frames) || envelope.frames.length !== groups.length) {
    throw renderSupportError(
      `hyperframes snapshot batch for frames [${groups.map((group) => group.frame).join(", ")}] returned ${envelope?.frames?.length ?? 0} frames, expected exactly ${groups.length}`,
      "render-failed",
    );
  }

  const capturedByTimeKey = new Map();
  for (const frame of envelope.frames) {
    const capturedPath = frame?.path;
    if (typeof capturedPath !== "string" || capturedPath === "" || !fsSync.existsSync(capturedPath)) {
      throw renderSupportError(
        `hyperframes snapshot batch did not report a readable PNG for time ${JSON.stringify(frame?.time ?? null)}: ${JSON.stringify(capturedPath ?? null)}`,
        "render-failed",
      );
    }
    const timeKey = Number(Number(frame.time).toFixed(3));
    if (!byTimeKey.has(timeKey) || capturedByTimeKey.has(timeKey)) {
      throw renderSupportError(
        `hyperframes snapshot batch returned an unexpected or duplicate time ${JSON.stringify(frame.time)} (expected one capture per requested time)`,
        "render-failed",
      );
    }
    capturedByTimeKey.set(timeKey, capturedPath);
  }
  for (const timeKey of byTimeKey.keys()) {
    if (!capturedByTimeKey.has(timeKey)) {
      throw renderSupportError(
        `hyperframes snapshot batch did not return a capture for requested time ${timeKey}s`,
        "render-failed",
      );
    }
  }

  return requests.map((request) => ({
    frame: request.frame,
    output: request.output,
    capturedPath: capturedByTimeKey.get(Number((request.frame / fps).toFixed(3))),
  }));
}

/**
 * Render the complete MP4 through the real `hyperframes render` CLI. Lint
 * errors fail the render (--strict): a generated composition that violates
 * the engine's authoring contract is a backend bug, never a best-effort
 * output.
 */
export async function renderVideoViaCli({ compositionDir, fps, output, env }) {
  const args = [
    "render",
    compositionDir,
    "--fps", String(fps),
    "--output", output,
    "--strict",
  ];
  const { binPath } = resolveHyperFramesCliEntry();
  const { error, stdout, stderr } = await runHyperframesChild(binPath, args, env);
  if (error) {
    const detail = `${error.message}\n${stdout.slice(-4000)}\n${stderr.slice(-4000)}`;
    throw renderSupportError(`hyperframes render failed: ${detail}`, "render-failed");
  }
  if (!fsSync.existsSync(output)) {
    throw renderSupportError(
      `hyperframes render reported success but no artifact exists at ${output}. stdout: ${stdout.slice(-2000)}`,
      "render-failed",
    );
  }
  return { stdout, stderr };
}
