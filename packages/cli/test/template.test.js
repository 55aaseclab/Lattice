// M6 — Template library: formal `simple-light` starter template, the
// stage-table template derived from a real deck's layout skeleton, and the
// multi-project shared-Theme guarantee (Theme directory untouched by any
// project).

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(testDir, "..");
const repoRoot = path.resolve(cliRoot, "..", "..");
const runtimeRoot = path.resolve(cliRoot, "..", "runtime");
const themeDir = path.join(runtimeRoot, "themes", "simple-light");
const libraryDir = path.join(cliRoot, "src", "templates", "library");
const binPath = path.join(cliRoot, "src", "index.js");
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-template-tests-"));

const { scaffoldTemplate } = await import("./helpers/scaffold-project.js");

function runCli(cwd, args) {
  return spawnSync(process.execPath, [binPath, ...args], { cwd, encoding: "utf8", timeout: 300000 });
}

function readJsonOutput(result, stream = "stdout") {
  const text = (stream === "stderr" ? result.stderr : result.stdout).trim();
  const start = text.indexOf("{");
  assert.ok(start >= 0, `expected JSON output, got: ${text}`);
  return JSON.parse(text.slice(start));
}

function makeProject(name, { registry = false } = {}) {
  const projectDir = fs.mkdtempSync(path.join(tmpRoot, `lattice-template-${name}-`));
  const config = registry
    ? 'export default {\n  title: "Template Test",\n  registry: "./decks/registry.js",\n};\n'
    : 'export default {\n  title: "Template Test",\n  registry: null,\n};\n';
  fs.writeFileSync(path.join(projectDir, "lattice.config.js"), config, "utf8");
  return projectDir;
}

function dirHash(root) {
  const hash = createHash("sha256");
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else hash.update(`${path.relative(root, full)}\0${fs.readFileSync(full).toString("base64")}\0`);
    }
  };
  walk(root);
  return hash.digest("hex");
}

test("every template carries schema-valid metadata, a scaffold entry, and docs", () => {
  const result = runCli(repoRoot, ["template", "list"]);
  assert.equal(result.status, 0);
  const report = readJsonOutput(result, "stdout");
  const ids = report.templates.map((template) => template.id);
  assert.ok(ids.includes("simple-light"), "the simple-light formal template must exist");
  assert.ok(ids.includes("stage-table"), "the stage-table template derived from a real deck must exist");
  for (const template of report.templates) {
    const dir = path.join(libraryDir, template.id);
    assert.equal(template.target, "deck");
    assert.equal(template.baseTheme, "simple-light", "templates must be built on the shared runtime Theme");
    assert.ok(fs.existsSync(path.join(dir, "template.json")));
    assert.ok(fs.existsSync(path.join(dir, "template.js")));
    assert.ok(fs.existsSync(path.join(dir, "README.md")));
    assert.ok(template.lineage && typeof template.lineage === "object", "lineage must be documented");
  }
});

test("the simple-light template is a formalized Theme starter, not a Theme copy", () => {
  const meta = JSON.parse(fs.readFileSync(path.join(libraryDir, "simple-light", "template.json"), "utf8"));
  assert.equal(meta.schema, "lattice.template.v1");
  assert.equal(meta.baseTheme, "simple-light");
  assert.equal(meta.lineage.kind, "theme-starter");
  // Templates must not duplicate the Theme's own sources.
  const themeFiles = fs.readdirSync(themeDir);
  const templateFiles = fs.readdirSync(path.join(libraryDir, "simple-light"));
  for (const themeFile of themeFiles) {
    assert.ok(!templateFiles.includes(themeFile), `template must not carry a copy of Theme file ${themeFile}`);
  }
});

test("the stage-table template derives its structure from a real deck without frozen content", () => {
  const meta = JSON.parse(fs.readFileSync(path.join(libraryDir, "stage-table", "template.json"), "utf8"));
  assert.equal(meta.lineage.kind, "derived-from-real-deck-structure");
  assert.equal(meta.lineage.pattern, "stage-table-overview");

  // Structure signature: three-part stage cells over the Theme's title-only
  // layout — the pattern the frozen research-talk deck's overview slide uses.
  const scaffoldModule = fs.readFileSync(path.join(libraryDir, "stage-table", "template.js"), "utf8");
  assert.ok(scaffoldModule.includes("simpleLightLayouts.titleOnly"), "derived template must reuse the Theme title-only layout");
  for (const part of ["kicker", "title", "summary"]) {
    assert.ok(scaffoldModule.includes(`stage-cell-${part}`), `stage cells must carry the ${part} part`);
  }

  // No frozen business copy, data, notes, or assets anywhere in the template.
  const frozenMarkers = [
    "Looking Back", "Postdoctoral", "Vibe Research", "M1 Primitives", "Qiang Liu",
    "GBU", "hypervisor", "Morpheus", "Prompting, Copy", "GPT-4", "Lessons From",
    "story-2023", "google-translate", "June 4, 2026", "October 22, 2026",
  ];
  for (const file of fs.readdirSync(path.join(libraryDir, "stage-table"))) {
    const source = fs.readFileSync(path.join(libraryDir, "stage-table", file), "utf8").toLowerCase();
    for (const marker of frozenMarkers) {
      assert.ok(!source.includes(marker.toLowerCase()), `stage-table ${file} must not contain frozen marker "${marker}"`);
    }
  }
});

test("template list and show emit deterministic JSON and reject unknown ids", () => {
  const first = runCli(repoRoot, ["template", "list"]);
  const second = runCli(repoRoot, ["template", "list"]);
  assert.equal(first.stdout, second.stdout, "template list output must be deterministic");

  const show = runCli(repoRoot, ["template", "show", "simple-light"]);
  assert.equal(show.status, 0);
  assert.equal(readJsonOutput(show, "stdout").template.id, "simple-light");

  const missing = runCli(repoRoot, ["template", "show", "nope"]);
  assert.equal(missing.status, 2);
  assert.equal(readJsonOutput(missing, "stderr").error.code, "template-not-found");
});

test("scaffold is deterministic: same template and vars produce byte-identical decks", () => {
  const projectA = makeProject("det-a");
  const projectB = makeProject("det-b");
  scaffoldTemplate(projectA, "stage-table", { deckId: "same", title: "Same", stages: 4 });
  scaffoldTemplate(projectB, "stage-table", { deckId: "same", title: "Same", stages: 4 });
  const filesA = fs.readdirSync(path.join(projectA, "decks", "same")).sort();
  const filesB = fs.readdirSync(path.join(projectB, "decks", "same")).sort();
  assert.deepEqual(filesA, filesB);
  for (const file of filesA) {
    assert.equal(
      fs.readFileSync(path.join(projectA, "decks", "same", file), "utf8"),
      fs.readFileSync(path.join(projectB, "decks", "same", file), "utf8"),
      `${file} must be byte-identical across scaffolds`,
    );
  }
  fs.rmSync(projectA, { recursive: true, force: true });
  fs.rmSync(projectB, { recursive: true, force: true });
});

test("scaffold dry-run writes nothing and reports the file map", () => {
  const project = makeProject("dry");
  const before = fs.statSync(project).mtimeMs;
  const result = runCli(project, ["template", "scaffold", "simple-light", "--deck", "dry-deck", "--dry-run"]);
  assert.equal(result.status, 0);
  const report = readJsonOutput(result, "stdout");
  assert.equal(report.dryRun, true);
  assert.ok(report.files.some((file) => file.path === "decks/dry-deck/manifest.json"));
  assert.ok(!fs.existsSync(path.join(project, "decks", "dry-deck")), "dry-run must not create the deck");
  assert.equal(before, fs.statSync(project).mtimeMs);
  fs.rmSync(project, { recursive: true, force: true });
});

test("scaffold refuses to overwrite an existing deck without --force", () => {
  const project = makeProject("overwrite");
  scaffoldTemplate(project, "simple-light", { deckId: "exists", title: "First" });
  const first = fs.readFileSync(path.join(project, "decks", "exists", "manifest.json"), "utf8");
  const refused = runCli(project, ["template", "scaffold", "simple-light", "--deck", "exists", "--title", "Second"]);
  assert.equal(refused.status, 1);
  assert.equal(readJsonOutput(refused, "stderr").error.code, "deck-exists");
  assert.equal(fs.readFileSync(path.join(project, "decks", "exists", "manifest.json"), "utf8"), first);
  fs.rmSync(project, { recursive: true, force: true });
});

test("scaffold registers the deck in a canonical registry and the project validates", () => {
  const project = makeProject("registry", { registry: false });
  scaffoldTemplate(project, "simple-light", { deckId: "demo", title: "Demo" });
  // Switch the project to the canonical registry and give it the generated shape.
  fs.writeFileSync(
    path.join(project, "lattice.config.js"),
    'export default {\n  title: "Template Test",\n  registry: "./decks/registry.js",\n};\n',
    "utf8",
  );
  fs.writeFileSync(
    path.join(project, "decks", "registry.js"),
    `import "@55aaseclab/lattice-runtime/themes/simple-light/styles.css";
import { buildSlides as buildDemoSlides } from "./demo/slides.js";

export const deckRegistry = {
  demo: {
    id: "demo",
    title: "Demo",
    owner: "your-handle",
    presenter: "Your Name",
    description: "Demo deck",
    buildSlides: buildDemoSlides,
  },
};

export const deckList = Object.values(deckRegistry);
`,
    "utf8",
  );
  const scaffold = scaffoldTemplate(project, "stage-table", { deckId: "roadmap", title: "Roadmap", stages: 4 });

  const registrySource = fs.readFileSync(path.join(project, "decks", "registry.js"), "utf8");
  assert.match(registrySource, /import \{ buildSlides as buildRoadmapSlides \} from "\.\/roadmap\/slides\.js";/);
  assert.match(registrySource, /"roadmap": \{/);
  assert.ok(registrySource.indexOf("buildRoadmapSlides") < registrySource.indexOf("export const deckRegistry"), "import must precede the declaration");

  const validate = runCli(project, ["validate", "--deck", "roadmap"]);
  assert.equal(validate.status, 0, `scaffolded deck must validate: ${validate.stderr}`);
  assert.ok(scaffold);
  fs.rmSync(project, { recursive: true, force: true });
});

// ---- Multi-project shared Theme (M6) ----

test("multiple projects reference the same simple-light Theme with zero Theme modification", async () => {
  const themeHashBefore = dirHash(themeDir);

  const projectA = makeProject("shared-a");
  const projectB = makeProject("shared-b");
  scaffoldTemplate(projectA, "simple-light", { deckId: "alpha", title: "Project Alpha" });
  scaffoldTemplate(projectB, "stage-table", { deckId: "beta", title: "Project Beta", stages: 5 });

  // Both projects must resolve the Theme through the runtime package subpath.
  for (const [project, deck] of [[projectA, "alpha"], [projectB, "beta"]]) {
    const slidesSource = fs.readFileSync(path.join(project, "decks", deck, "slides.js"), "utf8");
    assert.ok(
      slidesSource.includes("@55aaseclab/lattice-runtime/themes/simple-light"),
      `${deck} must consume the Theme through the runtime subpath`,
    );
    const manifest = JSON.parse(fs.readFileSync(path.join(project, "decks", deck, "manifest.json"), "utf8"));
    assert.equal(manifest.theme, "simple-light");
    const validate = runCli(project, ["validate", "--deck", deck]);
    assert.equal(validate.status, 0, `project deck ${deck} must validate: ${validate.stderr}`);
  }

  // An agent edit loop runs per project while the decks are unlocked…
  const editA = runCli(projectA, [
    "edit", "--deck", "alpha", "--slide", "intro", "--field", "title",
    "--value", '"Alpha Edited"', "--actor", "agent:test",
  ]);
  assert.equal(editA.status, 0, `project A edit must succeed: ${editA.stderr}`);

  // …and freezing both projects still leaves the shared Theme untouched.
  const lockA = runCli(projectA, ["lock", "update", "--deck", "alpha", "--actor", "agent:test"]);
  const lockB = runCli(projectB, ["lock", "update", "--deck", "beta", "--actor", "agent:test"]);
  assert.equal(lockA.status, 0);
  assert.equal(lockB.status, 0);

  assert.equal(dirHash(themeDir), themeHashBefore, "the shared Theme directory must be byte-identical after multi-project use");

  // No project-specific copy bled into the Theme, and no Theme file carries
  // the projects' placeholder copy.
  const themeSources = ["index.js", "styles.css", "palettes.js"]
    .map((file) => fs.readFileSync(path.join(themeDir, file), "utf8"))
    .join("\n");
  for (const marker of ["Project Alpha", "Alpha Edited", "Project Beta", "Stage 01", "stage-cell"]) {
    assert.ok(!themeSources.includes(marker), `shared Theme must not contain project marker "${marker}"`);
  }

  fs.rmSync(projectA, { recursive: true, force: true });
  fs.rmSync(projectB, { recursive: true, force: true });
});
