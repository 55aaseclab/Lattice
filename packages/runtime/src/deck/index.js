export const DECK_SCHEMA = "lattice.deck.v1";

export const RUNTIME_VERSION = "0.2.0";

import { createValidationIssue } from "../validator/index.js";

function parseVersion(version) {
  if (typeof version !== "string") return null;
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function isRuntimeCompatible(range, version = RUNTIME_VERSION) {
  const target = parseVersion(version);
  if (!target) return false;
  if (typeof range !== "string" || range.trim() === "") return false;
  const spec = range.trim();
  if (spec === "*") return true;

  let prefix = "";
  let minimumSpec = spec;
  if (spec.startsWith("^")) {
    prefix = "^";
    minimumSpec = spec.slice(1);
  } else if (spec.startsWith("~")) {
    prefix = "~";
    minimumSpec = spec.slice(1);
  } else if (spec.startsWith(">=")) {
    prefix = ">=";
    minimumSpec = spec.slice(2);
  } else if (spec.startsWith(">")) {
    prefix = ">";
    minimumSpec = spec.slice(1);
  } else if (spec.startsWith("<")) {
    return false;
  }
  const minimum = parseVersion(minimumSpec);
  if (!minimum) return false;
  const compare = (a, b) => a.major - b.major || a.minor - b.minor || a.patch - b.patch;
  if (compare(target, minimum) < (prefix === ">" ? 1 : 0)) return false;
  if (prefix === "^") {
    if (minimum.major > 0) return target.major === minimum.major;
    if (minimum.minor > 0) return target.major === 0 && target.minor === minimum.minor;
    return target.major === 0 && target.minor === 0 && target.patch >= minimum.patch;
  }
  if (prefix === "~") {
    return target.major === minimum.major && target.minor === minimum.minor;
  }
  return true;
}

export function validateManifest(manifest, { expectedId = "", runtimeVersion = RUNTIME_VERSION } = {}) {
  const errors = [];
  const issue = (type, message, details = {}) => createValidationIssue({
    type,
    element: details.element ?? "manifest",
    ...details,
    message,
  });
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return { ok: false, errors: [issue("invalid-manifest", "manifest must be a JSON object")] };
  }
  if (manifest.schema !== DECK_SCHEMA) {
    errors.push(issue(
      "schema-mismatch",
      `unsupported deck schema: ${JSON.stringify(manifest.schema)} (expected ${DECK_SCHEMA})`,
      { element: "manifest.schema" },
    ));
  }
  if (typeof manifest.id !== "string" || manifest.id === "") {
    errors.push(issue("invalid-manifest", "manifest.id must be a non-empty string", { element: "manifest.id" }));
  } else if (expectedId && manifest.id !== expectedId) {
    errors.push(issue(
      "invalid-manifest",
      `manifest.id "${manifest.id}" does not match deck directory "${expectedId}"`,
      { slide: manifest.id, element: "manifest.id" },
    ));
  }
  if (typeof manifest.title !== "string" || manifest.title === "") {
    errors.push(issue("invalid-manifest", "manifest.title must be a non-empty string", { slide: manifest.id, element: "manifest.title" }));
  }
  if (typeof manifest.owner !== "string" || manifest.owner.trim() === "") {
    errors.push(issue("invalid-manifest", "manifest.owner must be a non-empty string", { slide: manifest.id, element: "manifest.owner" }));
  }
  if (typeof manifest.presenter !== "string" || manifest.presenter.trim() === "") {
    errors.push(issue("invalid-manifest", "manifest.presenter must be a non-empty string", { slide: manifest.id, element: "manifest.presenter" }));
  }
  if (!isRuntimeCompatible(manifest.runtime, runtimeVersion)) {
    errors.push(issue(
      "runtime-incompatible",
      `deck requires runtime ${manifest.runtime} but installed runtime is ${runtimeVersion}`,
      { slide: manifest.id, element: "manifest.runtime" },
    ));
  }
  if (typeof manifest.theme !== "string" || manifest.theme === "") {
    errors.push(issue("invalid-manifest", "manifest.theme must be a non-empty string", { slide: manifest.id, element: "manifest.theme" }));
  }
  const entry = manifest.entry ?? {};
  for (const entryName of ["content", "layout", "notes"]) {
    if (typeof entry[entryName] !== "string" || entry[entryName] === "") {
      errors.push(issue(
        "invalid-manifest",
        `manifest.entry.${entryName} must be a non-empty string`,
        { slide: manifest.id, element: `manifest.entry.${entryName}` },
      ));
    }
  }
  if (typeof manifest.assets !== "string" || manifest.assets === "") {
    errors.push(issue("invalid-manifest", "manifest.assets must be a non-empty string", { slide: manifest.id, element: "manifest.assets" }));
  }
  return { ok: errors.length === 0, errors };
}

export async function loadDeckPackage(deckDir, { runtimeVersion = RUNTIME_VERSION } = {}) {
  const manifestUrl = new URL("manifest.json", `file://${deckDir}/`);
  const { readFile } = await import("node:fs/promises");
  const manifestPath = manifestUrl.pathname;
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    return {
      ok: false,
      errors: [createValidationIssue({
        type: "missing-manifest",
        element: "manifest",
        message: `cannot read ${manifestPath}: ${error.message}`,
      })],
    };
  }

  const report = validateManifest(manifest, { expectedId: deckDir.split("/").filter(Boolean).pop(), runtimeVersion });
  if (!report.ok) {
    return { ok: false, errors: report.errors };
  }

  const resolveEntry = (relative) => new URL(relative, `file://${deckDir}/`).pathname;
  const entries = {};
  for (const entryName of ["content", "layout", "notes"]) {
    const entryPath = resolveEntry(manifest.entry[entryName]);
    try {
      entries[entryName] = (await import(entryPath)).default;
    } catch (error) {
      return {
        ok: false,
        errors: [createValidationIssue({
          type: "entry-import-failed",
          slide: manifest.id,
          element: `manifest.entry.${entryName}`,
          message: `cannot import ${entryPath}: ${error.message}`,
        })],
      };
    }
  }

  return {
    ok: true,
    errors: [],
    manifest,
    content: entries.content,
    layout: entries.layout,
    notes: entries.notes,
    assetsDir: resolveEntry(manifest.assets),
  };
}
