export class BackendDiagnostic {
  constructor({ level, message, details = {} }) {
    this.level = level;
    this.message = message;
    this.details = details;
  }
}

export class PreparedRender {
  constructor({ backendId, planHash, workDir, bundlePath = null, bundleHash = null }) {
    this.backendId = backendId;
    this.planHash = planHash;
    this.workDir = workDir;
    this.bundlePath = bundlePath;
    this.bundleHash = bundleHash;
  }
}

export class RenderArtifact {
  constructor({ path, backendId, planHash, frame = null, metadata = {} }) {
    this.path = path;
    this.backendId = backendId;
    this.planHash = planHash;
    this.frame = frame;
    this.metadata = metadata;
  }
}

export class ArtifactMetadata {
  constructor({ width, height, fps, totalFrames, durationSeconds, codec, format }) {
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.totalFrames = totalFrames;
    this.durationSeconds = durationSeconds;
    this.codec = codec;
    this.format = format;
  }
}

export function validateBackendId(id) {
  if (id !== "remotion" && id !== "hyperframes") {
    return {
      ok: false,
      reason: `unknown backend id: ${id}. Supported: remotion, hyperframes`,
    };
  }
  return { ok: true };
}

export class VideoBackendError extends Error {
  constructor(message, { backendId, diagnostics = [], cause = null } = {}) {
    super(message);
    this.name = "VideoBackendError";
    this.backendId = backendId;
    this.diagnostics = diagnostics;
    this.cause = cause;
  }
}

/**
 * Issue 011 — batch stills contract. A multi-still flow (parity gates, the
 * audience pack's stills stage, `video still --frames`) renders N frames of
 * one prepared plan through ONE browser session instead of booting Chromium
 * per still. Each backend implements `renderStills({ prepared, requests })`
 * where requests are `{ frame, output }` pairs; the return value is an array
 * of RenderArtifact in the same order as the requests. Single-still
 * `renderStill` keeps its exact behavior; the batch path is additive.
 *
 * Validation is shared so both backends reject the same malformed input with
 * the same typed causes.
 */
export function normalizeStillRequests(requests, { backendId }) {
  if (!Array.isArray(requests) || requests.length === 0) {
    throw new VideoBackendError(
      "renderStills requires a non-empty requests array of { frame, output } pairs",
      { backendId, diagnostics: [], cause: "invalid-prepared" },
    );
  }
  return requests.map((request, index) => {
    const frame = request?.frame;
    const output = request?.output;
    if (!Number.isInteger(frame) || frame < 0) {
      throw new VideoBackendError(
        `renderStills request ${index} requires a non-negative integer frame, got ${String(frame)}`,
        { backendId, diagnostics: [], cause: "invalid-frame" },
      );
    }
    if (typeof output !== "string" || output === "") {
      throw new VideoBackendError(
        `renderStills request ${index} (frame ${frame}) requires a non-empty output path`,
        { backendId, diagnostics: [], cause: "invalid-output" },
      );
    }
    return { frame, output: String(output) };
  });
}

