import fsSync from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { VideoBackendError } from "./backend-contract.js";

// The Lattice static-export contract (lattice export --deck <id> output):
// a Slide Web Bundle is a self-contained directory produced by assembleOutput.
export const SLIDE_WEB_BUNDLE_REQUIRED_FILES = [
  "index.html",
  "manifest.json",
  "content.json",
  "layout.json",
  "notes.json",
];

export const SLIDE_WEB_BUNDLE_ASSETS_DIR = "assets";

function bundleError(message, cause = "invalid-bundle") {
  return new VideoBackendError(message, { backendId: null, diagnostics: [], cause });
}

function readJsonFile(filePath) {
  let raw;
  try {
    raw = fsSync.readFileSync(filePath, "utf8");
  } catch (error) {
    throw bundleError(`bundle file ${filePath} is not readable: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw bundleError(`bundle file ${filePath} is not valid JSON: ${error.message}`);
  }
}

/**
 * Deterministic bundle identity: SHA-256 over every regular file in the
 * bundle, ordered by forward-slashed relative path, hashed as
 * `<relPath>\0<bytes>\0`. Both adapters and the CLI plan command use this,
 * so the same bundle directory always yields the same identity hash.
 *
 * Slide Web Bundles produced by "lattice export" are regular-file trees, so
 * this walk fail-fasts on symlinks and other unsupported entry types instead
 * of silently omitting them: a hash that ignores entries would let two
 * semantically different bundles share one identity.
 */
export function computeBundleIdentityHash(bundlePath) {
  const files = [];
  const walk = (dir, relPrefix) => {
    let entries;
    try {
      entries = fsSync.readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      throw bundleError(`bundle directory ${relPrefix || "."} is not readable: ${error.message}`);
    }
    // Sort by UTF-8 byte order, never by locale: localeCompare() varies with
    // the process locale (e.g. en-US vs sv-SE order "ä.txt" differently), so
    // the same bundle would hash differently across environments. Byte order
    // matches the path+bytes hashing below and is locale-independent.
    const byUtf8Bytes = (a, b) =>
      Buffer.compare(Buffer.from(a.name, "utf8"), Buffer.from(b.name, "utf8"));
    for (const entry of entries.sort(byUtf8Bytes)) {
      const rel = relPrefix === "" ? entry.name : `${relPrefix}/${entry.name}`;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        throw bundleError(
          `bundle contains a symlink at ${rel}; Slide Web Bundles must be regular-file trees produced by "lattice export --deck <id>" (no symlinks)`,
        );
      }
      if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        files.push({ full, rel });
      } else {
        throw bundleError(
          `bundle contains an unsupported entry at ${rel}; Slide Web Bundles must be regular-file trees produced by "lattice export --deck <id>" (no special files)`,
        );
      }
    }
  };
  walk(bundlePath, "");

  const hash = createHash("sha256");
  for (const { full, rel } of files) {
    let bytes;
    try {
      bytes = fsSync.readFileSync(full);
    } catch (error) {
      throw bundleError(`bundle file ${rel} is not readable: ${error.message}`);
    }
    hash.update(rel);
    hash.update("\0");
    hash.update(bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
}

/**
 * Resolve a manifest.entry reference as a safe bundle-relative path.
 * Rejects absolute paths and lexical traversal outside the bundle directory.
 */
function resolveBundleEntryPath({ bundlePath, key, ref }) {
  if (ref.includes("\0")) {
    throw bundleError(
      `bundle manifest.json entry.${key} contains a NUL byte: ${JSON.stringify(ref)}`,
    );
  }
  if (path.posix.isAbsolute(ref) || path.win32.isAbsolute(ref)) {
    throw bundleError(
      `bundle manifest.json entry.${key} must be a bundle-relative path, not an absolute path: ${JSON.stringify(ref)}`,
    );
  }
  const resolved = path.resolve(bundlePath, ref);
  const relative = path.relative(bundlePath, resolved);
  if (
    relative.length === 0 ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw bundleError(
      `bundle manifest.json entry.${key} must reference a file inside the bundle directory, got ${JSON.stringify(ref)}`,
    );
  }
  return resolved;
}

/**
 * Validate one manifest.entry reference: the reference itself must not be a
 * symlink (even when it resolves inside the bundle), the target must resolve
 * (no symlink escape), be a readable regular file, and contain valid JSON.
 */
function requireBundleEntryJson({ bundlePath, key, ref }) {
  const resolved = resolveBundleEntryPath({ bundlePath, key, ref });

  let refStat = null;
  try {
    refStat = fsSync.lstatSync(resolved);
  } catch {
    refStat = null;
  }
  if (refStat && refStat.isSymbolicLink()) {
    throw bundleError(
      `bundle manifest.json entry.${key} must reference a regular file, not a symlink: ${JSON.stringify(ref)}`,
    );
  }

  let realTarget;
  try {
    realTarget = fsSync.realpathSync(resolved);
  } catch {
    throw bundleError(
      `bundle manifest.json entry.${key} references a missing file: ${JSON.stringify(ref)}`,
    );
  }
  if (realTarget !== bundlePath && !realTarget.startsWith(bundlePath + path.sep)) {
    throw bundleError(
      `bundle manifest.json entry.${key} escapes the bundle directory via symlink: ` +
      `${JSON.stringify(ref)} resolves to ${realTarget} outside ${bundlePath}`,
    );
  }

  let stat = null;
  try {
    stat = fsSync.statSync(realTarget);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isFile()) {
    throw bundleError(
      `bundle manifest.json entry.${key} must reference a regular file: ${JSON.stringify(ref)} resolves to ${realTarget}`,
    );
  }

  let raw;
  try {
    raw = fsSync.readFileSync(realTarget, "utf8");
  } catch (error) {
    throw bundleError(
      `bundle manifest.json entry.${key} file is not readable: ${JSON.stringify(ref)} (${realTarget}): ${error.message}`,
    );
  }
  try {
    JSON.parse(raw);
  } catch (error) {
    throw bundleError(
      `bundle manifest.json entry.${key} file is not valid JSON: ${JSON.stringify(ref)} (${realTarget}): ${error.message}`,
    );
  }
}

/**
 * Validate that bundleDir is a genuine Lattice Slide Web Bundle for deckId.
 * A valid bundle is a regular-file tree: any symlink or unsupported entry
 * under the bundle root is rejected, even when it resolves inside the bundle.
 * Returns { bundlePath, manifest, bundleHash } where bundlePath is the
 * realpath-canonical bundle directory.
 */
export function validateSlideWebBundle({ bundleDir, deckId }) {
  if (!bundleDir || typeof bundleDir !== "string") {
    throw bundleError("bundleDir must be a non-empty string");
  }
  if (!deckId || typeof deckId !== "string") {
    throw bundleError("deckId must be a non-empty string to validate bundle identity");
  }

  const resolved = path.resolve(bundleDir);

  let stat = null;
  try {
    stat = fsSync.statSync(resolved);
  } catch {
    stat = null;
  }
  if (!stat || !stat.isDirectory()) {
    throw bundleError(`bundleDir must exist and be a directory: ${bundleDir}`);
  }

  let bundlePath;
  try {
    bundlePath = fsSync.realpathSync(resolved);
  } catch {
    throw bundleError(`bundleDir cannot be resolved: ${bundleDir}`);
  }

  // Required root files must exist; symlinks are not rejected here so that a
  // symlinked entry target still produces its precise entry.* diagnostic
  // first, and the unified no-symlinks-anywhere policy enforced below (via
  // computeBundleIdentityHash) rejects every remaining symlink by relative
  // path before any identity is produced.
  for (const fileName of SLIDE_WEB_BUNDLE_REQUIRED_FILES) {
    const filePath = path.join(bundlePath, fileName);
    let fileStat = null;
    try {
      fileStat = fsSync.lstatSync(filePath);
    } catch {
      fileStat = null;
    }
    if (!fileStat || (!fileStat.isFile() && !fileStat.isSymbolicLink())) {
      throw bundleError(
        `bundleDir is not a Lattice Slide Web Bundle: missing required file ${fileName} in ${bundleDir}. ` +
        `A valid bundle is produced by "lattice export --deck <id>".`,
      );
    }
  }

  let indexHtml;
  try {
    indexHtml = fsSync.readFileSync(path.join(bundlePath, "index.html"), "utf8");
  } catch (error) {
    throw bundleError(`bundle index.html is not readable: ${error.message}`);
  }
  if (indexHtml.trim().length === 0) {
    throw bundleError(`bundle index.html is empty: ${bundleDir}`);
  }

  let assetsStat = null;
  try {
    assetsStat = fsSync.lstatSync(path.join(bundlePath, SLIDE_WEB_BUNDLE_ASSETS_DIR));
  } catch {
    assetsStat = null;
  }
  if (assetsStat && assetsStat.isSymbolicLink()) {
    throw bundleError(
      `bundle ${SLIDE_WEB_BUNDLE_ASSETS_DIR}/ directory is a symlink in ${bundleDir}; ` +
      `Slide Web Bundles must be regular-file trees (no symlinks)`,
    );
  }
  if (!assetsStat || !assetsStat.isDirectory()) {
    throw bundleError(
      `bundleDir is not a Lattice Slide Web Bundle: missing ${SLIDE_WEB_BUNDLE_ASSETS_DIR}/ directory in ${bundleDir}`,
    );
  }

  const manifest = readJsonFile(path.join(bundlePath, "manifest.json"));
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw bundleError(`bundle manifest.json must contain a JSON object: ${bundleDir}`);
  }
  if (typeof manifest.schema !== "string" || !/^lattice\.deck\.v\d+$/.test(manifest.schema)) {
    throw bundleError(
      `bundle manifest.json has no Lattice deck schema (expected "lattice.deck.vN"), got ${JSON.stringify(manifest.schema)}: ${bundleDir}`,
    );
  }
  if (typeof manifest.id !== "string" || manifest.id.length === 0) {
    throw bundleError(`bundle manifest.json has no deck id: ${bundleDir}`);
  }
  if (manifest.id !== deckId) {
    throw bundleError(
      `bundle identity mismatch: bundle is for deck "${manifest.id}" but plan requests deck "${deckId}" (${bundleDir})`,
    );
  }

  // The exporter (packages/cli/src/commands/export.js) records the entry JSON
  // files in manifest.entry; validation must follow those declared references
  // instead of assuming fixed filenames, so a manifest without a valid entry
  // object is never accepted.
  const entry = manifest.entry;
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    throw bundleError(
      `bundle manifest.json must declare an "entry" object mapping content/layout/notes to bundle-relative JSON files, ` +
      `got ${JSON.stringify(entry ?? null)}: ${bundleDir}`,
    );
  }
  for (const key of ["content", "layout", "notes"]) {
    const ref = entry[key];
    if (typeof ref !== "string" || ref.trim().length === 0) {
      throw bundleError(
        `bundle manifest.json entry.${key} must be a non-empty bundle-relative path string, ` +
        `got ${JSON.stringify(ref ?? null)}: ${bundleDir}`,
      );
    }
    requireBundleEntryJson({ bundlePath, key, ref });
  }

  const bundleHash = computeBundleIdentityHash(bundlePath);

  return { bundlePath, manifest, bundleHash };
}
