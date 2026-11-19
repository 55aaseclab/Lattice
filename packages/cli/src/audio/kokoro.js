// M10 narration TTS backend: kokoro-js (Kokoro-82M ONNX, Apache-2.0), pinned
// to an exact npm version. The engine is fully offline-deterministic: model
// weights load from a stable on-disk cache (never the package-dir default,
// which dies on reinstall), remote fetching is disabled unless explicitly
// allowed for first-time provisioning, and CPU fp32 inference reproduces
// byte-identical PCM for identical inputs.

import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

export const KOKORO_MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

export const KOKORO_SAMPLE_RATE = 24000;

function kokoroPackageDir() {
  return path.dirname(path.dirname(fileURLToPath(import.meta.resolve("kokoro-js"))));
}

/** Pinned kokoro-js version, read from the installed package. */
export function kokoroVersion() {
  const pkg = JSON.parse(fsSync.readFileSync(path.join(kokoroPackageDir(), "package.json"), "utf8"));
  return pkg.version;
}

// kokoro-js is ESM-only and dynamically imported so commands that never touch
// speech synthesis do not pay its module-graph cost on cold starts.
async function loadKokoro() {
  return import("kokoro-js");
}

/**
 * The machine-readable kokoro voice catalog — read straight from the pinned
 * package (the `voices` prototype getter returns the frozen metadata map
 * without touching the 310MB model), so `lattice audio voices` and every
 * write-time voice check consume exactly what the TTS engine will accept.
 */
export async function listKokoroVoices() {
  const { KokoroTTS } = await loadKokoro();
  const getter = Object.getOwnPropertyDescriptor(KokoroTTS.prototype, "voices").get;
  const voices = getter.call(null);
  const catalog = {};
  for (const [id, meta] of Object.entries(voices)) {
    catalog[id] = {
      name: meta.name,
      language: meta.language,
      gender: meta.gender ?? null,
      overallGrade: meta.overallGrade ?? null,
    };
  }
  return {
    schema: "lattice.tts-voices.v1",
    backend: "kokoro-js",
    backendVersion: kokoroVersion(),
    model: KOKORO_MODEL_ID,
    defaultVoice: "af_heart",
    voices: catalog,
  };
}

export async function isKnownNarrationVoice(voice) {
  if (typeof voice !== "string" || voice === "") return false;
  const catalog = await listKokoroVoices();
  return Object.hasOwn(catalog.voices, voice);
}

/** Stable model cache directory: env override, else ~/.cache/lattice/kokoro. */
export function resolveTtsCacheDir() {
  const override = process.env.LATTICE_TTS_CACHE;
  if (override && override.trim() !== "") return path.resolve(override.trim());
  return path.join(os.homedir(), ".cache", "lattice", "kokoro");
}

// Every file kokoro-js/transformers.js reads from the model repo. Missing any
// of these means the cache is not provisioned; `onnx/model.onnx` carries the
// fp32 weights (single-file layout of the v1.0 ONNX export).
const KOKORO_CACHE_FILES = ["config.json", "tokenizer.json", "tokenizer_config.json", "onnx/model.onnx"];

export function kokoroCacheIsProvisioned(cacheDir = resolveTtsCacheDir()) {
  return KOKORO_CACHE_FILES.every((relative) => fsSync.existsSync(path.join(cacheDir, KOKORO_MODEL_ID, relative)));
}

/**
 * Offline-deterministic kokoro engine factory. The model is validated against
 * the cache BEFORE any work starts: a missing cache is an immediate, explicit
 * failure naming the model id, the cache path, and the provisioning switch —
 * never a silent hang or an implicit download.
 *
 * Environment:
 *   LATTICE_TTS_CACHE          — cache directory override
 *   LATTICE_TTS_ALLOW_DOWNLOAD — "1" allows the one-time model download
 *   LATTICE_TTS_ENGINE         — "silent" selects the test-only deterministic
 *                                stub engine (never used in production runs)
 */
export async function createNarrationEngine({ voice, speed } = {}) {
  if (process.env.LATTICE_TTS_ENGINE === "silent") {
    const { createSilentNarrationEngine } = await import("./silent-engine.js");
    return createSilentNarrationEngine({ voice, speed });
  }
  if (!(await isKnownNarrationVoice(voice))) {
    const catalog = await listKokoroVoices();
    throw Object.assign(
      new Error(`unknown narration voice ${JSON.stringify(voice)}; pick one from "lattice audio voices" (kokoro-js ${catalog.backendVersion})`),
      { code: "unknown-narration-voice" },
    );
  }

  const { env } = await import("@huggingface/transformers");
  const { KokoroTTS } = await loadKokoro();
  const cacheDir = resolveTtsCacheDir();
  const allowDownload = process.env.LATTICE_TTS_ALLOW_DOWNLOAD === "1";
  if (!kokoroCacheIsProvisioned(cacheDir) && !allowDownload) {
    throw Object.assign(
      new Error(
        `the kokoro model is not cached for offline narration. Model: ${KOKORO_MODEL_ID}. ` +
        `Expected cache: ${cacheDir}/<model files>. Provision it once with ` +
        `LATTICE_TTS_ALLOW_DOWNLOAD=1 lattice audio narrate ... (downloads ~310MB into the cache; ` +
        `subsequent runs are fully offline), or set LATTICE_TTS_CACHE to a directory that already ` +
        `carries the model. Refusing to hang on or start an implicit download.`,
      ),
      { code: "tts-model-not-cached" },
    );
  }
  env.cacheDir = cacheDir;
  env.allowRemoteModels = allowDownload;
  const tts = await KokoroTTS.from_pretrained(KOKORO_MODEL_ID, { dtype: "fp32", device: "cpu" });
  return {
    engine: "kokoro-js",
    engineVersion: kokoroVersion(),
    model: KOKORO_MODEL_ID,
    voice,
    speed,
    sampleRate: KOKORO_SAMPLE_RATE,
    async generate(text, { speed: speedOverride } = {}) {
      // V2.0.21: the per-call speed overrides the engine default — the
      // narrate loop passes each slide's effective speed (per-slide
      // timeline.slides.<id>.audio.speed > narration declaration > 1).
      const audio = await tts.generate(text, { voice, speed: speedOverride ?? speed });
      const samples = audio.audio instanceof Float32Array ? audio.audio : Float32Array.from(audio.audio);
      return { samples, sampleRate: KOKORO_SAMPLE_RATE };
    },
  };
}
