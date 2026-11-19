// M7 audioTracks → single MP4 audio track; M10 mixer v2 adds narration
// side-chain ducking. Both video backends render video only; plans that
// declare audioTracks get them mixed in after the base render through the
// exact same ffmpeg graph, so the two backends produce audio-identical
// artifacts for the same plan. Silence is the unchanged default path: no
// audioTracks, no ffmpeg post-process.
//
// v2 contract: a plan whose audioTracks carry a `narration` track is mixed
// with every OTHER track side-chain ducked by the narration signal
// (sidechaincompress). The stitched narration.wav is silent between speech
// segments and frame-aligned, so the ducking lands exactly on the narration
// windows and recovers between segments. Plans without a narration track go
// through the byte-identical v1 flat graph (pinned by test).

import { execFile } from "node:child_process";
import fsSync from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { VideoBackendError } from "./backend-contract.js";

export const NARRATION_TRACK_ID = "narration";

// Speech sits around −23 dBFS RMS (peaks ≈ −5 dBFS): a −30 dBFS threshold
// with ratio 20 ducks the bed hard while the narrator speaks and lets it
// recover fully (gain 1) when the side chain is silent. Attack/release are
// tuned for speech cadence at 30 fps timelines.
const DUCKING_PARAMETERS = "threshold=0.03:ratio=20:attack=20:release=420:makeup=1";

function mixError(backendId, message, cause = "audio-mix-failed") {
  return new VideoBackendError(message, { backendId, diagnostics: [], cause });
}

function run(command, args, { timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const detail = `${error.message}${stderr ? `\n${stderr.slice(-4000)}` : ""}`;
        reject(new Error(detail));
        return;
      }
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}

/**
 * Resolve a plan audio track source against the Slide Web Bundle. Track src
 * paths are bundle-relative (deck assets are exported into the bundle's
 * assets/ directory), so an exported deck carries its own audio.
 */
export function resolveAudioTrackPaths({ tracks, bundleDir, backendId }) {
  return tracks.map((track) => {
    const relative = String(track.src).replace(/^\.\//, "");
    const resolved = path.resolve(bundleDir, relative);
    if (!resolved.startsWith(path.resolve(bundleDir) + path.sep)) {
      throw mixError(backendId, `audioTracks[${track.id}].src "${track.src}" resolves outside the Slide Web Bundle; deck audio must live in the deck's assets`, "audio-path-outside-bundle");
    }
    if (!fsSync.existsSync(resolved) || !fsSync.statSync(resolved).isFile()) {
      throw mixError(
        backendId,
        `audio track "${track.id}" source is missing at ${resolved}. Put the file in the deck's assets directory (it is exported into the Slide Web Bundle) and re-run "lattice export --deck <id>".`,
        "audio-source-missing",
      );
    }
    return { track, sourcePath: resolved };
  });
}

/**
 * The prepared render persists the canonical plan at prepare time
 * (`<workDir>/video-plan.json`); renderVideo reads the audioTracks from it so
 * the mix consumes exactly the plan the host was generated from.
 */
export async function readPlanFromWorkDir({ workDir, backendId }) {
  const planPath = path.join(workDir, "video-plan.json");
  let raw;
  try {
    raw = await fsp.readFile(planPath, "utf8");
  } catch {
    throw mixError(backendId, `prepared render has no canonical plan at ${planPath}; run backend prepare first`, "missing-plan");
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw mixError(backendId, `prepared plan at ${planPath} is not valid JSON: ${error.message}`, "invalid-plan");
  }
}

function trackChain(track, fps) {
  const chain = [];
  if (track.durationFrames !== undefined) {
    const start = track.startFrame / fps;
    const end = (track.startFrame + track.durationFrames) / fps;
    chain.push(`atrim=start=${start.toFixed(6)}:end=${end.toFixed(6)}`, "asetpts=PTS-STARTPTS");
  }
  const delayMs = Math.round((track.startFrame / fps) * 1000);
  chain.push(`adelay=delays=${delayMs}:all=1`);
  const volume = track.volume ?? 1;
  chain.push(`volume=${volume}`);
  return chain;
}

/**
 * Build the ffmpeg filter_complex for one resolved track list.
 *
 * - mode "flat": the exact M7 graph (one chain per track → amix). Pinned
 *   byte-for-byte by test; plans without narration MUST produce the same
 *   string as the pre-M10 mixer.
 * - mode "ducked": the narration track is split (asplit) into one mix copy
 *   plus one side-chain copy per other track; each other track runs through
 *   sidechaincompress keyed on the narration signal before the amix.
 *
 * Exported for the mixer tests (graph purity + ducking assertions); the mix
 * itself consumes it through mixPlanAudioIntoVideo.
 */
export function buildAudioMixFilterParts({ resolved, fps }) {
  const narrationIndex = resolved.findIndex(({ track }) => track?.id === NARRATION_TRACK_ID);
  if (narrationIndex === -1 || resolved.length === 1) {
    const filterParts = [];
    const mixLabels = [];
    resolved.forEach(({ track }, index) => {
      const label = `a${index}`;
      filterParts.push(`[${index + 1}:a]${trackChain(track, fps).join(",")}[${label}]`);
      mixLabels.push(`[${label}]`);
    });
    filterParts.push(`${mixLabels.join("")}amix=inputs=${resolved.length}:duration=longest:normalize=0[aout]`);
    return { mode: "flat", narrationTrackId: null, filterParts };
  }

  const others = resolved
    .map((entry, index) => ({ ...entry, index }))
    .filter(({ index }) => index !== narrationIndex);
  const narrationLabel = `a${narrationIndex}`;
  const filterParts = [];
  filterParts.push(`[${narrationIndex + 1}:a]${trackChain(resolved[narrationIndex].track, fps).join(",")}[${narrationLabel}]`);
  const splitLabels = [...others.map((_, sidechainIndex) => `[sc${sidechainIndex}]`), "[narrMix]"];
  filterParts.push(`[${narrationLabel}]asplit=${splitLabels.length}${splitLabels.join("")}`);
  const mixLabels = ["[narrMix]"];
  others.forEach(({ track, index }, sidechainIndex) => {
    const bedLabel = `a${index}`;
    filterParts.push(`[${index + 1}:a]${trackChain(track, fps).join(",")}[${bedLabel}]`);
    filterParts.push(`[${bedLabel}][sc${sidechainIndex}]sidechaincompress=${DUCKING_PARAMETERS}[duck${sidechainIndex}]`);
    mixLabels.push(`[duck${sidechainIndex}]`);
  });
  filterParts.push(`${mixLabels.join("")}amix=inputs=${resolved.length}:duration=longest:normalize=0[aout]`);
  return { mode: "ducked", narrationTrackId: NARRATION_TRACK_ID, filterParts };
}

/**
 * Mix the plan's audioTracks into the rendered MP4 as one AAC track:
 *   - startFrame  → adelay (all channels) of startFrame / fps seconds,
 *   - durationFrames (optional) → atrim of the source window,
 *   - volume (optional, default 1) → volume filter,
 *   - amix (normalize=0) of every track → single aac stream.
 * Plans whose audioTracks carry a narration track duck every other track
 * against the narration signal (mixer v2). The video stream is stream-copied;
 * the container is clamped to the video duration so the artifact keeps the
 * exact plan frame count.
 */
export async function mixPlanAudioIntoVideo({ plan, bundleDir, videoPath, backendId }) {
  const tracks = Array.isArray(plan?.audioTracks) ? plan.audioTracks : [];
  if (tracks.length === 0) {
    return { mixed: false, audioStreams: 0 };
  }
  const fps = plan.fps;
  const totalSeconds = plan.totalFrames / fps;

  const resolved = resolveAudioTrackPaths({ tracks, bundleDir, backendId });
  const { mode, narrationTrackId, filterParts } = buildAudioMixFilterParts({ resolved, fps });

  const args = ["-y", "-i", videoPath];
  resolved.forEach(({ sourcePath }) => {
    args.push("-i", sourcePath);
  });

  const tempOutput = `${videoPath}.audio-mix.mp4`;
  try {
    await run("ffmpeg", [
      ...args,
      "-filter_complex", filterParts.join(";"),
      "-map", "0:v", "-c:v", "copy",
      "-map", "[aout]", "-c:a", "aac", "-b:a", "192k",
      "-t", totalSeconds.toFixed(6),
      tempOutput,
    ]);
    const probe = await run("ffprobe", [
      "-v", "error", "-print_format", "json", "-show_streams", tempOutput,
    ]);
    const parsed = JSON.parse(probe.stdout);
    const audioStreams = (parsed?.streams ?? []).filter((stream) => stream?.codec_type === "audio");
    const videoStreams = (parsed?.streams ?? []).filter((stream) => stream?.codec_type === "video");
    if (audioStreams.length !== 1) {
      throw mixError(backendId, `audio mix produced ${audioStreams.length} audio streams, expected exactly 1`);
    }
    if (videoStreams.length !== 1) {
      throw mixError(backendId, `audio mix produced ${videoStreams.length} video streams, expected exactly 1`);
    }
    await fsp.rename(tempOutput, videoPath);
    return {
      mixed: true,
      audioStreams: 1,
      codec: audioStreams[0]?.codec_name ?? "aac",
      ducking: mode === "ducked",
      narrationTrackId,
      tracks: tracks.map((track) => ({ id: track.id, startFrame: track.startFrame, volume: track.volume ?? 1 })),
    };
  } catch (error) {
    await fsp.rm(tempOutput, { force: true }).catch(() => {});
    if (error instanceof VideoBackendError) throw error;
    throw mixError(backendId, `ffmpeg audio mix failed for ${videoPath}: ${error.message}`);
  }
}
