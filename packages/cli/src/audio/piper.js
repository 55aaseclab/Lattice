// M12 (V2.0.25) — second narration TTS backend: piper (MIT, rhasspy/piper
// release 2023.11.14-2), a standalone C++ binary with offline espeak-ng
// phonemization. This is the zh (Chinese) narration path: kokoro-js 1.2.1
// ships an English-only voice catalog (28 af_/am_/bf_/bm_ voices, no zh G2P),
// so Chinese narration is structurally impossible there — piper's
// zh_CN-huayan-medium carries it.
//
// Determinism contract (same bar as kokoro): piper's voice models embed
// RandomNormalLike nodes without a seed attribute, and onnxruntime <=1.14
// seeds its global RNG from system_clock::now() at library load — so raw
// piper output varies byte-to-byte AND in duration between runs. The engine
// therefore launches piper under a tiny LD_PRELOAD shim
// (piper-freeze-clock.c) that freezes CLOCK_REALTIME inside the piper child
// process, pinning the ORT seed. Same input → byte-identical PCM, verified
// by the test suite. If the shim cannot be built (no compiler), the engine
// refuses loudly rather than producing non-deterministic audio.

import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import fsSync from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

export const PIPER_RELEASE = "2023.11.14-2";

// The stitched narration.wav sample rate. Piper voices are natively 22050 Hz
// (mono, PCM16); the engine resamples linearly to 24 kHz so every narration
// asset in the deck contract keeps one sample rate (kokoro parity).
export const PIPER_OUTPUT_SAMPLE_RATE = 24000;

const PIPER_ENGINES = Object.freeze(["kokoro", "piper"]);

export function isKnownNarrationEngine(engine) {
  return PIPER_ENGINES.includes(engine);
}

/** Stable piper cache directory: env override, else ~/.cache/lattice/piper. */
export function resolvePiperDir() {
  const override = process.env.LATTICE_PIPER_DIR;
  if (override && override.trim() !== "") return path.resolve(override.trim());
  return path.join(os.homedir(), ".cache", "lattice", "piper");
}

export function piperBinaryPath(piperDir = resolvePiperDir()) {
  return path.join(piperDir, "piper", "piper");
}

function piperVoiceDir(piperDir, voice) {
  return path.join(piperDir, "voices", voice);
}

function piperModelPath(piperDir, voice) {
  return path.join(piperVoiceDir(piperDir, voice), `${voice}.onnx`);
}

function piperConfigPath(piperDir, voice) {
  return path.join(piperVoiceDir(piperDir, voice), `${voice}.onnx.json`);
}

/**
 * The machine-readable piper voice slice — discovered from the provisioned
 * cache (voices/<id>/<id>.onnx + .onnx.json). No model inference, just file
 * metadata, so it is cheap and safe to call for catalogs and write-time
 * voice checks.
 */
export function listPiperVoices(piperDir = resolvePiperDir()) {
  const voicesRoot = path.join(piperDir, "voices");
  const catalog = {};
  let entries = [];
  try {
    entries = fsSync.readdirSync(voicesRoot, { withFileTypes: true });
  } catch {
    return catalog;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const voice = entry.name;
    const modelPath = piperModelPath(piperDir, voice);
    const configPath = piperConfigPath(piperDir, voice);
    if (!fsSync.existsSync(modelPath) || !fsSync.existsSync(configPath)) continue;
    let config = null;
    try {
      config = JSON.parse(fsSync.readFileSync(configPath, "utf8"));
    } catch {
      continue;
    }
    catalog[voice] = {
      name: config?.language?.name_english ?? voice,
      language: config?.language?.code ?? null,
      languageNative: config?.language?.name_native ?? null,
      gender: null,
      quality: config?.audio?.quality ?? null,
      nativeSampleRate: config?.audio?.sample_rate ?? null,
      engine: "piper",
    };
  }
  return catalog;
}

export function isKnownPiperVoice(voice, piperDir = resolvePiperDir()) {
  if (typeof voice !== "string" || voice === "") return false;
  return Object.hasOwn(listPiperVoices(piperDir), voice);
}

// ---- determinism shim -------------------------------------------------------

function shimSourcePath() {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "piper-freeze-clock.c");
}

/**
 * Build (once) and return the LD_PRELOAD shim that freezes CLOCK_REALTIME in
 * the piper child process. The compiled artifact is cached in the piper dir,
 * named after the source's sha256 so a source change rebuilds. Compilation
 * happens at provision time (first use); without a compiler the engine
 * refuses — byte-determinism is a hard contract, not a nice-to-have.
 */
export function ensureDeterminismShim(piperDir = resolvePiperDir()) {
  const source = fsSync.readFileSync(shimSourcePath(), "utf8");
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const shimPath = path.join(piperDir, `freeze-clock-${sourceHash.slice(0, 8)}.so`);
  if (fsSync.existsSync(shimPath)) return { shimPath, sourceHash };
  fsSync.mkdirSync(piperDir, { recursive: true });
  try {
    execFileSync("cc", ["-shared", "-fPIC", "-O2", "-o", shimPath, shimSourcePath(), "-ldl"], {
      stdio: "pipe",
      timeout: 30000,
    });
  } catch (error) {
    throw Object.assign(
      new Error(
        `cannot build the piper determinism shim (cc failed: ${error.message}). ` +
        `Raw piper output is NOT byte-deterministic (onnxruntime seeds its RNG from the wall clock); ` +
        `the shim is required. Provision once on a machine with a C compiler, or point LATTICE_PIPER_DIR ` +
        `at a cache that already carries the built shim.`,
      ),
      { code: "piper-determinism-shim-unavailable" },
    );
  }
  return { shimPath, sourceHash };
}

// ---- synthesis --------------------------------------------------------------

function linearResample(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const outLength = Math.round((samples.length / fromRate) * toRate);
  const out = new Float32Array(outLength);
  for (let index = 0; index < outLength; index += 1) {
    const t = (index * fromRate) / toRate;
    const left = Math.floor(t);
    const frac = t - left;
    const a = left < samples.length ? samples[left] : 0;
    const b = left + 1 < samples.length ? samples[left + 1] : 0;
    out[index] = a + (b - a) * frac;
  }
  return out;
}

function pcm16ToFloat32(buffer) {
  const count = Math.floor(buffer.length / 2);
  const samples = new Float32Array(count);
  for (let index = 0; index < count; index += 1) {
    samples[index] = buffer.readInt16LE(index * 2) / 32768;
  }
  return samples;
}

function runPiper({ binaryPath, args, text, preload, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      env: preload ? { ...process.env, LD_PRELOAD: preload } : { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const chunks = [];
    const errors = [];
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill("SIGKILL");
        reject(Object.assign(new Error(`piper timed out after ${timeoutMs}ms`), { code: "piper-timeout" }));
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.stderr.on("data", (chunk) => errors.push(chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(Object.assign(new Error(`cannot run piper: ${error.message}`), { code: "piper-spawn-failed" }));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks);
      if (code !== 0) {
        reject(
          Object.assign(
            new Error(`piper exited ${code}: ${Buffer.concat(errors).toString("utf8").slice(0, 400)}`),
            { code: "piper-exit-nonzero" },
          ),
        );
        return;
      }
      resolve(stdout);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(text, "utf8");
  });
}

/**
 * Offline-deterministic piper narration engine factory (V2.0.25). Mirrors the
 * kokoro contract: pinned binary release + voice files from a stable on-disk
 * cache, everything validated before any work, deterministic byte-identical
 * PCM for identical inputs.
 *
 * Environment:
 *   LATTICE_PIPER_DIR     — cache dir override (default ~/.cache/lattice/piper)
 *   LATTICE_PIPER_ENGINE  — "stub" selects the test-only deterministic stub
 */
export async function createPiperNarrationEngine({ voice, speed = 1 } = {}) {
  if (process.env.LATTICE_PIPER_ENGINE === "stub") {
    const { createPiperStubNarrationEngine } = await import("./piper-stub.js");
    return createPiperStubNarrationEngine({ voice, speed });
  }
  const piperDir = resolvePiperDir();
  const binaryPath = piperBinaryPath(piperDir);
  if (!fsSync.existsSync(binaryPath)) {
    throw Object.assign(
      new Error(
        `the piper binary is not provisioned. Expected: ${binaryPath}. ` +
        `Provision once (piper release ${PIPER_RELEASE} tarball + the voice model), or set ` +
        `LATTICE_PIPER_DIR to a directory that already carries it. Refusing to download implicitly.`,
      ),
      { code: "piper-not-provisioned" },
    );
  }
  if (!isKnownPiperVoice(voice, piperDir)) {
    const available = Object.keys(listPiperVoices(piperDir));
    throw Object.assign(
      new Error(
        `unknown piper voice ${JSON.stringify(voice)}; provisioned voices: ${available.join(", ") || "(none)"}. ` +
        `Voice models live under ${path.join(piperDir, "voices")}/<voice>/<voice>.onnx.`,
      ),
      { code: "unknown-narration-voice" },
    );
  }
  const { shimPath, sourceHash } = ensureDeterminismShim(piperDir);
  const modelPath = piperModelPath(piperDir, voice);
  const config = JSON.parse(fsSync.readFileSync(piperConfigPath(piperDir, voice), "utf8"));
  const nativeSampleRate = config?.audio?.sample_rate ?? 22050;

  return {
    engine: "piper",
    engineVersion: PIPER_RELEASE,
    model: voice,
    voice,
    speed,
    sampleRate: PIPER_OUTPUT_SAMPLE_RATE,
    determinism: { shim: path.basename(shimPath), shimSourceSha256: sourceHash },
    async generate(text, { speed: speedOverride } = {}) {
      // V2.0.21 parity: per-call speed overrides the engine default. Piper
      // spells rate as length_scale = 1/speed (monotone, non-linear — same
      // caveat as kokoro's speed, recorded in the delivery notes).
      const effectiveSpeed = speedOverride ?? speed;
      const lengthScale = Math.max(0.1, Math.min(10, 1 / effectiveSpeed));
      const raw = await runPiper({
        binaryPath,
        args: [
          "--model", modelPath,
          "--length_scale", String(lengthScale),
          "--output_raw",
          "--quiet",
        ],
        text,
        preload: shimPath,
        timeoutMs: 120000,
      });
      if (raw.length === 0) {
        throw Object.assign(new Error(`piper produced no audio for the segment`), { code: "piper-empty-output" });
      }
      const samples = linearResample(pcm16ToFloat32(raw), nativeSampleRate, PIPER_OUTPUT_SAMPLE_RATE);
      return { samples, sampleRate: PIPER_OUTPUT_SAMPLE_RATE };
    },
  };
}

export { PIPER_ENGINES };
