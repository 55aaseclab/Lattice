import { execFile } from "node:child_process";
import fsSync from "node:fs";
import { ArtifactMetadata, VideoBackendError } from "../backend-contract.js";

const REMOTION_BACKEND_ID = "remotion";

function probeError(message, cause = "probe-failed", diagnostics = []) {
  return new VideoBackendError(message, { backendId: REMOTION_BACKEND_ID, diagnostics, cause });
}

function runFfprobe(ffprobePath, args, { timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(ffprobePath, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(probeError(
          `ffprobe failed for ${args[args.length - 1]}: ${error.message}${stderr ? ` — ${stderr.trim()}` : ""}`,
        ));
        return;
      }
      resolve(stdout);
    });
  });
}

function parseRational(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const match = value.match(/^(-?\d+(?:\.\d+)?)\/(-?\d+(?:\.\d+)?)$/);
  if (match) {
    const denominator = Number(match[2]);
    if (denominator === 0) return null;
    return Number(match[1]) / denominator;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function parseFrameCount(value) {
  if (typeof value !== "string" || value === "" || value === "N/A") return null;
  const numeric = Number(value);
  return Number.isInteger(numeric) && numeric >= 0 ? numeric : null;
}

function resolveFormatLabel(formatName, codecName) {
  const names = typeof formatName === "string" ? formatName.split(",") : [];
  if (names.includes("mp4")) return "mp4";
  if (names.includes("png_pipe") || codecName === "png") return "png";
  return names[0] ?? codecName ?? null;
}

async function countFramesByDecoding(ffprobePath, artifactPath) {
  const stdout = await runFfprobe(ffprobePath, [
    "-v", "error",
    "-count_frames",
    "-select_streams", "v:0",
    "-show_entries", "stream=nb_read_frames",
    "-print_format", "json",
    artifactPath,
  ]);
  const parsed = JSON.parse(stdout);
  const stream = parsed?.streams?.[0];
  return parseFrameCount(stream?.nb_read_frames);
}

/**
 * Artifact probe: one ffprobe invocation describing a rendered still or video
 * as ArtifactMetadata. Frame counts rely on the container when present and
 * otherwise fall back to a real decode count — never to guesses from bitrate
 * or duration.
 */
export async function probeArtifactWithFfprobe({ ffprobePath, artifactPath }) {
  let stat = null;
  try {
    stat = await fsSync.promises.stat(artifactPath);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isFile()) {
    throw probeError(`artifact to inspect does not exist or is not a regular file: ${artifactPath}`, "artifact-missing");
  }

  let stdout;
  try {
    stdout = await runFfprobe(ffprobePath, [
      "-v", "error",
      "-print_format", "json",
      "-show_format",
      "-show_streams",
      artifactPath,
    ]);
  } catch (error) {
    error.cause = "probe-failed";
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw probeError(`ffprobe produced unparseable output for ${artifactPath}: ${error.message}`);
  }

  const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
  const videoStream = streams.find((stream) =>
    stream?.codec_type === "video" && stream?.disposition?.attached_pic !== 1,
  );
  if (!videoStream) {
    throw probeError(`no video stream found in ${artifactPath}; ffprobe cannot describe it as a video artifact`);
  }

  const fps = parseRational(videoStream.avg_frame_rate) ?? parseRational(videoStream.r_frame_rate);
  const codec = typeof videoStream.codec_name === "string" ? videoStream.codec_name : null;
  const formatLabel = resolveFormatLabel(parsed?.format?.format_name, codec);
  const isImage = formatLabel === "png" || codec === "png" || formatLabel === "jpeg" || codec === "mjpeg";

  let totalFrames = parseFrameCount(videoStream.nb_frames);
  if (totalFrames === null) {
    if (isImage) {
      totalFrames = 1;
    } else {
      totalFrames = await countFramesByDecoding(ffprobePath, artifactPath);
    }
  }

  const durationRaw = parseRational(videoStream.duration) ?? parseRational(parsed?.format?.duration);
  const durationSeconds = durationRaw === null ? null : Math.round(durationRaw * 1000) / 1000;

  return new ArtifactMetadata({
    width: Number.isInteger(videoStream.width) ? videoStream.width : null,
    height: Number.isInteger(videoStream.height) ? videoStream.height : null,
    fps: fps === null ? null : Math.round(fps * 1000) / 1000,
    totalFrames,
    durationSeconds,
    codec,
    format: formatLabel,
  });
}

/**
 * Resolve a runnable ffprobe executable. The probe is a required tool: a
 * missing ffprobe is a diagnostic error with install guidance, never a
 * skipped verification.
 */
export async function resolveFfprobeExecutable() {
  const { checkCommand } = await import("../diagnostics.js");
  const check = await checkCommand("ffprobe", ["-version"]);
  if (!check.ok) {
    throw probeError(
      "ffprobe is required to inspect rendered artifacts but was not found. Install ffmpeg/ffprobe (e.g. apt-get install ffmpeg) or add it to PATH.",
      "missing-ffprobe",
      [],
    );
  }
  return { ffprobePath: "ffprobe", version: check.version };
}
