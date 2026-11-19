// Shared deck semantic view + Content Lock plumbing for `lattice edit` and
// `lattice lock`.
//
// Every deck module import here goes through the project's vite module loader
// (the same pipeline `lattice validate` uses), so slide modules that import
// CSS load exactly like they do in the portal, and no command run ever writes
// into the business source tree (the dep-optimizer cache lives in the OS
// temp dir).
//
// Fingerprint semantics intentionally mirror scripts/lock-update.mjs and the
// lattice-slides content-lock tests: content, notes, and buildSlides() output
// are fingerprinted against the content-identity manifest (the frozen v1
// identity when an explicit migration report exists, the live manifest
// otherwise). All three call sites share resolveContentIdentityManifest from
// the runtime, so they cannot drift.

import fs from "node:fs";
import path from "node:path";
import {
  DECK_SCHEMA_V2,
  computeContentFingerprint,
  resolveContentIdentityManifest,
} from "@55aaseclab/lattice-runtime";
import { createProjectModuleLoader } from "../deck-v2/project-module-loader.js";

export const DEFAULT_LOCKS_DIR = ".lattice/content-locks";
export const DEFAULT_MIGRATION_DIR = ".lattice/migration";

export function deckDirPath(cwd, config, deckId) {
  return path.resolve(cwd, config.decksDir, deckId);
}

export function listDeckIds(decksDir) {
  if (!fs.existsSync(decksDir)) return [];
  return fs
    .readdirSync(decksDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort();
}

export function readManifest(deckDir) {
  const manifestPath = path.join(deckDir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw Object.assign(new Error(`deck has no manifest.json: ${manifestPath}`), { code: "manifest-not-found" });
  }
  try {
    return JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw Object.assign(new Error(`manifest.json is not valid JSON: ${error.message}`), { code: "invalid-manifest" });
  }
}

export function requireV2Manifest(manifest, deckId) {
  if (manifest.schema !== DECK_SCHEMA_V2) {
    throw Object.assign(
      new Error(
        `deck "${deckId}" has schema ${JSON.stringify(manifest.schema ?? null)}; targeted edits and content locks operate on ${DECK_SCHEMA_V2} only — run \`lattice migrate --deck ${deckId}\` first`,
      ),
      { code: "deck-not-v2" },
    );
  }
  return manifest;
}

export function resolveLocksDir(cwd, overrides = {}) {
  return path.resolve(cwd, overrides.locksDir ?? DEFAULT_LOCKS_DIR);
}

export function lockPathFor(locksDir, deckId) {
  return path.join(locksDir, `${deckId}.json`);
}

export function readLockRecord(locksDir, deckId) {
  const lockPath = lockPathFor(locksDir, deckId);
  if (!fs.existsSync(lockPath)) return null;
  try {
    const record = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    record.lockPath = lockPath;
    return record;
  } catch (error) {
    throw Object.assign(new Error(`content lock at ${lockPath} is not valid JSON: ${error.message}`), { code: "invalid-lock" });
  }
}

export function resolveIdentityManifest({ cwd, deckId, liveManifest, migrationDir }) {
  const migrationReportsDir = path.resolve(cwd, migrationDir ?? DEFAULT_MIGRATION_DIR);
  const reportPath = path.join(migrationReportsDir, `${deckId}.json`);
  let migrationReport = null;
  if (fs.existsSync(reportPath)) {
    try {
      migrationReport = JSON.parse(fs.readFileSync(reportPath, "utf8"));
    } catch (error) {
      throw Object.assign(
        new Error(`migration report at ${reportPath} is not valid JSON: ${error.message}`),
        { code: "invalid-migration-report" },
      );
    }
  }
  const resolved = resolveContentIdentityManifest({ liveManifest, migrationReport, deckId });
  if (!resolved.ok) {
    throw Object.assign(
      new Error(
        `content identity mismatch for deck "${deckId}": ${resolved.reason}` +
          (resolved.diffs?.length ? ` (${resolved.diffs.join(", ")})` : "") +
          "; refusing to verify against a drifted identity",
      ),
      { code: resolved.reason ?? "identity-resolution-failed", diffs: resolved.diffs ?? [] },
    );
  }
  return resolved.manifest;
}

function entryPath(deckDir, manifest, entryName, fallback) {
  const relative = manifest.entry?.[entryName] ?? fallback;
  return path.resolve(deckDir, relative);
}

/**
 * Load the semantic view of a deck: plain content value, notes value, slide
 * outputs (in stored-lock order), and the content-identity manifest.
 * `loader` must expose load(modulePath) and close(); when omitted a fresh
 * project module loader is created and closed by the returned disposer.
 */
export async function withDeckView(cwd, config, deckId, fn, { loader } = {}) {
  const deckDir = deckDirPath(cwd, config, deckId);
  if (!fs.existsSync(deckDir)) {
    throw Object.assign(new Error(`deck directory not found: ${deckDir}`), { code: "deck-not-found" });
  }
  const manifest = requireV2Manifest(readManifest(deckDir), deckId);
  const identityManifest = resolveIdentityManifest({ cwd, deckId, liveManifest: manifest });

  if (loader) {
    return { view: await buildView(loader), manifest, deckDir, identityManifest };
  }

  const moduleLoader = await createProjectModuleLoader(cwd);
  try {
    const view = await buildView(moduleLoader);
    return { view, manifest, deckDir, identityManifest };
  } finally {
    await moduleLoader.close();
  }

  async function buildView(activeLoader) {
    const content = await loadValue(activeLoader, entryPath(deckDir, manifest, "content", "./content.js"), "content.js");
    const notes = await loadNotes(activeLoader, deckDir, manifest);
    const slideOutputs = await loadSlideOutputs(activeLoader, deckDir, manifest);
    return { content, notes, slideOutputs };
  }
}

async function loadValue(loader, modulePath, label) {
  let module;
  try {
    module = await loader.load(modulePath);
  } catch (error) {
    throw Object.assign(new Error(`build/import error in ${label}: ${error.message}`), { code: "deck-build-error" });
  }
  return plainValue(module.default ?? module, label);
}

async function loadNotes(loader, deckDir, manifest) {
  const notesPath = entryPath(deckDir, manifest, "notes", "./notes.js");
  if (!fs.existsSync(notesPath)) return {};
  let module;
  try {
    module = await loader.load(notesPath);
  } catch (error) {
    throw Object.assign(new Error(`build/import error in notes.js: ${error.message}`), { code: "deck-build-error" });
  }
  return plainValue(module.default ?? module, "notes.js");
}

async function loadSlideOutputs(loader, deckDir, manifest) {
  // The canonical slide-output order for a stored lock is the deck's own
  // buildSlides() (scripts/lock-update.mjs semantics). When a deck has no
  // v1 slides module, the v2 slide definitions are the source of truth.
  const slidesModulePath = path.join(deckDir, "slides.js");
  if (fs.existsSync(slidesModulePath)) {
    let module;
    try {
      module = await loader.load(slidesModulePath);
    } catch (error) {
      throw Object.assign(new Error(`build/import error in slides.js/buildSlides: ${error.message}`), { code: "deck-build-error" });
    }
    if (typeof module.buildSlides !== "function") {
      throw Object.assign(new Error("slides.js exists but buildSlides is not exported as a function"), { code: "deck-build-error" });
    }
    let outputs;
    try {
      outputs = module.buildSlides();
    } catch (error) {
      throw Object.assign(new Error(`build/import error in slides.js/buildSlides: ${error.message}`), { code: "deck-build-error" });
    }
    if (!Array.isArray(outputs)) {
      throw Object.assign(new Error("buildSlides() must return an array of slide HTML strings"), { code: "deck-build-error" });
    }
    return outputs;
  }

  const slideEntryPath = entryPath(deckDir, manifest, "slides", "./slides.v2.js");
  let module;
  try {
    module = await loader.load(slideEntryPath);
  } catch (error) {
    throw Object.assign(new Error(`build/import error in ${manifest.entry?.slides ?? "./slides.v2.js"}: ${error.message}`), { code: "deck-build-error" });
  }
  const definitions = module.slideDefinitions;
  if (!Array.isArray(definitions)) {
    throw Object.assign(new Error("slide entry module must export a slideDefinitions array"), { code: "deck-build-error" });
  }
  return definitions.map((definition) => (typeof definition.html === "function" ? definition.html() : definition.html));
}

// Module namespace objects and class instances are exotic: normalize through
// JSON so fingerprinting and in-memory mutation behave exactly like the
// serialized file on disk.
function plainValue(value, label) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (error) {
    throw Object.assign(new Error(`${label} is not JSON-serializable: ${error.message}`), { code: "deck-build-error" });
  }
}

export function deckFingerprint(view, identityManifest) {
  return computeContentFingerprint(view.content, identityManifest, view.notes, view.slideOutputs);
}
