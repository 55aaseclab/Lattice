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
