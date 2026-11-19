// AI audience (v1.1) — speech-to-text transcription backend for the
// experience pack (design §2 听觉（生成对照）).
//
// The narration the audience HEARS is whisper-transcribed and diffed against
// the notes source text, making "review what the audience actually hears" a
// deterministic, reproducible check (R1-3-class TTS reading traps become
// machine-detectable evidence instead of one human's impression).
//
// Mirrors the kokoro TTS backend contract (src/audio/kokoro.js): pinned model
// + library versions, offline-deterministic inference from a stable on-disk
// cache, remote fetching disabled unless explicitly allowed for first-time
// provisioning, and a test-only stub engine selected by environment.

import fsSync from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

export const ASR_MODEL_ID = "onnx-community/whisper-large-v3-turbo";
export const ASR_DTYPE = "q8";
export const ASR_SAMPLE_RATE = 16000;
export const ASR_LANGUAGE = "en";

function transformersPackageDir() {
  return path.dirname(path.dirname(fileURLToPath(import.meta.resolve("@huggingface/transformers"))));
}

/** Pinned @huggingface/transformers version, read from the installed package. */
export function transformersVersion() {
  const pkg = JSON.parse(fsSync.readFileSync(path.join(transformersPackageDir(), "package.json"), "utf8"));
  return pkg.version;
}

/** Stable model cache directory: env override, else ~/.cache/lattice/whisper. */
export function resolveAsrCacheDir() {
  const override = process.env.LATTICE_ASR_CACHE;
  if (override && override.trim() !== "") return path.resolve(override.trim());
  return path.join(os.homedir(), ".cache", "lattice", "whisper");
}

const ASR_CACHE_FILES = [
  "config.json",
  "generation_config.json",
  "preprocessor_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
];

export function asrCacheIsProvisioned(cacheDir = resolveAsrCacheDir()) {
  return ASR_CACHE_FILES.every((relative) => fsSync.existsSync(path.join(cacheDir, ASR_MODEL_ID, relative)));
}

/**
 * Offline-deterministic transcription engine factory.
 *
 * Environment:
 *   LATTICE_ASR_CACHE          — cache directory override
 *   LATTICE_ASR_ALLOW_DOWNLOAD — "1" allows the one-time model download
 *   LATTICE_ASR_ENGINE         — "stub" selects the test-only deterministic
 *                                stub engine (never used in production runs)
 */
export async function createTranscriptionEngine({ language = ASR_LANGUAGE } = {}) {
  if (process.env.LATTICE_ASR_ENGINE === "stub") {
    const { createStubTranscriptionEngine } = await import("./whisper-stub.js");
    return createStubTranscriptionEngine({ language });
  }
  const { pipeline, env } = await import("@huggingface/transformers");
  const cacheDir = resolveAsrCacheDir();
  const allowDownload = process.env.LATTICE_ASR_ALLOW_DOWNLOAD === "1";
  if (!asrCacheIsProvisioned(cacheDir) && !allowDownload) {
    throw Object.assign(
      new Error(
        `the whisper model is not cached for offline transcription. Model: ${ASR_MODEL_ID}. ` +
        `Expected cache: ${cacheDir}/<model files>. Provision it once with ` +
        `LATTICE_ASR_ALLOW_DOWNLOAD=1 lattice audience pack ... (downloads ~800MB-1GB into the cache; ` +
        `subsequent runs are fully offline), or set LATTICE_ASR_CACHE to a directory that already ` +
        `carries the model. Refusing to hang on or start an implicit download.`,
      ),
      { code: "asr-model-not-cached" },
    );
  }
  env.cacheDir = cacheDir;
  env.allowRemoteModels = allowDownload;
  const transcriber = await pipeline("automatic-speech-recognition", ASR_MODEL_ID, {
    dtype: ASR_DTYPE,
    device: "cpu",
  });
  return {
    engine: "transformers.js",
    engineVersion: transformersVersion(),
    model: ASR_MODEL_ID,
    dtype: ASR_DTYPE,
    language,
    async transcribe({ samples }) {
      const output = await transcriber(samples, {
        language,
        task: "transcribe",
        chunk_length_s: 30,
        stride_length_s: 5,
        return_timestamps: true,
      });
      return {
        text: typeof output?.text === "string" ? output.text : "",
        chunks: (output?.chunks ?? []).map((chunk) => ({
          timestamp: [chunk.timestamp?.[0] ?? null, chunk.timestamp?.[1] ?? null],
          text: String(chunk.text ?? ""),
        })),
      };
    },
  };
}

// ---- WAV decoding ------------------------------------------------------------

/**
 * Parse a RIFF/WAVE buffer and return { channels, sampleRate, samples } as a
 * Float32Array (-1.0..1.0) of the first PCM16 channel. Only PCM16 input is
 * supported — the lattice narration pipeline always produces PCM16.
 */
export function decodeWavPcm16(buffer) {
  if (buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("not a RIFF/WAVE file");
  }
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    if (chunkId === "fmt ") {
      format = {
        audioFormat: buffer.readUInt16LE(offset + 8),
        channels: buffer.readUInt16LE(offset + 10),
        sampleRate: buffer.readUInt32LE(offset + 12),
        bitsPerSample: buffer.readUInt16LE(offset + 22),
      };
    } else if (chunkId === "data") {
      data = buffer.subarray(offset + 8, offset + 8 + chunkSize);
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  if (!format || !data) throw new Error("WAV file is missing fmt or data chunk");
  if (format.audioFormat !== 1 || format.bitsPerSample !== 16) {
    throw new Error(`only PCM16 WAV is supported, got audioFormat=${format.audioFormat} bits=${format.bitsPerSample}`);
  }
  const frames = Math.floor(data.length / 2 / format.channels);
  const samples = new Float32Array(frames);
  for (let index = 0; index < frames; index += 1) {
    samples[index] = data.readInt16LE(index * 2 * format.channels) / 32768;
  }
  return { channels: format.channels, sampleRate: format.sampleRate, samples };
}

/** Per-window RMS in dBFS. Silence (zero energy) maps to -Infinity. */
export function rmsDb(samples, start = 0, end = samples.length) {
  let sum = 0;
  const count = Math.max(0, end - start);
  for (let index = start; index < end; index += 1) {
    sum += samples[index] * samples[index];
  }
  if (count === 0 || sum === 0) return -Infinity;
  return 20 * Math.log10(Math.sqrt(sum / count));
}

/**
 * Deterministic linear resample to the ASR model's native rate (16 kHz).
 * Shared by the pack builder and the publish pipeline so both feed whisper
 * byte-identical audio.
 */
export function resampleLinear(samples, fromRate, toRate) {
  if (fromRate === toRate) return samples;
  const ratio = fromRate / toRate;
  const outLength = Math.floor(samples.length / ratio);
  const audio = new Float32Array(outLength);
  for (let index = 0; index < outLength; index += 1) {
    const position = index * ratio;
    const low = Math.floor(position);
    const frac = position - low;
    const a = samples[Math.min(low, samples.length - 1)];
    const b = samples[Math.min(low + 1, samples.length - 1)];
    audio[index] = a + (b - a) * frac;
  }
  return audio;
}
