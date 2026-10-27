// Lattice template library (M6).
//
// A template is a formal, reusable deck starter built on a shared runtime
// Theme: machine-readable metadata (template.json), a deterministic scaffold
// entry (template.js), and human docs (README.md). Templates own structure
// only — they must never carry business copy, data, notes, or assets, and
// they never modify the Theme itself.
//
// Every template directory contains:
//   template.json  { schema: "lattice.template.v1", id, name, description,
//                    target, baseTheme, lineage, vars }
//   template.js    export function scaffold(vars) -> { files, registryEntry }
//   README.md      human-facing description

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const TEMPLATE_SCHEMA = "lattice.template.v1";

const libraryDir = path.dirname(fileURLToPath(import.meta.url));

function fail(code, message) {
  throw Object.assign(new Error(message), { code });
}

function readTemplateDir(templateDir) {
  const metaPath = path.join(templateDir, "template.json");
  const modulePath = path.join(templateDir, "template.js");
  if (!fs.existsSync(metaPath) || !fs.existsSync(modulePath)) {
    fail("invalid-template", `template directory ${templateDir} must contain template.json and template.js`);
  }
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch (error) {
    fail("invalid-template", `template.json in ${templateDir} is not valid JSON: ${error.message}`);
  }
  validateMeta(meta, templateDir);
  return { meta, dir: templateDir };
}

function validateMeta(meta, templateDir) {
  const requireField = (field) => {
    const value = meta[field];
    if (typeof value !== "string" || value === "") {
      fail("invalid-template", `template.json in ${templateDir}: "${field}" must be a non-empty string`);
    }
  };
  if (meta.schema !== TEMPLATE_SCHEMA) {
    fail("invalid-template", `template.json in ${templateDir}: unsupported schema ${JSON.stringify(meta.schema ?? null)} (expected ${TEMPLATE_SCHEMA})`);
  }
  requireField("id");
  requireField("name");
  requireField("description");
  requireField("baseTheme");
  if (meta.target !== "deck") {
    fail("invalid-template", `template.json in ${templateDir}: target must be "deck"`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(meta.id)) {
    fail("invalid-template", `template.json in ${templateDir}: id "${meta.id}" must be a stable slug`);
  }
  if (meta.lineage === undefined || meta.lineage === null || typeof meta.lineage !== "object") {
    fail("invalid-template", `template.json in ${templateDir}: lineage must describe where the structure comes from`);
  }
  if (!Array.isArray(meta.vars)) {
    fail("invalid-template", `template.json in ${templateDir}: vars must be an array`);
  }
}

let cache = null;

export function listTemplates() {
  if (!cache) {
    cache = fs
      .readdirSync(libraryDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => readTemplateDir(path.join(libraryDir, entry.name)))
      .sort((a, b) => a.meta.id.localeCompare(b.meta.id));
  }
  return cache;
}

export function getTemplate(id) {
  const templates = listTemplates();
  const found = templates.find((template) => template.meta.id === id);
  if (!found) {
    fail("template-not-found", `unknown template "${id}"; available: ${templates.map((template) => template.meta.id).join(", ")}`);
  }
  return found;
}

export async function loadTemplateModule(id) {
  const template = getTemplate(id);
  const module = await import(pathToFileURL(path.join(template.dir, "template.js")));
  if (typeof module.scaffold !== "function") {
    fail("invalid-template", `template "${id}" must export a scaffold(vars) function`);
  }
  return { meta: template.meta, scaffold: module.scaffold };
}

export function describeTemplates() {
  return listTemplates().map(({ meta }) => ({
    id: meta.id,
    name: meta.name,
    description: meta.description,
    target: meta.target,
    baseTheme: meta.baseTheme,
    lineage: meta.lineage,
    vars: meta.vars,
  }));
}
