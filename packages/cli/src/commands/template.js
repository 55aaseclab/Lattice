// lattice template — list, inspect, and scaffold deck templates (M6).
//
// Templates are formal deck starters built on shared runtime Themes. The
// scaffold is deterministic (same vars → byte-identical files), refuses to
// overwrite an existing deck, and can register the new deck in the project's
// decks/registry.js when that file has the canonical generated shape.
//
// All output is JSON (except --help). Exit codes: 0 success / dry-run
// allowed, 1 the scaffold was refused (existing deck, ambiguous registry
// shape with update requested), 2 configuration or infrastructure failure
// (unknown template, invalid vars, missing project config).

import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/index.js";
import { describeTemplates, getTemplate, loadTemplateModule } from "../templates/library/index.js";
import { scanSource } from "../edit/source-map.js";

const TEMPLATE_USAGE = `Usage: lattice template list
       lattice template show <template-id>
       lattice template scaffold <template-id> --deck <deckId> [--title <t>] [--owner <o>]
                                  [--presenter <p>] [--description <d>] [--stages <n>]
                                  [--dry-run] [--force] [--no-registry-update] [--help]

List, inspect, and scaffold Lattice deck templates. Templates are reusable
deck starters built on shared runtime Themes; they carry structure only and
never business copy, data, notes, or assets.

list    Print all available templates as JSON (id, name, description,
        baseTheme, lineage, vars).
show    Print one template's metadata as JSON.
scaffold Generate a new deck under decks/<deckId>/ from the template and
        register it in decks/registry.js when that file exists with the
        canonical shape (--no-registry-update skips registration; an
        unrecognized registry shape is a hard error). Existing decks are
        never overwritten unless --force is given. --dry-run prints the
        would-be file map and registry patch without writing anything.

Scaffold output is deterministic: the same template and vars always produce
byte-identical files.

Exit codes: 0 success / dry-run allowed; 1 refused (existing deck, registry
conflict); 2 configuration or infrastructure failure.`;

function fail(payload, exitCode = 1) {
  process.stderr.write(`${JSON.stringify({ ok: false, command: "template", ...payload }, null, 2)}\n`);
  process.exit(exitCode);
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify({ ok: true, command: "template", ...payload }, null, 2)}\n`);
}

export async function templateCommand({ args, cwd = process.cwd(), rest = [] }) {
  if (args.help) {
    console.log(TEMPLATE_USAGE);
    return;
  }
  const subcommand = rest[0];
  if (subcommand === "list") {
    emit({ action: "list", templates: describeTemplates() });
    return;
  }
  if (subcommand === "show") {
    const id = rest[1];
    if (!id) fail({ error: { code: "missing-argument", message: "usage: lattice template show <template-id>" } }, 2);
    try {
      const { meta } = getTemplate(id);
      emit({ action: "show", template: meta });
    } catch (error) {
      fail({ error: { code: error.code ?? "template-not-found", message: error.message } }, 2);
    }
    return;
  }
  if (subcommand !== "scaffold") {
    fail({ error: { code: "unknown-subcommand", message: "usage: lattice template list|show|scaffold (see --help)" } }, 2);
  }

  const templateId = rest[1];
  if (!templateId) fail({ error: { code: "missing-argument", message: "usage: lattice template scaffold <template-id> --deck <deckId>" } }, 2);
  if (!args.deck || typeof args.deck !== "string") {
    fail({ error: { code: "missing-argument", message: "--deck <deckId> is required" } }, 2);
  }
  const deckId = args.deck;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(deckId)) {
    fail({ error: { code: "invalid-deck-id", message: `--deck must be a stable slug (lowercase letters, digits, hyphens), got ${JSON.stringify(deckId)}` } }, 2);
  }

  let config;
  try {
    config = await loadConfig(cwd);
  } catch (error) {
    fail({ error: { code: "config-not-found", message: error.message } }, 2);
  }

  let module;
  try {
    module = await loadTemplateModule(templateId);
  } catch (error) {
    fail({ error: { code: error.code ?? "template-not-found", message: error.message } }, 2);
  }

  const vars = {
    deckId,
    title: typeof args.title === "string" ? args.title : undefined,
    owner: typeof args.owner === "string" ? args.owner : undefined,
    presenter: typeof args.presenter === "string" ? args.presenter : undefined,
    description: typeof args.description === "string" ? args.description : undefined,
    stages: args.stages,
  };

  let scaffolded;
  try {
    scaffolded = module.scaffold(vars);
  } catch (error) {
    fail({ error: { code: "scaffold-failed", message: error.message } }, 2);
  }

  const decksDir = path.resolve(cwd, config.decksDir);
  const deckDir = path.join(decksDir, deckId);
  const relativeDeckDir = `${config.decksDir}/${deckId}`;
  const dryRun = Boolean(args["dry-run"]);
  const force = Boolean(args.force);
  const updateRegistry = !args["no-registry-update"];

  if (fs.existsSync(deckDir) && !force) {
    fail({ error: { code: "deck-exists", message: `refusing to overwrite existing deck at ${relativeDeckDir} (use --force to replace it)` } }, 1);
  }

  const files = Object.entries(scaffolded.files).map(([name, content]) => ({
    path: `${relativeDeckDir}/${name}`,
    bytes: Buffer.byteLength(content, "utf8"),
  }));

  let registryPatch = null;
  const registryPath = config.registry ? path.resolve(cwd, config.registry) : null;
  if (registryPath && updateRegistry) {
    try {
      registryPatch = planRegistryUpdate(registryPath, scaffolded, deckId, cwd);
    } catch (error) {
      fail({
        error: {
          code: error.code ?? "registry-update-failed",
          message: error.message,
          hint: "re-run with --no-registry-update to scaffold without touching the registry",
        },
      }, 1);
    }
  }

  if (dryRun) {
    emit({
      action: "scaffold",
      dryRun: true,
      template: templateId,
      deck: deckId,
      files,
      wouldWrite: files.map((file) => file.path),
      registryPatch,
    });
    return;
  }

  fs.mkdirSync(deckDir, { recursive: true });
  for (const [name, content] of Object.entries(scaffolded.files)) {
    fs.writeFileSync(path.join(deckDir, name), content, "utf8");
  }
  if (registryPatch) {
    applyRegistryUpdate(registryPath, registryPatch);
  }

  emit({
    action: "scaffold",
    dryRun: false,
    template: templateId,
    deck: deckId,
    files,
    registryPatch: registryPatch ? { file: rel(cwd, registryPath), inserted: true } : null,
    next: [
      `lattice validate --deck ${deckId}`,
      `lattice lock update --deck ${deckId}`,
      `lattice lock verify --deck ${deckId}`,
    ],
  });
}

function rel(cwd, target) {
  return path.relative(cwd, target).split(path.sep).join("/");
}

// Locate the `export const deckRegistry = {` object and plan a deterministic
// insertion of the new entry plus its import line.
function planRegistryUpdate(registryPath, scaffolded, deckId, cwd) {
  if (!fs.existsSync(registryPath)) {
    throw Object.assign(new Error(`config.registry not found: ${rel(cwd, registryPath)}`), { code: "registry-not-found" });
  }
  const source = fs.readFileSync(registryPath, "utf8");
  const records = scanSource(source);
  const declaration = source.match(/export\s+const\s+deckRegistry\s*=\s*\{/);
  if (!declaration) {
    throw Object.assign(new Error("registry shape not recognized: expected `export const deckRegistry = {`"), { code: "registry-shape-unrecognized" });
  }
  const openBrace = declaration.index + declaration[0].length - 1;
  const record = records.find((candidate) => candidate.kind === "object" && candidate.start === openBrace);
  if (!record) {
    throw Object.assign(new Error("registry shape not recognized: could not map the deckRegistry object literal"), { code: "registry-shape-unrecognized" });
  }
  if (record.properties.some((property) => property.name === deckId)) {
    throw Object.assign(new Error(`registry already has an entry for deck "${deckId}"`), { code: "registry-entry-exists" });
  }

  // Entry indentation follows the first existing property; the insertion sits
  // immediately before the object's closing brace.
  let indent = "  ";
  if (record.properties.length > 0) {
    const firstKey = record.properties[0].keyStart;
    const lineStart = source.lastIndexOf("\n", firstKey) + 1;
    indent = source.slice(lineStart, firstKey);
  }
  const insertEntryAt = record.end - 1;
  // registryEntry already carries its trailing comma.
  const entryText = `${scaffolded.registryEntry.split("\n").map((line, index) => (index === 0 ? line : indent + line)).join("\n")}\n`;
  const importAnchor = lastImportLineEnd(source);

  return {
    insertEntryAt,
    entryText,
    insertImportAt: importAnchor,
    importText: importAnchor === null ? null : scaffolded.registryImport + "\n",
  };
}

function lastImportLineEnd(source) {
  const lines = source.split("\n");
  let charIndex = 0;
  let lastImportEnd = null;
  for (const line of lines) {
    if (/^import\s/.test(line)) {
      lastImportEnd = charIndex + line.length + 1;
    }
    charIndex += line.length + 1;
  }
  return lastImportEnd;
}

function applyRegistryUpdate(registryPath, patch) {
  let updated = fs.readFileSync(registryPath, "utf8");
  // Apply the higher-offset insertion first so the lower offset stays valid.
  const operations = [
    { at: patch.insertEntryAt, text: patch.entryText },
    ...(patch.insertImportAt !== null ? [{ at: patch.insertImportAt, text: patch.importText }] : []),
  ].sort((a, b) => b.at - a.at);
  for (const operation of operations) {
    updated = updated.slice(0, operation.at) + operation.text + updated.slice(operation.at);
  }
  fs.writeFileSync(registryPath, updated, "utf8");
}
