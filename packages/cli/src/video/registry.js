import { validateBackendId, VideoBackendError } from "./backend-contract.js";
import { createRemotionBackend } from "./remotion/adapter.js";
import { createHyperFramesBackend } from "./hyperframes/adapter.js";

const registry = new Map();

export function registerBackend(factory) {
  const backend = factory();
  if (registry.has(backend.id)) {
    throw new VideoBackendError(`backend already registered: ${backend.id}`, { backendId: backend.id });
  }
  registry.set(backend.id, backend);
}

export function getBackend(id) {
  const validation = validateBackendId(id);
  if (!validation.ok) {
    throw new VideoBackendError(validation.reason, { backendId: id });
  }
  const backend = registry.get(id);
  if (!backend) {
    throw new VideoBackendError(
      `backend "${id}" is not registered`,
      { backendId: id },
    );
  }
  return backend;
}

export function listBackendIds() {
  return [...registry.keys()];
}

export function hasBackend(id) {
  return registry.has(id);
}

let initialized = false;

export function ensureBackendsInitialized() {
  if (initialized) return;
  initialized = true;

  registerBackend(createRemotionBackend);
  registerBackend(createHyperFramesBackend);
}

export async function requireAvailableBackend(id) {
  ensureBackendsInitialized();
  const backend = getBackend(id);
  const report = await backend.doctor();
  if (report.status !== "available") {
    const error = new VideoBackendError(`Video backend "${id}" is unavailable in this environment.`, {
      backendId: id,
      diagnostics: report.diagnostics,
      cause: "runtime-unavailable",
    });
    error.code = "VIDEO_BACKEND_UNAVAILABLE";
    error.status = 503;
    throw error;
  }
  return backend;
}
