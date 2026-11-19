import fsSync from "node:fs";
import path from "node:path";
import { VideoBackendError } from "./backend-contract.js";

function generatedPathError(backendId, message, cause = "path-escape") {
  return new VideoBackendError(message, { backendId, diagnostics: [], cause });
}

/**
 * Single shared resolver for backend-generated work directories.
 *
 * Contract:
 * - projectRoot must exist; its realpath is the containment root.
 * - workDir must lexically be exactly `.lattice/generated/<backendId>` under
 *   the project root (no traversal, no sibling backend directories).
 * - workDir is resolved through the nearest existing ancestor's realpath, so
 *   a symlinked ancestor that escapes the project root is rejected even when
 *   the final workDir does not exist yet.
 *
 * Returns the realpath-accurate absolute work directory.
 */
export function resolveGeneratedWorkDir({ workDir, backendId, projectRoot }) {
  if (!projectRoot || typeof projectRoot !== "string") {
    throw new VideoBackendError(
      "projectRoot is required for generated path resolution",
      { backendId, diagnostics: [], cause: "missing-project-root" },
    );
  }
  if (!workDir || typeof workDir !== "string") {
    throw generatedPathError(backendId, "workDir must be a non-empty string");
  }

  let realRoot;
  try {
    realRoot = fsSync.realpathSync(path.resolve(projectRoot));
  } catch {
    throw new VideoBackendError(
      `projectRoot does not exist: ${projectRoot}`,
      { backendId, diagnostics: [], cause: "missing-project-root" },
    );
  }

  const resolved = path.resolve(workDir);
  const rel = path.relative(realRoot, resolved);
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) {
    throw generatedPathError(
      backendId,
      `generated path must be under project root ${realRoot}, got ${resolved}`,
    );
  }

  const expectedRel = path.join(".lattice", "generated", backendId);
  if (path.normalize(rel) !== expectedRel) {
    throw generatedPathError(
      backendId,
      `workDir must be exactly .lattice/generated/${backendId} under the project root, got ${resolved}`,
    );
  }

  // Walk up to the nearest existing ancestor and rebuild the real path of
  // workDir through it. This catches symlink ancestors even when the final
  // directory has not been created yet.
  let nearest = resolved;
  const missing = [];
  for (;;) {
    let stat = null;
    try {
      stat = fsSync.statSync(nearest);
    } catch {
      stat = null;
    }
    if (stat) {
      if (!stat.isDirectory()) {
        throw generatedPathError(
          backendId,
          `generated work path component is not a directory: ${nearest}`,
        );
      }
      break;
    }
    const parent = path.dirname(nearest);
    if (parent === nearest) {
      throw generatedPathError(
        backendId,
        `cannot resolve generated work directory: ${workDir}`,
      );
    }
    missing.unshift(path.basename(nearest));
    nearest = parent;
  }

  let realNearest;
  try {
    realNearest = fsSync.realpathSync(nearest);
  } catch {
    throw generatedPathError(
      backendId,
      `cannot resolve generated work directory ancestor: ${nearest}`,
    );
  }

  const realWorkDir = missing.length ? path.join(realNearest, ...missing) : realNearest;
  const expectedReal = path.join(realRoot, ".lattice", "generated", backendId);
  if (realWorkDir !== expectedReal) {
    throw generatedPathError(
      backendId,
      `generated path escapes the project root through a symlink: ${workDir} resolves to ${realWorkDir}`,
    );
  }

  return realWorkDir;
}
