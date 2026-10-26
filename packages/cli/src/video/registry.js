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
