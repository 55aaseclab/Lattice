import { loadConfig } from "../config/index.js";
import {
  compileVideoPlan,
  hashVideoPlan,
  serializeVideoPlan,
  validateVideoPlan,
  bakeVideoPlanProvenance,
  VIDEO_PLAN_SCHEMA,
  VIDEO_PLAN_SCHEMA_V2,
} from "@55aaseclab/lattice-runtime/video-plan";
import { RUNTIME_VERSION } from "@55aaseclab/lattice-runtime/deck";
import { DECK_SCHEMA_V2 } from "@55aaseclab/lattice-runtime/deck-v2";
import { validateSlideWebBundle } from "../video/bundle.js";
import {
  buildChapters,
  buildSubtitleCues,
  CHAPTERS_SCHEMA,
  loadPackTranscript,
  loadPacingNotes,
  loadPublishContext,
  publishDir,
  renderChaptersText,
  renderSrt,
  PublishError,
  SUBTITLES_SCHEMA,
  transcribeNarration,
} from "../video/publish.js";
import { createHash } from "node:crypto";
import { sha256Hex } from "../edit/provenance.js";
import { promises as fs } from "node:fs";
import fsSync from "node:fs";
import path from "node:path";

async function loadStopRevealPresetCatalog() {
  const { STOP_REVEAL_PRESET_CATALOG } = await import("@55aaseclab/lattice-runtime/themes/simple-light/presets");
  return STOP_REVEAL_PRESET_CATALOG;
}

export async function videoCommand({ args, rest }) {
  const [subcommand] = rest;

  if (!subcommand || subcommand === "--help" || subcommand === "help") {
    console.log(`lattice video — Slide-first video planning, backend management, and rendering

Usage:
  lattice video plan --deck <id> [--route <name>] [--bundle-dir <dir>] [--output <path>]
  lattice video presets
  lattice video doctor --backend remotion|hyperframes
  lattice video still --deck <id> --backend <id> --frame <n> [--route <name>] [--bundle-dir <dir>] [--output <path>]
  lattice video still --deck <id> --backend <id> --frames <n,n,...> [--output <dir>]
  lattice video render --deck <id> --backend <id> [--route <name>] [--bundle-dir <dir>] [--output <path>]
  lattice video subtitles --deck <id> [--out <dir>]
  lattice video chapters --deck <id> [--out <dir>]

"lattice video presets" prints the theme's machine-readable stop-reveal
animation preset catalog (names, parameter schema, defaults). Agents choose
presets and parameters from this catalog; "lattice edit --timeline" validates
values against it before writing anything.

The video workbench is a portal route (issue 005): open "lattice dev" and
visit /workbench/<deck-id> for that deck's timeline visualization, backend
doctor, queued MP4 rendering, in-page Slide-Runtime preview, and artifact
download. There is no standalone workbench process or port; rendered outputs
are server-enforced to stay under .lattice/generated/.

"lattice video subtitles" derives upload-ready SRT subtitles (V2.0.23): the
whisper transcript (the deck pack's transcript.json cache when it matches the
current narration.wav bytes, else a live ASR run through the pack's whisper
path) cut into CJK-safe short cues at every timeline segment boundary and
line cap. The audience loop's residual pacing findings ride the file header
as advisory split-point comments. A deck without narration.wav is a silent
no-op (exit 0, nothing written). Output:
.lattice/generated/publish/<deck>/subtitles.srt (--out <dir> overrides).

"lattice video chapters" derives paste-ready chapter marks from the same
timeline: "00:00 标题" per segment (segment start + slide title), YouTube
and Bilibili compatible. Requires a lattice.timeline.v1 (the chapter
boundaries ARE the segment boundaries). Output:
.lattice/generated/publish/<deck>/chapters.txt (--out <dir> overrides).

"lattice video plan" compiles an engine-neutral integer-frame VideoPlan
(schema "${VIDEO_PLAN_SCHEMA}") from the deck's videoPlan descriptor. The
descriptor contract is a routes map plus timing slides:

  // content.js — default deck content plus a named videoPlan export
  export const videoPlan = {
    routes: { main: ["slide-id-1", "slide-id-2"] },
    slides: [
      { id: "slide-id-1", durationFrames: 60 },
      { id: "slide-id-2", durationFrames: 90 },
    ],
    fps: 30,
    width: 960,
    height: 540,
  };

For lattice.deck.v2 decks the timing comes from the canonical slide
definitions. A deck may additionally declare a unified presentation timeline
(lattice.timeline.v1) in manifest.timeline: per-slide segment durations, stop
frames, animation presets, and audio tracks. Plans for such decks are
compiled under schema "${VIDEO_PLAN_SCHEMA_V2}" and carry each clip's stop
schedule; decks without a timeline keep the exact v1 plan bytes.

The route is selected with --route (default "main"). No backend installation
is required and no backend is initialized. Provenance is derived from real
canonical deck sources (deckHash), the compiled input props (inputPropsHash),
and a real Slide Web Bundle identity (bundleHash). The bundle comes from
--bundle-dir, from an existing "lattice export" output under the outDir, or
from a real sha256 bundleHash in the descriptor; without one of these the
command fails fast instead of writing placeholder hashes. If --output is
omitted, the plan is written to stdout.

"lattice video doctor" inspects the selected backend environment: Node.js,
backend packages and CLI binaries, browser executable, ffmpeg, and ffprobe.
It reports tool presence, versions, paths, and install guidance. It does not
install anything. Unavailable environments exit 2.

"lattice video still" renders one integer frame of the plan through the
selected backend into a PNG (--frame is required). "lattice video still
--frames 0,20,36" renders many stills of the same plan in one warm browser
session (issue 011): compile, prepare, bundle, and browser boot happen once,
and outputs land in the --output directory as frame-00000.png. Multi-still
flows (parity gates, the audience pack) default to this batch path. "lattice
video render" renders the complete plan into an MP4. Both commands prepare the
backend's generated host under .lattice/generated/<backend>/ from the same
VideoPlan and Slide Web Bundle; outputs must not be written into the canonical
deck source or bundle. Plans that declare audioTracks get them mixed into a
single audio track in the rendered MP4. Missing backend dependencies exit 2
with install guidance.
`);
    return;
  }

  if (subcommand === "plan") {
    await handleVideoPlan({ args });
    return;
  }

  if (subcommand === "presets") {
    await handleVideoPresets();
    return;
  }

  if (subcommand === "doctor") {
    await handleVideoDoctor({ args });
    return;
  }

  if (subcommand === "still") {
    await handleVideoStill({ args });
    return;
  }

  if (subcommand === "render") {
    await handleVideoRender({ args });
    return;
  }

  if (subcommand === "subtitles") {
    await handleVideoSubtitles({ args });
    return;
  }

  if (subcommand === "chapters") {
    await handleVideoChapters({ args });
    return;
  }

  console.error(`[lattice] unknown video subcommand: ${subcommand}`);
  process.exit(1);
}

// ---- publish: subtitles + chapters (V2.0.23) ----------------------------------

function publishEmit(payload) {
  process.stdout.write(`${JSON.stringify({ ok: true, command: "video", ...payload }, null, 2)}\n`);
}

function publishFail(payload, exitCode = 1) {
  process.stderr.write(`${JSON.stringify({ ok: false, command: "video", ...payload }, null, 2)}\n`);
  process.exit(exitCode);
}

function resolvePublishOutDir(cwd, deckId, args) {
  if (args.out === undefined) return publishDir(cwd, deckId);
  const requested = path.resolve(cwd, String(args.out));
  const generatedRoot = path.resolve(cwd, ".lattice", "generated");
  const rel = path.relative(generatedRoot, requested);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    publishFail({
      error: { code: "publish-out-of-bounds", message: `--out must stay inside .lattice/generated/ (got ${JSON.stringify(String(args.out))})` },
    }, 1);
  }
  return requested;
}

async function handleVideoSubtitles({ args }) {
  const cwd = process.cwd();
  let context;
  try {
    context = await loadPublishContext({ cwd, deckId: args.deck });
  } catch (error) {
    if (error instanceof PublishError) publishFail(error.payload, error.exitCode);
    throw error;
  }
  const { deckDir, segments, slidesById, fps, totalFrames, narrationPath } = context;
  void slidesById;

  const narrationSha = fsSync.existsSync(narrationPath) ? sha256Hex(fsSync.readFileSync(narrationPath)) : null;
  if (narrationSha === null) {
    // Silent-deck behavior: nothing to transcribe, nothing written.
    publishEmit({
      action: "subtitles",
      deck: args.deck,
      skipped: "no narration.wav in the deck (assets/audio/narration.wav) — a deck without narration carries no subtitle track",
      file: null,
      cues: 0,
    });
    return;
  }

  const pack = loadPackTranscript(cwd, args.deck, narrationSha);
  let source;
  let chunks;
  let asrIdentity = pack?.asr ?? null;
  if (pack) {
    source = `pack transcript.json (packHash ${pack.packHash.slice(0, 12)}…)`;
    chunks = pack.chunks;
  } else {
    const transcribed = await transcribeNarration(narrationPath).catch((error) => {
      publishFail({
        error: {
          code: error?.code === "asr-model-not-cached" ? "asr-model-not-cached" : "asr-failed",
          message: `subtitles could not obtain a transcript: ${error.message}`,
        },
      }, error?.code === "asr-model-not-cached" ? 1 : 2);
    });
    source = `live ASR (${transcribed.engine.model})`;
    chunks = transcribed.chunks;
    asrIdentity = transcribed.engine;
  }

  const cues = buildSubtitleCues({ chunks, segments, fps, totalFrames });
  const pacing = loadPacingNotes(cwd, args.deck);
  const outDir = resolvePublishOutDir(cwd, args.deck, args);
  await fs.mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, "subtitles.srt");
  const srt = renderSrt({
    deckId: args.deck,
    cues,
    source,
    narration: { sha256: narrationSha },
    fps,
    totalFrames,
    pacing,
  });
  await fs.writeFile(outFile, srt, "utf8");

  publishEmit({
    action: "subtitles",
    deck: args.deck,
    schema: SUBTITLES_SCHEMA,
    file: path.relative(cwd, outFile).split(path.sep).join("/"),
    cues: cues.length,
    source,
    asr: asrIdentity,
    narration: { sha256: narrationSha, durationSeconds: Math.round((totalFrames / fps) * 1000) / 1000 },
    pacingNotes: pacing.notes.length,
    pacingSession: pacing.session,
  });
}

async function handleVideoChapters({ args }) {
  const cwd = process.cwd();
  let context;
  try {
    context = await loadPublishContext({ cwd, deckId: args.deck });
  } catch (error) {
    if (error instanceof PublishError) publishFail(error.payload, error.exitCode);
    throw error;
  }
  const { segments, slidesById, fps, totalFrames } = context;
  const chapters = buildChapters({ segments, slidesById, fps });
  const outDir = resolvePublishOutDir(cwd, args.deck, args);
  await fs.mkdir(outDir, { recursive: true });
  const outFile = path.join(outDir, "chapters.txt");
  await fs.writeFile(outFile, renderChaptersText(chapters), "utf8");

  publishEmit({
    action: "chapters",
    deck: args.deck,
    schema: CHAPTERS_SCHEMA,
    file: path.relative(cwd, outFile).split(path.sep).join("/"),
    chapters: chapters.map((chapter) => ({ timecode: chapter.timecode, slideId: chapter.slideId, title: chapter.title, startFrame: chapter.startFrame, seconds: chapter.seconds })),
    totalFrames,
  });
}

const DECK_V1_VIDEOPLAN_REQUIRED = [
  "Deck schema lattice.deck.v1 requires an explicit \"videoPlan\" export in content.js.",
  "",
  "The descriptor is a routes map plus timing slides:",
  "  export const videoPlan = {",
  "    routes: {",
  '      main: ["slide-id-1", "slide-id-2"],',
  "    },",
  "    slides: [",
  '      { id: "slide-id-1", durationFrames: 60 },',
  '      { id: "slide-id-2", durationFrames: 90 },',
  "    ],",
  "    fps: 30,",
  "    width: 960,",
  "    height: 540,",
  "  };",
  "",
  "Select a route explicitly with --route (default: main).",
  "",
  "content.slides arrays containing arbitrary data objects are content,",
  "not video-planning inputs. Timing, order, and canvas cannot be",
  "inferred from data keys.",
].join("\n");

function resolveVideoPlanDescriptor(contentMod, deckId) {
  // Descriptor export contract: a named `videoPlan` export always wins. A
  // module with default deck content plus a named videoPlan export must work;
  // named exports are never silently ignored.
  if (contentMod.videoPlan !== undefined) {
    return { descriptor: contentMod.videoPlan, origin: "named export videoPlan" };
  }
  const defaultExport = contentMod.default;
  if (defaultExport && typeof defaultExport === "object" && defaultExport.videoPlan !== undefined) {
    return { descriptor: defaultExport.videoPlan, origin: "default export videoPlan" };
  }
  console.error(`[lattice] deck "${deckId}" does not provide a videoPlan descriptor.`);
  console.error(DECK_V1_VIDEOPLAN_REQUIRED);
  process.exit(1);
}

/**
 * v2 descriptor source: the manifest itself (routes, fps, canvas) plus the
 * canonical slide definitions (durationFrames, inputProps). The slide entry
 * module is loaded through the project's vite pipeline so CSS-importing
 * slide sources behave exactly like every other Lattice surface.
 *
 * M7: when the manifest declares a lattice.timeline.v1, the descriptor
 * carries the resolved unified timeline — per-slide segment durations, stop
 * frames, and animation declarations replace the static placeholder timing.
 */
async function descriptorFromDeckV2({ deckId, deckDir, manifest, projectRoot = process.cwd() }) {
  const entrySlides = manifest.entry?.slides;
  if (typeof entrySlides !== "string" || entrySlides === "") {
    console.error(`[lattice] deck "${deckId}" (lattice.deck.v2) must declare manifest.entry.slides`);
    process.exit(1);
  }
  const { createProjectModuleLoader } = await import("../deck-v2/project-module-loader.js");
  const loader = await createProjectModuleLoader(projectRoot);
  try {
    const module = await loader.load(path.resolve(deckDir, entrySlides));
    const slideDefinitions = module?.slideDefinitions;
    if (!Array.isArray(slideDefinitions) || slideDefinitions.length === 0) {
      console.error(`[lattice] deck "${deckId}": ${entrySlides} must export a non-empty slideDefinitions array (lattice.deck.v2)`);
      process.exit(1);
    }
    for (const slide of slideDefinitions) {
      if (!slide || typeof slide !== "object" || typeof slide.id !== "string" || slide.id === "") {
        console.error(`[lattice] deck "${deckId}": slide definitions must carry non-empty string ids`);
        process.exit(1);
      }
      if (typeof slide.durationFrames !== "number" || !Number.isInteger(slide.durationFrames) || slide.durationFrames <= 0) {
        console.error(`[lattice] deck "${deckId}": slide "${slide.id}" must have a positive integer durationFrames, got ${slide.durationFrames}`);
        process.exit(1);
      }
    }

    let resolvedTimeline = null;
    if (manifest.timeline !== undefined) {
      const { resolveTimeline } = await import("@55aaseclab/lattice-runtime/timeline");
      const { validateStopRevealAnimation } = await import("@55aaseclab/lattice-runtime/themes/simple-light/presets");
      const resolution = resolveTimeline({
        manifest,
        slides: slideDefinitions,
        validateAnimation: (animation, options) => validateStopRevealAnimation(animation, options),
      });
      if (!resolution.ok) {
        console.error(`[lattice] deck "${deckId}" declares an invalid lattice.timeline.v1:`);
        for (const error of resolution.errors) {
          console.error(`  - [${error.type}] ${error.element ?? error.slide ?? ""}: ${error.message}`);
        }
        process.exit(1);
      }
      resolvedTimeline = resolution.timeline;
    }

    return {
      routes: manifest.routes,
      slides: slideDefinitions.map((slide) => ({
        id: slide.id,
        durationFrames: slide.durationFrames,
        inputProps: slide.inputProps,
      })),
      resolvedTimeline,
      fps: manifest.fps,
      width: manifest.canvas?.width,
      height: manifest.canvas?.height,
      audioTracks: manifest.audioTracks,
      inputProps: manifest.inputProps,
    };
  } catch (error) {
    console.error(`[lattice] cannot import ${entrySlides} for "${deckId}": ${error.message}`);
    process.exit(2);
  } finally {
    await loader.close();
  }
}

function normalizeDescriptor({ descriptor }) {
  return {
    routes: descriptor.routes,
    slides: descriptor.slides,
    resolvedTimeline: descriptor.resolvedTimeline,
    fps: descriptor.fps,
    width: descriptor.width,
    height: descriptor.height,
    audioTracks: descriptor.audioTracks,
    inputProps: descriptor.inputProps,
  };
}

function deckSourceFailure(relPath, reason) {
  console.error(`[lattice] cannot hash deck source "${relPath}": ${reason}`);
  console.error("[lattice] deck provenance requires a fully readable canonical source tree; refusing to write a plan with incomplete provenance.");
  process.exit(2);
}

// deckHash: deterministic SHA-256 identity of the deck's real canonical
// source tree rooted at deckDir. Every regular file under the deck directory
// is covered — manifest.json, the manifest-declared entry (even when
// custom-named), nested local source modules, and deck-owned assets — so
// editing any real source changes the identity. Each file is hashed as
// forward-slashed relative path + NUL + bytes + NUL, in sorted path order:
// no mtimes, inodes, enumeration order, or absolute paths.
function collectDeckSourceEntries(rootDir, dir, entries) {
  let dirents;
  try {
    dirents = fsSync.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    deckSourceFailure(path.relative(rootDir, dir) || ".", `cannot list directory (${error.message})`);
  }
  for (const dirent of dirents) {
    const absPath = path.join(dir, dirent.name);
    const relPath = path.relative(rootDir, absPath).split(path.sep).join("/");
    if (dirent.isSymbolicLink()) {
      deckSourceFailure(relPath, "symlinks are not allowed in a deck source tree because they cannot be hashed deterministically and can escape or cycle; replace the symlink with a real file");
    }
    if (dirent.isDirectory()) {
      collectDeckSourceEntries(rootDir, absPath, entries);
      continue;
    }
    if (!dirent.isFile()) {
      deckSourceFailure(relPath, "unsupported entry type; deck provenance hashes regular files only");
    }
    let bytes;
    try {
      bytes = fsSync.readFileSync(absPath);
    } catch (error) {
      deckSourceFailure(relPath, error.message);
    }
    entries.push({ relPath, bytes });
  }
}

function computeDeckSourceHash(deckDir, manifest) {
  const entries = [];
  collectDeckSourceEntries(deckDir, deckDir, entries);

  // The manifest-declared entry is part of the identity even when it is
  // custom-named; if it resolves outside the deck tree it cannot be covered
  // by the canonical source tree, so fail fast instead of silently omitting
  // the file the plan was actually compiled from.
  const entryContent = manifest?.entry?.content;
  if (typeof entryContent === "string" && entryContent !== "") {
    const entryAbs = path.resolve(deckDir, entryContent);
    const rel = path.relative(deckDir, entryAbs);
    const relPosix = rel.split(path.sep).join("/");
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
      console.error(`[lattice] deck entry "${entryContent}" resolves outside the deck directory; provenance must cover the real entry source.`);
      process.exit(2);
    }
    if (!entries.some((entry) => entry.relPath === relPosix)) {
      console.error(`[lattice] deck entry "${entryContent}" is not a readable regular file in the deck source tree; provenance must cover the real entry source.`);
      process.exit(2);
    }
  }

  entries.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  const hash = createHash("sha256");
  for (const entry of entries) {
    hash.update(entry.relPath);
    hash.update("\0");
    hash.update(entry.bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

async function resolveBundleIdentity({ args, descriptor, deckId, config, deckDir, projectRoot = process.cwd() }) {
  if (args["bundle-dir"]) {
    try {
      const info = validateSlideWebBundle({ bundleDir: args["bundle-dir"], deckId });
      return { ...info, source: `--bundle-dir ${info.bundlePath}` };
    } catch (error) {
      console.error(`[lattice] ${error.message}`);
      process.exit(2);
    }
  }

  if (descriptor.bundleHash !== undefined) {
    const value = descriptor.bundleHash;
    if (typeof value !== "string" || !SHA256_HEX.test(value)) {
      console.error(
        `[lattice] deck "${deckId}" descriptor bundleHash must be a real sha256 hex digest (64 lowercase hex chars), got ${JSON.stringify(value ?? null)}. ` +
        `Derive it from a real Slide Web Bundle instead of writing a placeholder.`,
      );
      process.exit(2);
    }
    return { bundlePath: null, manifest: null, bundleHash: value, source: "videoPlan descriptor bundleHash" };
  }

  // Default: the deck's real static export (lattice export layout).
  const exportBundleDir = path.resolve(projectRoot, config.outDir, "static-decks", deckId);
  if (fsSync.existsSync(exportBundleDir)) {
    try {
      const info = validateSlideWebBundle({ bundleDir: exportBundleDir, deckId });
      return { ...info, source: `static export ${info.bundlePath}` };
    } catch (error) {
      console.error(`[lattice] ${error.message}`);
      process.exit(2);
    }
  }

  console.error(
    `[lattice] no real Slide Web Bundle identity available for deck "${deckId}". ` +
    `Run "lattice export --deck ${deckId}" first, pass --bundle-dir <path> to a real static export, ` +
    `or set a real sha256 bundleHash in the videoPlan descriptor.`,
  );
  process.exit(2);
}

/**
 * Compile the complete VideoPlan for one deck (M3 contract, M7 timeline
 * extension). Exported for the video workbench, which renders through the
 * exact same compile path as the CLI so artifacts share one planHash.
 */
export async function compileDeckVideoPlan({ args, config, projectRoot = process.cwd() }) {
  const deckId = args.deck;
  if (!deckId || typeof deckId !== "string") {
    console.error("[lattice] video plan requires --deck <id>");
    process.exit(2);
  }

  const chosenRouteId = args.route !== undefined ? args.route : "main";

  const deckDir = path.resolve(projectRoot, config.decksDir, deckId);

  const manifestUrl = new URL("manifest.json", `file://${deckDir}/`);
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestUrl.pathname, "utf8"));
  } catch (error) {
    console.error(`[lattice] cannot read deck manifest for "${deckId}": ${error.message}`);
    process.exit(2);
  }

  if (!manifest || (manifest.schema !== "lattice.deck.v1" && manifest.schema !== DECK_SCHEMA_V2)) {
    console.error(`[lattice] deck "${deckId}" uses unsupported schema. Only lattice.deck.v1 and lattice.deck.v2 are supported by the current deck loader.`);
    process.exit(1);
  }

  let descriptor;
  let descriptorOrigin;
  if (manifest.schema === DECK_SCHEMA_V2) {
    // v2 decks are self-describing: routes, fps, and canvas live in the
    // manifest, slide timing in the canonical slide definitions. No content.js
    // videoPlan descriptor is consulted, and nothing is inferred.
    descriptor = await descriptorFromDeckV2({ deckId, deckDir, manifest, projectRoot });
    descriptorOrigin = "lattice.deck.v2 manifest + slide definitions";
  } else {
    let contentMod;
    try {
      const contentPath = new URL(manifest.entry.content, `file://${deckDir}/`).pathname;
      contentMod = await import(contentPath);
    } catch (error) {
      console.error(`[lattice] cannot import content.js for "${deckId}": ${error.message}`);
      process.exit(2);
    }
    const resolved = resolveVideoPlanDescriptor(contentMod, deckId);
    descriptor = resolved.descriptor;
    descriptorOrigin = resolved.origin;
  }

  const { routes: descriptorRoutes, slides: descriptorSlides, resolvedTimeline, fps, width, height, audioTracks, inputProps } =
    await normalizeDescriptor({ descriptor, deckId, manifest });

  // M7 unified timeline: when the deck declares a lattice.timeline.v1 the
  // plan consumes the resolved timing — per-slide segment durations, stop
  // frames, and animation declarations — instead of the static placeholder
  // timing. Decks without a timeline compile the exact v1 plan as before.
  const timelineById = new Map((resolvedTimeline?.slides ?? []).map((entry) => [entry.slideId, entry]));
  const timelineAudioTracks = resolvedTimeline?.audioTracks;

  if (!descriptorRoutes || typeof descriptorRoutes !== "object" || Array.isArray(descriptorRoutes)) {
    console.error("[lattice] videoPlan descriptor must have a 'routes' map (object), e.g. routes: { main: [...] }");
    process.exit(1);
  }

  if (descriptorRoutes[chosenRouteId] === undefined) {
    const available = Object.keys(descriptorRoutes);
    console.error(`[lattice] route "${chosenRouteId}" not found in videoPlan descriptor. Available routes: ${available.length ? available.join(", ") : "(none)"}`);
    process.exit(2);
  }

  const routeArray = descriptorRoutes[chosenRouteId];
  if (!Array.isArray(routeArray) || routeArray.length === 0) {
    console.error(`[lattice] route "${chosenRouteId}" must be a non-empty array of slide ids`);
    process.exit(1);
  }

  if (!descriptorSlides || !Array.isArray(descriptorSlides) || descriptorSlides.length === 0) {
    console.error("[lattice] videoPlan descriptor must have a non-empty slides array");
    process.exit(1);
  }

  for (const s of descriptorSlides) {
    if (!s || typeof s !== "object") {
      console.error("[lattice] videoPlan descriptor slides must be objects");
      process.exit(1);
    }
    if (typeof s.id !== "string" || s.id === "") {
      console.error("[lattice] videoPlan descriptor slides must have string ids");
      process.exit(1);
    }
    if (typeof s.durationFrames !== "number" || !Number.isInteger(s.durationFrames) || s.durationFrames <= 0) {
      console.error(`[lattice] videoPlan descriptor slide "${s.id}" must have a positive integer durationFrames, got ${s.durationFrames}`);
      process.exit(1);
    }
  }

  const planResult = compileVideoPlan({
    deckId,
    routeId: chosenRouteId,
    routes: descriptorRoutes,
    slides: descriptorSlides.map((s) => {
      const entry = timelineById.get(s.id);
      const compiled = {
        id: s.id,
        durationFrames: entry?.durationFrames ?? s.durationFrames,
        inputProps: s.inputProps ?? {},
      };
      if (entry) {
        compiled.stops = entry.stops.map((stop) => ({ id: stop.id, frame: stop.frame }));
        if (entry.animation) compiled.animation = entry.animation;
      }
      return compiled;
    }),
    width: width ?? 960,
    height: height ?? 540,
    fps: fps ?? 30,
    audioTracks: timelineAudioTracks ?? audioTracks ?? [],
    inputProps: inputProps ?? {},
  });

  if (!planResult.ok) {
    console.error(`[lattice] ${planResult.reason}`);
    process.exit(1);
  }

  // Provenance from real inputs only — no placeholder strings.
  const deckHash = computeDeckSourceHash(deckDir, manifest);
  const bundleIdentity = await resolveBundleIdentity({ args, descriptor, deckId, config, deckDir, projectRoot });

  const inputPropsIdentity = {
    global: descriptor.inputProps ?? {},
    clips: planResult.plan.clips.map((clip) => ({
      slideId: clip.slideId,
      inputProps: clip.inputProps,
    })),
  };
  const inputPropsHash = createHash("sha256")
    .update(serializeVideoPlan(inputPropsIdentity), "utf8")
    .digest("hex");

  let completePlan;
  try {
    completePlan = bakeVideoPlanProvenance(planResult.plan, {
      deckHash,
      bundleHash: bundleIdentity.bundleHash,
      inputPropsHash,
    });
  } catch (error) {
    console.error(`[lattice] ${error.message}`);
    process.exit(2);
  }
  completePlan.provenance.toolchain = {
    node: process.version,
    "lattice-runtime": RUNTIME_VERSION,
  };
  // M10: when the plan consumes a declared narration track, record the exact
  // TTS engine identity in provenance (deterministic reproduction contract).
  // V2.0.25: the engine field selects the toolchain identity — kokoro
  // (default, unchanged keys for existing decks) or piper (zh path).
  const narrationDeclaration = resolvedTimeline?.audio?.narration;
  if (narrationDeclaration?.voice) {
    if (narrationDeclaration.engine === "piper") {
      const { PIPER_RELEASE } = await import("../audio/piper.js");
      completePlan.provenance.toolchain["piper"] = PIPER_RELEASE;
      completePlan.provenance.toolchain["piper-voice"] = narrationDeclaration.voice;
      if (narrationDeclaration.speed !== undefined) {
        completePlan.provenance.toolchain["piper-speed"] = String(narrationDeclaration.speed);
      }
    } else {
      const { KOKORO_MODEL_ID, kokoroVersion } = await import("../audio/kokoro.js");
      completePlan.provenance.toolchain["kokoro-js"] = kokoroVersion();
      completePlan.provenance.toolchain["kokoro-model"] = KOKORO_MODEL_ID;
      completePlan.provenance.toolchain["kokoro-voice"] = narrationDeclaration.voice;
      if (narrationDeclaration.speed !== undefined) {
        completePlan.provenance.toolchain["kokoro-speed"] = String(narrationDeclaration.speed);
      }
    }
  }

  const finalValidation = validateVideoPlan(completePlan);
  if (!finalValidation.ok) {
    console.error(`[lattice] compiled plan is invalid: ${finalValidation.errors.join("; ")}`);
    process.exit(1);
  }

  return {
    completePlan,
    planHash: hashVideoPlan(completePlan),
    deckDir,
    deckHash,
    bundleIdentity,
    descriptorOrigin,
    routeId: chosenRouteId,
  };
}

/**
 * M7 1b — machine-readable preset catalog: the theme's named stop-reveal
 * animation presets with their parameter schema and defaults. Agents select
 * presets and parameters from this catalog; "lattice edit --timeline"
 * validates values against the same catalog before anything is written, so
 * an illegal preset or parameter is refused at edit time.
 */
async function handleVideoPresets() {
  const catalog = await loadStopRevealPresetCatalog();
  process.stdout.write(`${JSON.stringify(catalog, null, 2)}\n`);
}

async function handleVideoPlan({ args }) {
  const config = await loadConfig();
  const {
    completePlan,
    planHash,
    deckHash,
    bundleIdentity,
    descriptorOrigin,
  } = await compileDeckVideoPlan({ args, config });

  const output = serializeVideoPlan(completePlan);

  if (args.output) {
    const outPath = path.resolve(args.output);
    await fs.mkdir(path.dirname(outPath), { recursive: true });
    await fs.writeFile(outPath, output, "utf8");
    console.log(`VideoPlan written to ${outPath}`);
    console.log(`  plan-hash: ${planHash}`);
    console.log(`  deck-hash: ${deckHash}`);
    console.log(`  bundle-hash: ${bundleIdentity.bundleHash} (${bundleIdentity.source})`);
    console.log(`  input-props-hash: ${completePlan.provenance.inputPropsHash}`);
    console.log(`  totalFrames: ${completePlan.totalFrames}`);
    console.log(`  fps: ${completePlan.fps}`);
    console.log(`  clips: ${completePlan.clips.length}`);
    console.log(`  descriptor: ${descriptorOrigin}`);
  } else {
    process.stdout.write(output + "\n");
  }
}

async function resolveBackendForRender({ args }) {
  const backendId = args.backend;
  if (!backendId) {
    console.error("[lattice] video still/render requires --backend remotion|hyperframes");
    process.exit(2);
  }

  const { ensureBackendsInitialized, getBackend } = await import("../video/registry.js");
  ensureBackendsInitialized();

  try {
    return getBackend(backendId);
  } catch (error) {
    console.error(`[lattice] ${error.message}`);
    process.exit(2);
  }
}

/**
 * A backend render may only place artifacts outside the canonical deck
 * source: outputs inside the deck source tree or the Slide Web Bundle are
 * rejected instead of mutating canonical identity-bearing inputs.
 */
function assertSafeRenderOutput({ output, deckDir, bundleDir }) {
  const resolved = path.resolve(output);
  for (const [label, root] of [["deck source", deckDir], ["Slide Web Bundle", bundleDir]]) {
    if (!root) continue;
    const rel = path.relative(path.resolve(root), resolved);
    if (rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel)) {
      console.error(`[lattice] video output must not be written into the canonical ${label} at ${root}: ${resolved}`);
      process.exit(2);
    }
  }
  return resolved;
}

async function prepareRenderForDeck({ args }) {
  const config = await loadConfig();
  const backend = await resolveBackendForRender({ args });
  const { completePlan, planHash, deckDir, bundleIdentity } = await compileDeckVideoPlan({ args, config });

  if (!bundleIdentity.bundlePath) {
    console.error(
      `[lattice] video still/render requires a real Slide Web Bundle directory. ` +
      `Run "lattice export --deck ${args.deck}" first or pass --bundle-dir <path>; ` +
      `a descriptor bundleHash alone cannot be rendered.`,
    );
    process.exit(2);
  }

  const projectRoot = process.cwd();
  const workDir = path.resolve(projectRoot, ".lattice", "generated", backend.id);

  let prepared;
  try {
    prepared = await backend.prepare({
      plan: completePlan,
      bundleDir: bundleIdentity.bundlePath,
      workDir,
      projectRoot,
    });
  } catch (error) {
    console.error(`[lattice] backend prepare failed: ${error.message}`);
    if (Array.isArray(error.diagnostics)) {
      for (const diag of error.diagnostics) {
        console.error(`  [${diag.level ?? "error"}] ${diag.message ?? String(diag)}`);
      }
    }
    process.exit(2);
  }

  return { backend, prepared, planHash, totalFrames: completePlan.totalFrames, deckDir, bundleDir: bundleIdentity.bundlePath };
}

/**
 * Issue 011 — `--frames <comma-separated integers>` renders N stills of one
 * plan through ONE warm browser session (backend.renderStills): plan compile,
 * host prepare, bundle, and browser boot happen once instead of once per
 * still. Outputs are written into the --output directory (default
 * `<generated>/<backend>/batch-stills`) as `frame-00000.png`. The single
 * `--frame` path below keeps its exact pre-batch behavior.
 */
function parseStillFramesArgument(args) {
  if (args.frame !== undefined && args.frames !== undefined) {
    console.error("[lattice] video still accepts either --frame <n> or --frames <list>, not both");
    process.exit(2);
  }
  if (args.frames === undefined) return null;
  if (typeof args.frames !== "string" || args.frames.trim() === "") {
    console.error("[lattice] video still --frames requires a comma-separated list of non-negative integers, e.g. --frames 0,20,36");
    process.exit(2);
  }
  const parts = args.frames.split(",").map((part) => part.trim());
  if (parts.some((part) => !/^\d+$/.test(part))) {
    console.error(`[lattice] video still --frames got an invalid entry in ${JSON.stringify(args.frames)}: every item must be a non-negative integer`);
    process.exit(2);
  }
  const frames = [...new Set(parts.map((part) => Number(part)))].sort((a, b) => a - b);
  if (frames.length === 0) {
    console.error("[lattice] video still --frames requires at least one frame");
    process.exit(2);
  }
  return frames;
}

async function handleVideoStillBatch({ args, frames }) {
  const { backend, prepared, totalFrames, deckDir, bundleDir } = await prepareRenderForDeck({ args });

  const outOfRange = frames.filter((frame) => frame >= totalFrames);
  if (outOfRange.length > 0) {
    console.error(`[lattice] frames [${outOfRange.join(", ")}] are outside the plan range [0, ${totalFrames - 1}] (totalFrames ${totalFrames})`);
    process.exit(2);
  }

  const outputDir = assertSafeRenderOutput({
    output: args.output ?? path.join(prepared.workDir, "batch-stills"),
    deckDir,
    bundleDir,
  });
  await fs.mkdir(outputDir, { recursive: true });

  const requests = frames.map((frame) => ({
    frame,
    output: path.join(outputDir, `frame-${String(frame).padStart(5, "0")}.png`),
  }));

  let artifacts;
  try {
    artifacts = await backend.renderStills({ prepared, requests });
  } catch (error) {
    console.error(`[lattice] video still batch failed: ${error.message}`);
    if (Array.isArray(error.diagnostics)) {
      for (const diag of error.diagnostics) {
        console.error(`  [${diag.level ?? "error"}] ${diag.message ?? String(diag)}`);
      }
    }
    process.exit(2);
  }

  console.log(`Batch stills written to ${outputDir}`);
  console.log(`  frames: ${frames.join(",")} / ${totalFrames - 1} max (plan ${prepared.planHash.slice(0, 12)})`);
  for (const artifact of artifacts) {
    console.log(`  ${path.basename(artifact.path)}: ${artifact.metadata.width}x${artifact.metadata.height} (format ${artifact.metadata.format}, codec ${artifact.metadata.codec})`);
  }
}

async function handleVideoStill({ args }) {
  const batchFrames = parseStillFramesArgument(args);
  if (batchFrames !== null) {
    await handleVideoStillBatch({ args, frames: batchFrames });
    return;
  }

  const frame = typeof args.frame === "string" && args.frame.trim() !== "" ? Number(args.frame) : args.frame;
  if (!Number.isInteger(frame) || frame < 0) {
    console.error("[lattice] video still requires --frame <non-negative integer>");
    process.exit(2);
  }

  const { backend, prepared, totalFrames, deckDir, bundleDir } = await prepareRenderForDeck({ args });
  if (frame >= totalFrames) {
    console.error(`[lattice] frame ${frame} is outside the plan range [0, ${totalFrames - 1}] (totalFrames ${totalFrames})`);
    process.exit(2);
  }

  const output = assertSafeRenderOutput({
    output: args.output ?? path.join(prepared.workDir, `still-frame-${frame}.png`),
    deckDir,
    bundleDir,
  });
  await fs.mkdir(path.dirname(output), { recursive: true });

  let artifact;
  try {
    artifact = await backend.renderStill({ prepared, frame, output });
  } catch (error) {
    console.error(`[lattice] video still failed: ${error.message}`);
    if (Array.isArray(error.diagnostics)) {
      for (const diag of error.diagnostics) {
        console.error(`  [${diag.level ?? "error"}] ${diag.message ?? String(diag)}`);
      }
    }
    process.exit(2);
  }

  console.log(`Still written to ${artifact.path}`);
  console.log(`  frame: ${artifact.frame} / ${totalFrames - 1} (plan ${artifact.planHash.slice(0, 12)})`);
  console.log(`  dimensions: ${artifact.metadata.width}x${artifact.metadata.height}`);
  console.log(`  format: ${artifact.metadata.format} (codec ${artifact.metadata.codec})`);
}

async function handleVideoRender({ args }) {
  const { backend, prepared, totalFrames, deckDir, bundleDir } = await prepareRenderForDeck({ args });

  const output = assertSafeRenderOutput({
    output: args.output ?? path.join(prepared.workDir, "video.mp4"),
    deckDir,
    bundleDir,
  });
  await fs.mkdir(path.dirname(output), { recursive: true });

  let artifact;
  try {
    artifact = await backend.renderVideo({ prepared, output });
  } catch (error) {
    console.error(`[lattice] video render failed: ${error.message}`);
    if (Array.isArray(error.diagnostics)) {
      for (const diag of error.diagnostics) {
        console.error(`  [${diag.level ?? "error"}] ${diag.message ?? String(diag)}`);
      }
    }
    process.exit(2);
  }

  const { metadata } = artifact;
  console.log(`Video written to ${artifact.path}`);
  console.log(`  plan ${artifact.planHash.slice(0, 12)}: ${totalFrames} frames @ ${metadata.fps} fps`);
  console.log(`  dimensions: ${metadata.width}x${metadata.height}`);
  console.log(`  duration: ${metadata.durationSeconds}s, codec: ${metadata.codec}, format: ${metadata.format}`);
}

async function handleVideoDoctor({ args }) {
  const backendId = args.backend;
  if (!backendId) {
    console.error("[lattice] video doctor requires --backend remotion|hyperframes");
    process.exit(2);
  }

  // Backends are initialized lazily and only for doctor: "video plan" must
  // never initialize or probe a video backend.
  const { ensureBackendsInitialized, getBackend } = await import("../video/registry.js");
  ensureBackendsInitialized();

  let backend;
  try {
    backend = getBackend(backendId);
  } catch (error) {
    console.error(`[lattice] ${error.message}`);
    process.exit(2);
  }

  console.log(`Backend: ${backend.id}`);
  console.log();

  const report = await backend.doctor();

  for (const diag of report.diagnostics) {
    const prefix = diag.level === "error" ? "✗" : diag.level === "warn" ? "⚠" : "✓";
    console.log(`  ${prefix} ${diag.message}`);
  }

  console.log();
  console.log(`Status: ${report.status} (${report.missingCount}/${report.totalCount} issues)`);
  console.log();

  if (report.installInstructions) {
    console.log("Installation guidance:");
    for (const [key, value] of Object.entries(report.installInstructions)) {
      console.log(`  ${key}: ${value}`);
    }
  }

  process.exit(report.exitCode);
}
