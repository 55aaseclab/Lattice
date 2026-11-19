// lattice audio — M10 creation-time audio workflows (narration + BGM).
//
// The deck's notes are the narration text source (M2 presenter view data);
// narration audio is synthesized per timeline segment and must land inside
// its segment's frame range. Synthesis is a creation-time, one-shot action:
// the artifact is a deck asset (assets/audio/narration.wav) and the timeline
// carries the narration declaration (timeline.audio.narration voice/speed)
// plus the narration audioTrack — written through the same auditable loop as
// lattice edit (gate/provenance/validate). The render pipeline only consumes
// audioTracks, so video rendering is untouched by this command.

import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config/index.js";
import { deckDirPath, readManifest, readLockRecord, requireV2Manifest } from "../edit/deck-view.js";
import { sha256Hex } from "../edit/provenance.js";
import { resolveTimeline } from "@55aaseclab/lattice-runtime/timeline";
import { validateStopRevealAnimation } from "@55aaseclab/lattice-runtime/themes/simple-light/presets";
import { applyTimelineAudioEdits } from "../audio/timeline-write.js";
import { synthBgmArgs, runFfmpeg, BGM_STYLES } from "../audio/bgm-synth.js";
import { stitchNarrationWav, roundFrameLength } from "../audio/wav.js";
import {
  createNarrationEngine,
  isKnownNarrationVoice,
  listKokoroVoices,
} from "../audio/kokoro.js";
import {
  PIPER_RELEASE,
  createPiperNarrationEngine,
  ensureDeterminismShim,
  isKnownNarrationEngine,
  isKnownPiperVoice,
  listPiperVoices,
} from "../audio/piper.js";

const DEFAULT_NARRATION_VOICE = "af_heart";
const DEFAULT_NARRATION_SPEED = 1;
export const NARRATION_TRACK_ID = "narration";
export const NARRATION_ASSET_PATH = "./assets/audio/narration.wav";
export const NARRATION_DECLARATION_PATH = "audio.narration";

function fail(payload, exitCode = 1) {
  process.stderr.write(`${JSON.stringify({ ok: false, command: "audio", ...payload }, null, 2)}\n`);
  process.exit(exitCode);
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify({ ok: true, command: "audio", ...payload }, null, 2)}\n`);
}

function resolveTimestamp(input) {
  const candidate = typeof input === "string" && input.trim() !== "" ? input.trim() : new Date().toISOString();
  const parsed = new Date(candidate);
  if (Number.isNaN(parsed.getTime())) {
    fail({ error: { code: "invalid-timestamp", message: `--timestamp must be an ISO instant, got ${JSON.stringify(input)}` } }, 2);
  }
  return parsed.toISOString();
}

const AUDIO_USAGE = `Usage:
  lattice audio voices
  lattice audio narrate --deck <id> [--engine kokoro|piper] [--voice <name>] [--speed <n>]
                        [--actor <id>] [--reason <text>] [--timestamp <iso>]
  lattice audio bgm --deck <id> --style ambient --seed <n> [--volume <n>]
  lattice audio bgm --deck <id> --src <file> [--volume <n>]
                    [--actor <id>] [--reason <text>] [--timestamp <iso>]

M10 audio workflows. Creation-time, deterministic, JSON-out: failures go to
stderr as one JSON object, exit codes 0 applied, 1 refused, 2 infrastructure.

"lattice audio bgm" produces the background track: --style ambient --seed <n>
synthesizes a deterministic ambient pad with ffmpeg (same seed, same bytes),
--src <file> validates and copies a supplied audio file. The bgm audioTrack
(and, for synthesized tracks, the style/seed declaration) is written back to
the timeline like narration.


"lattice audio voices" prints the machine-readable TTS voice catalog (V2.0.25:
every voice carries its engine; kokoro-js voices af_heart & co, piper voices
discovered from the provisioned cache, e.g. zh_CN-huayan-medium for Chinese).
Agents pick narration voices from this catalog — never guessed names.

"lattice audio narrate" synthesizes one narration.wav from the deck's notes:
per-slide segments placed exactly on the timeline's frame grid (silence fills
the gaps), each segment's speech must fit inside its slide's durationFrames —
an over-run is refused before anything is written, naming the exceeded frames.
The narration declaration (engine/voice/speed) and the narration audioTrack are
written back to the deck's timeline through the auditable loop; on a
content-locked deck the write is refused with re-freeze guidance, and a deck
that already carries the exact declaration regenerates only the asset.

Engines (V2.0.25): timeline.audio.narration.engine selects the TTS backend —
"kokoro" (default, kokoro-js, English voice catalog) or "piper" (standalone
binary, zh voices e.g. zh_CN-huayan-medium; byte-deterministic via a
CLOCK_REALTIME-freeze shim, built once into the piper cache). An unknown
engine or an unknown voice for that engine is refused before any write.

Per-segment speed (V2.0.21): a slide may override the narration speed for its
own segment via timeline.slides.<id>.audio = { "speed": <n> } (validated by
the timeline contract, hand-edited + re-frozen on locked decks). The override
wins over --speed and the declaration; the duration gate measures the audio
each segment actually produced at its effective speed. (Piper maps speed to
--length_scale = 1/speed; the relation is monotone but non-linear, like
kokoro's.)

Environment: LATTICE_TTS_CACHE (kokoro cache dir, default
~/.cache/lattice/kokoro), LATTICE_TTS_ALLOW_DOWNLOAD=1 (one-time kokoro model
provisioning), LATTICE_TTS_ENGINE (silent kokoro test engine only),
LATTICE_PIPER_DIR (piper cache dir, default ~/.cache/lattice/piper),
LATTICE_PIPER_ENGINE (stub piper test engine only).`;

export async function audioCommand({ args, rest }) {
  const [subcommand] = rest;
  if (!subcommand || subcommand === "--help" || subcommand === "help") {
    console.log(AUDIO_USAGE);
    return;
  }

  if (subcommand === "voices") {
    const kokoro = await listKokoroVoices();
    const piperVoices = listPiperVoices();
    const catalog = {
      schema: kokoro.schema,
      defaultVoice: kokoro.defaultVoice,
      engines: [
        {
          id: "kokoro",
          backend: kokoro.backend,
          version: kokoro.backendVersion,
          model: kokoro.model,
          defaultVoice: kokoro.defaultVoice,
        },
        {
          id: "piper",
          release: PIPER_RELEASE,
          defaultVoice: null,
          provisioned: Object.keys(piperVoices).length > 0,
        },
      ],
      voices: {},
    };
    for (const [id, meta] of Object.entries(kokoro.voices)) {
      catalog.voices[id] = { ...meta, engine: "kokoro" };
    }
    for (const [id, meta] of Object.entries(piperVoices)) {
      catalog.voices[id] = { ...meta, engine: "piper" };
    }
    process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`);
    return;
  }

  if (subcommand === "narrate") {
    await narrateCommand({ args });
    return;
  }

  if (subcommand === "bgm") {
    await bgmCommand({ args });
    return;
  }

  console.error(`[lattice] unknown audio subcommand: ${subcommand}`);
  process.exit(1);
}

// ---- shared preflight --------------------------------------------------------

async function loadDeckContext({ cwd, deckId }) {
  const config = await loadConfig(cwd);
  const deckDir = deckDirPath(cwd, config, deckId);
  if (!fsSync.existsSync(deckDir)) {
    fail({ error: { code: "deck-not-found", message: `deck directory not found: ${deckDir}` } }, 1);
  }
  let manifest;
  try {
    manifest = requireV2Manifest(readManifest(deckDir), deckId);
  } catch (error) {
    fail({ error: { code: error.code ?? "invalid-manifest", message: error.message } }, 1);
  }
  if (manifest.timeline === undefined) {
    fail({
      error: {
        code: "timeline-not-declared",
        message: `deck "${deckId}" does not declare a lattice.timeline.v1 in manifest.json; audio workflows require one (M7 timeline contract)`,
      },
    }, 1);
  }
  const entrySlides = manifest.entry?.slides;
  if (typeof entrySlides !== "string" || entrySlides === "") {
    fail({ error: { code: "invalid-manifest", message: `deck "${deckId}" must declare manifest.entry.slides` } }, 1);
  }
  const { createProjectModuleLoader } = await import("../deck-v2/project-module-loader.js");
  const loader = await createProjectModuleLoader(cwd);
  let slideDefinitions;
  let notes;
  try {
    const module = await loader.load(path.resolve(deckDir, entrySlides));
    slideDefinitions = module?.slideDefinitions;
    if (!Array.isArray(slideDefinitions) || slideDefinitions.length === 0) {
      fail({ error: { code: "invalid-manifest", message: `deck "${deckId}": ${entrySlides} must export a non-empty slideDefinitions array` } }, 1);
    }
    const notesPath = manifest.entry?.notes ? path.resolve(deckDir, manifest.entry.notes) : path.join(deckDir, "notes.js");
    if (fsSync.existsSync(notesPath)) {
      const notesModule = await loader.load(notesPath);
      notes = JSON.parse(JSON.stringify(notesModule.default ?? notesModule));
    } else {
      notes = {};
    }
  } catch (error) {
    fail({ error: { code: "deck-build-error", message: error.message } }, 1);
  } finally {
    await loader.close();
  }
  const resolution = resolveTimeline({
    manifest,
    slides: slideDefinitions,
    validateAnimation: (animation, options) => validateStopRevealAnimation(animation, options),
  });
  if (!resolution.ok) {
    fail({
      error: {
        code: "invalid-timeline",
        message: `deck "${deckId}" declares an invalid lattice.timeline.v1: ${resolution.errors.map((error) => error.message).join("; ")}`,
      },
    }, 1);
  }
  const route = manifest.routes?.main ?? manifest.routes?.[Object.keys(manifest.routes ?? {})[0]];
  if (!Array.isArray(route) || route.length === 0) {
    fail({ error: { code: "invalid-manifest", message: `deck "${deckId}" must declare a non-empty main route` } }, 1);
  }
  const segments = resolution.timeline.slides
    .filter((entry) => route.includes(entry.slideId))
    .sort((a, b) => route.indexOf(a.slideId) - route.indexOf(b.slideId));
  const totalFrames = segments.reduce((sum, segment) => sum + segment.durationFrames, 0);
  return { config, manifest, deckDir, timeline: resolution.timeline, segments, totalFrames, notes, fps: manifest.fps ?? 30 };
}

function narrationTrackEntry() {
  return { id: NARRATION_TRACK_ID, src: NARRATION_ASSET_PATH, startFrame: 0, volume: 1 };
}

/**
 * Desired timeline state for narration: the audio.narration declaration and
 * the audioTracks entry. Returns only the edits that are actually needed
 * (structural equality against the current manifest timeline).
 */
function planNarrationTimelineEdits(timeline, { engine, voice, speed, preserveEngineKey = false, declared = null }) {
  const edits = [];
  const desiredDeclaration = desiredNarrationDeclaration({ engine, voice, speed, preserveEngineKey, declared });
  if (!jsonValuesEqual(timeline.audio?.narration ?? null, desiredDeclaration)) {
    edits.push({ path: NARRATION_DECLARATION_PATH, value: desiredDeclaration });
  }
  const existingTracks = Array.isArray(timeline.audioTracks) ? timeline.audioTracks : [];
  const existingNarration = existingTracks.find((track) => track?.id === NARRATION_TRACK_ID);
  const desiredTrack = narrationTrackEntry();
  if (!existingNarration || !jsonValuesEqual(existingNarration, desiredTrack)) {
    const nextTracks = [desiredTrack, ...existingTracks.filter((track) => track?.id !== NARRATION_TRACK_ID)];
    edits.push({ path: "audioTracks", value: nextTracks });
  }
  return edits;
}

function jsonValuesEqual(a, b) {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => jsonValuesEqual(item, b[index]));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return keysA.length === keysB.length && keysA.every((key) => jsonValuesEqual(a[key], b[key]));
  }
  return false;
}

/** Restore or remove the narration asset after a failed write-back. */
async function rollbackAsset(assetPath, previousBytes) {
  if (previousBytes === null) {
    await fsp.rm(assetPath, { force: true });
    return;
  }
  await fsp.writeFile(assetPath, previousBytes);
}

// ---- narrate -----------------------------------------------------------------

async function narrateCommand({ args }) {
  const cwd = process.cwd();
  const deckId = args.deck;
  if (typeof deckId !== "string" || deckId === "") {
    fail({ error: { code: "missing-argument", message: "--deck <id> is required" } }, 2);
  }
  const actor = typeof args.actor === "string" && args.actor.trim() !== "" ? args.actor.trim() : "unknown";
  const reason = typeof args.reason === "string" ? args.reason : null;
  const when = resolveTimestamp(args.timestamp);
  const context = await loadDeckContext({ cwd, deckId });
  const { timeline, segments, notes, fps, totalFrames, deckDir } = context;

  if (segments.some((segment) => typeof notes[segment.slideId] !== "string" || notes[segment.slideId].trim() === "")) {
    const missing = segments.filter((segment) => typeof notes[segment.slideId] !== "string" || notes[segment.slideId].trim() === "").map((segment) => segment.slideId);
    fail({
      error: {
        code: "narration-notes-missing",
        message: `deck "${deckId}" has no presenter notes for slide(s): ${missing.join(", ")}; every routed slide needs a notes entry before narration can be synthesized`,
      },
    }, 1);
  }

  // Narration parameters: flags win over the declaration, declaration wins
  // over defaults; the effective values are validated against the
  // machine-readable voice catalog and written back so the timeline stays
  // the single source of truth. V2.0.25: the engine field selects the TTS
  // backend ("kokoro" default, "piper" for zh voices) — an unknown engine is
  // refused before any synthesis, asset write, or timeline write.
  const declared = timeline.audio?.narration ?? null;
  const engine = typeof args.engine === "string" && args.engine !== "" ? args.engine : declared?.engine ?? "kokoro";
  if (!isKnownNarrationEngine(engine)) {
    fail({
      error: {
        code: "unknown-narration-engine",
        message: `unknown narration engine ${JSON.stringify(engine)}; available engines: kokoro, piper (see "lattice audio voices")`,
        engine,
      },
      zeroWrites: true,
    }, 1);
  }
  const defaultVoice = engine === "piper" ? null : DEFAULT_NARRATION_VOICE;
  const voice = typeof args.voice === "string" && args.voice !== "" ? args.voice : declared?.voice ?? defaultVoice;
  if (voice === undefined || voice === null || voice === "") {
    fail({
      error: {
        code: "narration-voice-required",
        message: `engine ${JSON.stringify(engine)} has no default voice; declare timeline.audio.narration.voice or pass --voice (see "lattice audio voices")`,
        engine,
      },
      zeroWrites: true,
    }, 1);
  }
  const speedFlag = args.speed !== undefined ? Number(args.speed) : undefined;
  if (args.speed !== undefined && (!Number.isFinite(speedFlag) || speedFlag <= 0)) {
    fail({ error: { code: "invalid-narration-speed", message: `--speed must be a positive finite number, got ${JSON.stringify(args.speed)}` } }, 1);
  }
  const speed = speedFlag ?? declared?.speed ?? DEFAULT_NARRATION_SPEED;
  // Declaration-contract check, engine-scoped: an unknown voice is refused
  // before any synthesis, asset write, or timeline write.
  const voiceKnown = engine === "piper" ? isKnownPiperVoice(voice) : await isKnownNarrationVoice(voice);
  if (!(await voiceKnown)) {
    const catalog = await listKokoroVoices();
    fail({
      error: {
        code: "unknown-narration-voice",
        message: `unknown narration voice ${JSON.stringify(voice)} for engine ${JSON.stringify(engine)}; pick one from "lattice audio voices" (kokoro-js ${catalog.backendVersion} / piper ${PIPER_RELEASE})`,
        voice,
      },
      zeroWrites: true,
    }, 1);
  }
  const timelineEdits = planNarrationTimelineEdits(timeline, { engine, voice, speed, preserveEngineKey: typeof declared?.engine === "string", declared });

  // Refuse before ANY work when the deck is locked and the declaration would
  // change (zero writes), matching the edit loop's gate semantics.
  if (timelineEdits.length > 0) {
    const lockRecord = readLockRecord(path.resolve(cwd, ".lattice", "content-locks"), deckId);
    if (lockRecord && lockRecord.fingerprint) {
      fail({
        error: {
          code: "content-lock-gate-rejected",
          message: `deck "${deckId}" is content-locked and its narration declaration does not match the requested parameters; ` +
            `declare it by hand and re-freeze with "lattice lock update --deck ${deckId}" (M10 flow), then re-run narrate — the declared values make it idempotent`,
          requested: { voice, speed },
          declared: declared ?? null,
        },
        gate: { contentLock: { mode: "enforced", decision: "reject", lockPath: lockRecord.lockPath } },
        zeroWrites: true,
      }, 1);
    }
  }

  const engineImplementation = await (engine === "piper"
    ? createPiperNarrationEngine({ voice, speed })
    : createNarrationEngine({ voice, speed })
  ).catch((error) => {
    fail({ error: { code: error.code ?? "tts-engine-failed", message: error.message } }, error.code === "unknown-narration-voice" || error.code === "tts-model-not-cached" || error.code === "piper-not-provisioned" || error.code === "piper-determinism-shim-unavailable" ? 1 : 2);
  });

  // V2.0.21: per-slide speed overrides — `timeline.slides.<id>.audio.speed`
  // (validated by the timeline resolution) beats the narration declaration,
  // which beats the engine default. The duration gate below measures the
  // audio actually generated at each segment's effective speed.
  const effectiveSpeed = (segment) =>
    segment.audio?.speed ?? declared?.speed ?? DEFAULT_NARRATION_SPEED;

  // Synthesize to memory first: the duration gate must pass before anything
  // is written into the deck.
  const generated = [];
  for (const segment of segments) {
    const text = notes[segment.slideId].trim();
    const segmentSpeed = effectiveSpeed(segment);
    const audio = await engineImplementation.generate(text, { speed: segmentSpeed });
    const allowedSeconds = segment.durationFrames / fps;
    const actualSeconds = audio.samples.length / audio.sampleRate;
    const fitFrames = roundFrameLength(audio.samples.length, audio.sampleRate, fps);
    if (actualSeconds > allowedSeconds + 1e-9) {
      const overrunFrames = Math.round((actualSeconds - allowedSeconds) * fps * 100) / 100;
      fail({
        error: {
          code: "narration-overruns-segment",
          message: `narration for slide "${segment.slideId}" is ${actualSeconds.toFixed(3)}s but its timeline segment is only ${allowedSeconds.toFixed(3)}s ` +
            `(${segment.durationFrames} frames @ ${fps} fps): over by ${overrunFrames} frames. Shorten the note, raise the slide's speed ` +
            `(timeline.slides.${segment.slideId}.audio.speed or --speed), or edit timeline.slides.${segment.slideId}.durationFrames.`,
          slide: segment.slideId,
          speed: segmentSpeed,
          audioSeconds: Math.round(actualSeconds * 1000) / 1000,
          segmentSeconds: Math.round(allowedSeconds * 1000) / 1000,
          segmentFrames: segment.durationFrames,
          overrunFrames,
          fitFrames,
        },
        zeroWrites: true,
      }, 1);
    }
    generated.push({ slideId: segment.slideId, samples: audio.samples, speed: segmentSpeed });
  }

  const stitched = stitchNarrationWav({ segments: generated, plan: segments, fps, totalFrames, sampleRate: engineImplementation.sampleRate });
  const assetsDir = path.resolve(deckDir, "assets", "audio");
  await fsp.mkdir(assetsDir, { recursive: true });
  const assetPath = path.join(assetsDir, "narration.wav");
  const previousBytes = fsSync.existsSync(assetPath) ? await fsp.readFile(assetPath) : null;
  await fsp.writeFile(assetPath, stitched.buffer);

  let writeBack;
  try {
    writeBack = await applyTimelineAudioEdits({
      cwd,
      deckId,
      edits: timelineEdits,
      actor,
      when,
      reason,
      command: "audio-narrate",
    });
  } catch (error) {
    await rollbackAsset(assetPath, previousBytes);
    if (error.audioPayload) fail(error.audioPayload, error.audioExitCode ?? 1);
    throw error;
  }

  emit({
    action: "narrate",
    deck: deckId,
    engine: { name: engineImplementation.engine, version: engineImplementation.engineVersion, model: engineImplementation.model, voice, speed, sampleRate: engineImplementation.sampleRate },
    asset: {
      path: path.relative(cwd, assetPath).split(path.sep).join("/"),
      bytes: stitched.buffer.length,
      sha256: sha256Hex(stitched.buffer),
      durationSeconds: Math.round(stitched.durationSeconds * 1000) / 1000,
    },
    segments: stitched.segments.map((placement) => {
      const generatedSegment = generated.find((entry) => entry.slideId === placement.slideId);
      return {
        slideId: placement.slideId,
        startFrame: placement.startFrame,
        durationFrames: placement.durationFrames,
        audioFrames: placement.fitFrames,
        startSeconds: Math.round((placement.startSample / stitched.sampleRate) * 1000) / 1000,
        // V2.0.21: the speed this segment's speech was actually synthesized
        // with (per-slide override > narration declaration > engine default).
        speed: generatedSegment?.speed ?? speed,
      };
    }),
    timeline: {
      narration: desiredNarrationDeclaration({ engine, voice, speed, preserveEngineKey: typeof timeline.audio?.narration?.engine === "string", declared: timeline.audio?.narration ?? null }),
      writeBack: {
        changed: writeBack.changed,
        applied: writeBack.applied.map((entry) => ({ path: entry.path, operation: entry.operation })),
        ...(writeBack.changed ? { provenance: writeBack.provenance } : {}),
      },
    },
  });
}

function desiredNarrationDeclaration({ engine, voice, speed, preserveEngineKey = false, declared = null }) {
  // V2.0.25: the engine key rides along only when it is meaningful —
  // "kokoro" is the default (omitted keeps existing decks' declarations
  // byte-stable and idempotent), "piper" must be declared explicitly. A deck
  // that already declares the engine key keeps it (no write churn). Any
  // other declared optional keys (e.g. language) are preserved as-is.
  const known = new Set(["engine", "voice", "speed"]);
  const extras = {};
  for (const [key, value] of Object.entries(declared ?? {})) {
    if (!known.has(key)) extras[key] = value;
  }
  const engineKey = engine !== "kokoro" || preserveEngineKey ? { engine } : {};
  return { ...extras, ...engineKey, voice, ...(speed === DEFAULT_NARRATION_SPEED ? {} : { speed }) };
}

// ---- bgm -----------------------------------------------------------------

const BGM_TRACK_ID = "bgm";
const BGM_ASSET_PATH = "./assets/audio/bgm.wav";
const BGM_DECLARATION_PATH = "audio.bgm";
const DEFAULT_BGM_VOLUME = 0.2;

async function bgmCommand({ args }) {
  const cwd = process.cwd();
  const deckId = args.deck;
  if (typeof deckId !== "string" || deckId === "") {
    fail({ error: { code: "missing-argument", message: "--deck <id> is required" } }, 2);
  }
  const actor = typeof args.actor === "string" && args.actor.trim() !== "" ? args.actor.trim() : "unknown";
  const reason = typeof args.reason === "string" ? args.reason : null;
  const when = resolveTimestamp(args.timestamp);
  const volumeFlag = args.volume !== undefined ? Number(args.volume) : undefined;
  if (args.volume !== undefined && (!Number.isFinite(volumeFlag) || volumeFlag < 0 || volumeFlag > 1)) {
    fail({ error: { code: "invalid-bgm-volume", message: `--volume must be a number in [0, 1], got ${JSON.stringify(args.volume)}` } }, 1);
  }
  const volume = volumeFlag ?? DEFAULT_BGM_VOLUME;

  const hasStyle = args.style !== undefined;
  const hasSeed = args.seed !== undefined;
  const hasSrc = args.src !== undefined;
  if (hasStyle === hasSrc && !hasStyle) {
    fail({ error: { code: "missing-argument", message: "bgm requires either --style ambient --seed <n> (deterministic synthesis) or --src <file> (supplied audio)" } }, 2);
  }
  if (hasStyle && hasSrc) {
    fail({ error: { code: "mutually-exclusive-arguments", message: "--style/--seed and --src are mutually exclusive: one command run produces one bgm asset" } }, 1);
  }

  const context = await loadDeckContext({ cwd, deckId });
  const { timeline, deckDir, totalFrames, fps } = context;

  const timelineEdits = [];
  let synthDescription = null;
  if (hasStyle) {
    if (args.style !== "ambient" && !Object.hasOwn(BGM_STYLES, args.style)) {
      fail({ error: { code: "unknown-bgm-style", message: `unknown bgm style ${JSON.stringify(args.style)} (available: ${Object.keys(BGM_STYLES).join(", ")})` } }, 1);
    }
    const seed = Number(args.seed);
    if (args.seed === undefined || !Number.isInteger(seed) || seed < 0) {
      fail({ error: { code: "invalid-bgm-seed", message: `--seed must be a non-negative integer, got ${JSON.stringify(args.seed ?? null)}` } }, 1);
    }
    synthDescription = { style: args.style, seed };
    const existingTracks = Array.isArray(timeline.audioTracks) ? timeline.audioTracks : [];
    const existingBgm = existingTracks.find((track) => track?.id === BGM_TRACK_ID);
    const desiredTrack = { id: BGM_TRACK_ID, src: BGM_ASSET_PATH, startFrame: 0, volume };
    if (!jsonValuesEqual(timeline.audio?.bgm ?? null, synthDescription)) {
      timelineEdits.push({ path: BGM_DECLARATION_PATH, value: synthDescription });
    }
    if (!existingBgm || !jsonValuesEqual(existingBgm, desiredTrack)) {
      timelineEdits.push({ path: "audioTracks", value: [...existingTracks.filter((track) => track?.id !== BGM_TRACK_ID), desiredTrack] });
    }
  } else {
    if (timeline.audio?.bgm !== undefined) {
      fail({
        error: {
          code: "bgm-declaration-conflict",
          message: `deck "${deckId}" declares a synthesized bgm (timeline.audio.bgm = ${JSON.stringify(timeline.audio.bgm)}); ` +
            `remove or update that declaration before supplying an external --src, or run the matching --style/--seed synthesis`,
        },
      }, 1);
    }
    const existingTracks = Array.isArray(timeline.audioTracks) ? timeline.audioTracks : [];
    const existingBgm = existingTracks.find((track) => track?.id === BGM_TRACK_ID);
    const desiredTrack = { id: BGM_TRACK_ID, src: BGM_ASSET_PATH, startFrame: 0, volume };
    if (!existingBgm || !jsonValuesEqual(existingBgm, desiredTrack)) {
      timelineEdits.push({ path: "audioTracks", value: [...existingTracks.filter((track) => track?.id !== BGM_TRACK_ID), desiredTrack] });
    }
  }

  // Content Lock gate — refuse before any work when writes would be needed.
  if (timelineEdits.length > 0) {
    const lockRecord = readLockRecord(path.resolve(cwd, ".lattice", "content-locks"), deckId);
    if (lockRecord && lockRecord.fingerprint) {
      fail({
        error: {
          code: "content-lock-gate-rejected",
          message: `deck "${deckId}" is content-locked and its bgm declaration does not match the requested parameters; ` +
            `declare it by hand and re-freeze with "lattice lock update --deck ${deckId}" (M10 flow), then re-run bgm — the declared values make it idempotent`,
          requested: synthDescription ?? { src: args.src },
          declared: timeline.audio?.bgm ?? null,
        },
        gate: { contentLock: { mode: "enforced", decision: "reject", lockPath: lockRecord.lockPath } },
        zeroWrites: true,
      }, 1);
    }
  }

  const assetsDir = path.resolve(deckDir, "assets", "audio");
  await fsp.mkdir(assetsDir, { recursive: true });
  const assetPath = path.join(assetsDir, "bgm.wav");
  const previousBytes = fsSync.existsSync(assetPath) ? await fsp.readFile(assetPath) : null;
  const durationSeconds = totalFrames / fps;

  if (hasSrc) {
    const sourcePath = path.resolve(cwd, args.src);
    if (!fsSync.existsSync(sourcePath) || !fsSync.statSync(sourcePath).isFile()) {
      fail({ error: { code: "bgm-source-missing", message: `--src file not found: ${sourcePath}` } }, 1);
    }
    const probe = await probeAudio(sourcePath);
    if (!probe.hasAudio) {
      fail({ error: { code: "bgm-source-not-audio", message: `--src file has no audio stream: ${sourcePath}` } }, 1);
    }
    if (probe.durationSeconds !== null && probe.durationSeconds + 1e-6 < durationSeconds) {
      fail({
        error: {
          code: "bgm-source-too-short",
          message: `--src audio is ${probe.durationSeconds.toFixed(3)}s but the plan needs ${durationSeconds.toFixed(3)}s (${totalFrames} frames @ ${fps} fps)`,
          durationSeconds: probe.durationSeconds,
          requiredSeconds: Math.round(durationSeconds * 1000) / 1000,
        },
      }, 1);
    }
    await fsp.copyFile(sourcePath, assetPath);
  } else {
    const { args: ffmpegArgs } = { args: synthBgmArgs({ style: synthDescription.style, seed: synthDescription.seed, durationSeconds, sampleRate: 44100 }) };
    await runFfmpeg([...ffmpegArgs, assetPath]);
  }

  let writeBack;
  try {
    writeBack = await applyTimelineAudioEdits({
      cwd,
      deckId,
      edits: timelineEdits,
      actor,
      when,
      reason,
      command: "audio-bgm",
    });
  } catch (error) {
    await rollbackAsset(assetPath, previousBytes);
    if (error.audioPayload) fail(error.audioPayload, error.audioExitCode ?? 1);
    throw error;
  }

  const bytes = await fsp.stat(assetPath);
  emit({
    action: "bgm",
    deck: deckId,
    source: hasSrc ? { mode: "file", path: path.resolve(cwd, args.src).split(path.sep).join("/") } : { mode: "synthesized", ...synthDescription, generator: "ffmpeg-aevalsrc", sampleRate: 44100, channels: 2 },
    asset: {
      path: path.relative(cwd, assetPath).split(path.sep).join("/"),
      bytes: bytes.size,
      sha256: sha256Hex(await fsp.readFile(assetPath)),
      durationSeconds: Math.round(durationSeconds * 1000) / 1000,
    },
    timeline: {
      bgm: synthDescription ?? null,
      writeBack: {
        changed: writeBack.changed,
        applied: writeBack.applied.map((entry) => ({ path: entry.path, operation: entry.operation })),
        ...(writeBack.changed ? { provenance: writeBack.provenance } : {}),
      },
    },
  });
}

function probeAudio(filePath) {
  return new Promise((resolve) => {
    execFile("ffprobe", ["-v", "error", "-print_format", "json", "-show_streams", "-show_format", filePath], { timeout: 60000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve({ hasAudio: false, durationSeconds: null });
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        const audioStreams = (parsed.streams ?? []).filter((stream) => stream.codec_type === "audio");
        const duration = Number(parsed.format?.duration);
        resolve({ hasAudio: audioStreams.length > 0, durationSeconds: Number.isFinite(duration) ? duration : null });
      } catch {
        resolve({ hasAudio: false, durationSeconds: null });
      }
    });
  });
}
