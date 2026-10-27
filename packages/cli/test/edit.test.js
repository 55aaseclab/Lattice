// M6 — Prompt-driven authoring: `lattice edit` targeted edits with the
// Content Lock gate, dry-run, provenance, and rollback.
//
// Fixtures are scaffolded into gitignored test/tmp directories; every CLI
// run is a real subprocess so exit codes, JSON output, and zero-write
// guarantees are the actual machine-consumable contract.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { createRequire } from "node:module";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const cliRoot = path.resolve(testDir, "..");
const runtimeRoot = path.resolve(cliRoot, "..", "runtime");
const binPath = path.join(cliRoot, "src", "index.js");
// Fixture projects live in the OS temp dir (outside the repo) so the test
// runner never discovers their deck sources as test files.
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-edit-tests-"));

const { createProjectModuleLoader } = await import("../src/deck-v2/project-module-loader.js");
const { scaffoldTemplate } = await import("./helpers/scaffold-project.js");

const RUNTIME_DEP = process.env.LATTICE_TEST_RUNTIME_DEP ?? runtimeRoot;

function makeProject(name) {
  const projectDir = fs.mkdtempSync(path.join(tmpRoot, `lattice-edit-${name}-`));
  fs.writeFileSync(
    path.join(projectDir, "lattice.config.js"),
    'export default {\n  title: "Edit Test",\n  registry: null,\n};\n',
    "utf8",
  );
  scaffoldTemplate(projectDir, "simple-light", { deckId: "loop-deck", title: "Loop Deck" }, { runtimeRoot: RUNTIME_DEP });
  return projectDir;
}

function runCli(cwd, cliArgs) {
  return spawnSync(process.execPath, [binPath, ...cliArgs], { cwd, encoding: "utf8", timeout: 300000 });
}

function readJsonOutput(result, stream) {
  const text = (stream === "stderr" ? result.stderr : result.stdout).trim();
  const start = text.indexOf("{");
  assert.ok(start >= 0, `expected JSON output, got: ${text}`);
  return JSON.parse(text.slice(start));
}

function treeState(root) {
  const entries = {};
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full);
      } else {
        entries[path.relative(root, full).split(path.sep).join("/")] = fs.readFileSync(full).toString("base64");
      }
    }
  };
  walk(root);
  return entries;
}

const shared = {};
test.before(async () => {
  shared.project = makeProject("main");
  // Freeze the scaffolded deck once, so the gate is active for the whole file.
  const lock = runCli(shared.project, ["lock", "update", "--deck", "loop-deck", "--actor", "test", "--timestamp", "2026-10-27T00:00:00.000Z"]);
  assert.equal(lock.status, 0, `lock update must succeed: ${lock.stderr}`);
  shared.lockRecord = JSON.parse(fs.readFileSync(path.join(shared.project, ".lattice", "content-locks", "loop-deck.json"), "utf8"));
  shared.stateAfterFreeze = treeState(shared.project);
});

// ---- Gate: locked decks refuse content-changing edits with zero writes ----

test("edit on a content-locked deck is rejected with exit 1 and zero writes", () => {
  const result = runCli(shared.project, [
    "edit", "--deck", "loop-deck", "--slide", "intro", "--field", "title",
    "--value", '"Gate Rejected Title"', "--actor", "agent:test",
  ]);
  assert.equal(result.status, 1, `expected exit 1, got ${result.status}: ${result.stdout}`);
  const error = readJsonOutput(result, "stderr");
  assert.equal(error.error.code, "content-lock-gate-rejected");
  assert.deepEqual(error.error.diffs, ["contentHash"]);
  assert.equal(error.zeroWrites, true);
  assert.deepEqual(treeState(shared.project), shared.stateAfterFreeze, "a rejected edit must not change a single byte");
});

test("dry-run on a content-locked deck is refused (exit 1) with zero writes", () => {
  const result = runCli(shared.project, [
    "edit", "--deck", "loop-deck", "--slide", "intro", "--field", "title",
    "--value", '"Gate Rejected Title"', "--dry-run",
  ]);
  assert.equal(result.status, 1);
  const error = readJsonOutput(result, "stderr");
  assert.equal(error.error.code, "content-lock-gate-rejected");
  assert.equal(error.dryRun, true);
  assert.equal(error.zeroWrites, true);
  assert.deepEqual(treeState(shared.project), shared.stateAfterFreeze);
});

test("an edit on a deck that already drifted from its lock is refused (fail-closed)", () => {
  const drift = makeProject("drift");
  const driftDeckContent = path.join(drift, "decks", "loop-deck", "content.js");
  const driftLock = runCli(drift, ["lock", "update", "--deck", "loop-deck", "--actor", "test"]);
  assert.equal(driftLock.status, 0);
  // Simulate out-of-band drift by hand-editing the source after freezing.
  fs.writeFileSync(driftDeckContent, fs.readFileSync(driftDeckContent, "utf8").replace("Deck Title Goes Here", "Hand Drift"), "utf8");
  const result = runCli(drift, [
    "edit", "--deck", "loop-deck", "--slide", "intro", "--field", "title",
    "--value", '"Also Drifted"',
  ]);
  assert.equal(result.status, 1);
  const error = readJsonOutput(result, "stderr");
  assert.equal(error.error.code, "deck-drifted-from-lock");
  fs.rmSync(drift, { recursive: true, force: true });
});

// ---- Unlocked fixture: full edit → validate → lock verify convergence ----

test("edit on an unlocked deck applies a minimal source edit, runs the gate loop, and writes provenance", () => {
  const project = makeProject("apply");
  const contentFile = path.join(project, "decks", "loop-deck", "content.js");
  const beforeBytes = fs.readFileSync(contentFile);
  const result = runCli(project, [
    "edit", "--deck", "loop-deck", "--slide", "intro", "--field", "title",
    "--value", '"Edited Title"', "--actor", "agent:test",
    "--timestamp", "2026-10-27T01:02:03.000Z", "--reason", "loop demonstration",
  ]);
  assert.equal(result.status, 0, `edit must succeed: ${result.stderr}`);
  const report = readJsonOutput(result, "stdout");
  assert.equal(report.ok, true);
  assert.equal(report.dryRun, false);
  assert.equal(report.sourceMap.file, "decks/loop-deck/content.js");
  assert.equal(report.sourceMap.target.fieldPath, "title");
  assert.ok(report.sourceMap.target.byteRange.end > report.sourceMap.target.byteRange.start);
  assert.equal(report.sourceMap.target.line, 5, "the replaced value must be located on the slide title line");
  assert.equal(report.gate.contentLock.mode, "absent");
  assert.equal(report.gate.validate.pass, true);
  assert.match(fs.readFileSync(contentFile, "utf8"), /title: "Edited Title"/);

  // Provenance record: who/when/input hash/output hash/source map.
  assert.equal(report.provenance.schema, "lattice.provenance.v1");
  const provenancePath = path.join(project, report.provenance.path);
  assert.ok(fs.existsSync(provenancePath), `provenance record must exist at ${provenancePath}`);
  const record = JSON.parse(fs.readFileSync(provenancePath, "utf8"));
  assert.equal(record.schema, "lattice.provenance.v1");
  assert.equal(record.actor, "agent:test");
  assert.equal(record.when, "2026-10-27T01:02:03.000Z");
  assert.equal(record.deck, "loop-deck");
  assert.equal(record.slide, "intro");
  assert.equal(record.field, "title");
  assert.equal(record.inputs.sha256, report.inputs.sha256);
  assert.equal(record.outputs.sha256, report.outputs.sha256);
  assert.notEqual(record.inputs.sha256, record.outputs.sha256);
  assert.deepEqual(record.sourceMap.target.byteRange, report.sourceMap.target.byteRange);
  assert.equal(record.command, "edit");

  // The convergence loop is machine-consumable end to end.
  const lockUpdate = runCli(project, ["lock", "update", "--deck", "loop-deck", "--actor", "agent:test"]);
  assert.equal(lockUpdate.status, 0);
  const lockVerify = runCli(project, ["lock", "verify", "--deck", "loop-deck"]);
  assert.equal(lockVerify.status, 0);
  const verifyReport = readJsonOutput(lockVerify, "stdout");
  assert.equal(verifyReport.decks[0].status, "ok");
  const validate = runCli(project, ["validate", "--deck", "loop-deck"]);
  assert.equal(validate.status, 0);

  // Once the lock exists, the same style of edit is refused.
  const rejected = runCli(project, [
    "edit", "--deck", "loop-deck", "--slide", "overview", "--field", "body",
    "--value", '"New body"',
  ]);
  assert.equal(rejected.status, 1);
  fs.rmSync(project, { recursive: true, force: true });
  assert.ok(beforeBytes.length > 0);
});

test("dry-run on an unlocked deck resolves and gates the edit without writing anything", () => {
  const project = makeProject("dryrun");
  const before = treeState(project);
  const result = runCli(project, [
    "edit", "--deck", "loop-deck", "--slide", "intro", "--field", "subtitle",
    "--value", '"Dry-run subtitle"', "--dry-run", "--timestamp", "2026-10-27T01:02:03.000Z",
  ]);
  assert.equal(result.status, 0, `dry-run must succeed: ${result.stderr}`);
  const report = readJsonOutput(result, "stdout");
  assert.equal(report.dryRun, true);
  assert.equal(report.gate.validate, undefined, "dry-run must not run the post-write loop");
  assert.deepEqual(report.wouldWrite, ["decks/loop-deck/content.js"]);
  assert.deepEqual(treeState(project), before, "dry-run must not write a single byte");
  fs.rmSync(project, { recursive: true, force: true });
});

test("a nested array-index field path is supported (stages.1.title style)", () => {
  const project = makeProject("nested");
  scaffoldTemplate(project, "stage-table", { deckId: "stage-deck", title: "Stage Deck", stages: 3 }, { runtimeRoot: RUNTIME_DEP });
  const result = runCli(project, [
    "edit", "--deck", "stage-deck", "--slide", "stages", "--field", "stages.1.title",
    "--value", '"Renamed second stage"', "--actor", "agent:test",
  ]);
  assert.equal(result.status, 0, `nested edit must succeed: ${result.stderr}`);
  const content = fs.readFileSync(path.join(project, "decks", "stage-deck", "content.js"), "utf8");
  assert.match(content, /"title": "Renamed second stage"/);
  assert.doesNotMatch(content, /"title": "Second stage"/);
  fs.rmSync(project, { recursive: true, force: true });
});

test("no-op edits, unknown slides/fields, and invalid values fail fast with zero writes", () => {
  const project = makeProject("failfast");
  const before = treeState(project);

  const noOp = runCli(project, [
    "edit", "--deck", "loop-deck", "--slide", "intro", "--field", "title",
    "--value", '"Deck Title Goes Here"',
  ]);
  assert.equal(noOp.status, 1);
  assert.equal(readJsonOutput(noOp, "stderr").error.code, "no-op-edit");

  const noSlide = runCli(project, [
    "edit", "--deck", "loop-deck", "--slide", "missing", "--field", "title", "--value", '"x"',
  ]);
  assert.equal(noSlide.status, 1);
  assert.equal(readJsonOutput(noSlide, "stderr").error.code, "slide-not-found");

  const noField = runCli(project, [
    "edit", "--deck", "loop-deck", "--slide", "intro", "--field", "nonexistent", "--value", '"x"',
  ]);
  assert.equal(noField.status, 1);
  assert.equal(readJsonOutput(noField, "stderr").error.code, "field-not-found");

  const outOfRange = runCli(project, [
    "edit", "--deck", "loop-deck", "--slide", "intro", "--field", "slides.9.title", "--value", '"x"',
  ]);
  assert.equal(outOfRange.status, 1);

  const badValue = runCli(project, [
    "edit", "--deck", "loop-deck", "--slide", "intro", "--field", "title", "--value", "not-json",
  ]);
  assert.equal(badValue.status, 1);
  assert.equal(readJsonOutput(badValue, "stderr").error.code, "invalid-value");

  const missingArgs = runCli(project, ["edit", "--deck", "loop-deck"]);
  assert.equal(missingArgs.status, 2);
  assert.equal(readJsonOutput(missingArgs, "stderr").error.code, "missing-argument");

  assert.deepEqual(treeState(project), before, "failed edits must not write anything");
  fs.rmSync(project, { recursive: true, force: true });
});

test("ambiguous slide ids and duplicate keys are refused, never silently resolved", () => {
  const project = makeProject("ambiguous");
  const contentFile = path.join(project, "decks", "loop-deck", "content.js");
  fs.writeFileSync(
    contentFile,
    `export default {
  slides: [
    { id: "dup", title: "One" },
  ],
  extras: [
    { id: "dup", title: "Two" },
  ],
};
`,
    "utf8",
  );
  const result = runCli(project, [
    "edit", "--deck", "loop-deck", "--slide", "dup", "--field", "title", "--value", '"x"',
  ]);
  assert.equal(result.status, 1);
  assert.equal(readJsonOutput(result, "stderr").error.code, "slide-ambiguous");
  fs.rmSync(project, { recursive: true, force: true });
});

test("a post-write verification failure rolls the source back byte-exact", () => {
  const project = makeProject("rollback");
  const contentFile = path.join(project, "decks", "loop-deck", "content.js");
  const slidesFile = path.join(project, "decks", "loop-deck", "slides.js");
  const beforeBytes = fs.readFileSync(contentFile);
  // Tripwire: buildSlides explodes when the title carries the marked value.
  fs.writeFileSync(
    slidesFile,
    fs.readFileSync(slidesFile, "utf8").replace(
      "export function buildSlides() {",
      'export function buildSlides() {\n  if (content.slides.some((slide) => slide.title === "BOOM")) { throw new Error("fixture: tripwire"); }',
    ),
    "utf8",
  );
  const result = runCli(project, [
    "edit", "--deck", "loop-deck", "--slide", "intro", "--field", "title",
    "--value", '"BOOM"', "--actor", "agent:test",
  ]);
  assert.equal(result.status, 1);
  const error = readJsonOutput(result, "stderr");
  assert.equal(error.rolledBack, true);
  assert.equal(error.error.code, "post-verify-failed");
  assert.ok(Buffer.compare(beforeBytes, fs.readFileSync(contentFile)) === 0, "rollback must restore the original bytes exactly");
  fs.rmSync(project, { recursive: true, force: true });
});

test("edit works on the keyed content shape (slide id as root key) and still gates", () => {
  const project = makeProject("keyed");
  const deckDir = path.join(project, "decks", "loop-deck");
  fs.writeFileSync(
    path.join(deckDir, "content.js"),
    `export default {
  intro: {
    title: "Keyed Deck",
    subtitle: "Slides keyed by id",
  },
  wrap: {
    title: "Closing",
  },
};
`,
    "utf8",
  );
  // The keyed deck must stay internally coherent: buildSlides reads the keyed
  // content shape, not content.slides.
  fs.writeFileSync(
    path.join(deckDir, "slides.js"),
    `import { simpleLightLayouts } from "@55aaseclab/lattice-runtime/themes/simple-light";
import content from "./content.js";
import notes from "./notes.js";

export function buildSlides() {
  return [
    simpleLightLayouts.titleSlide({
      title: content.intro.title,
      subtitle: content.intro.subtitle,
    }),
    simpleLightLayouts.mainPoint({
      title: content.wrap.title,
    }),
  ];
}
`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(deckDir, "slides.v2.js"),
    `import { buildSlides } from "./slides.js";

const SLIDE_IDS = ["intro", "wrap"];

const STATIC_TIMING = Object.freeze({
  durationFrames: 1,
  stops: Object.freeze([{ id: "static", frame: 0, navigation: "jump" }]),
});

const outputs = buildSlides();

export const slideDefinitions = outputs.map((html, index) => ({
  id: SLIDE_IDS[index],
  html,
  durationFrames: STATIC_TIMING.durationFrames,
  stops: STATIC_TIMING.stops.map((stop) => ({ ...stop })),
}));
`,
    "utf8",
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(deckDir, "manifest.json"), "utf8"));
  manifest.routes = { main: ["intro", "wrap"] };
  fs.writeFileSync(path.join(deckDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  const result = runCli(project, [
    "edit", "--deck", "loop-deck", "--slide", "intro", "--field", "title",
    "--value", '"Keyed Edited"', "--actor", "agent:test",
  ]);
  assert.equal(result.status, 0, `keyed edit must succeed: ${result.stderr}`);
  assert.match(fs.readFileSync(path.join(deckDir, "content.js"), "utf8"), /title: "Keyed Edited"/);

  const lockUpdate = runCli(project, ["lock", "update", "--deck", "loop-deck", "--actor", "agent:test"]);
  assert.equal(lockUpdate.status, 0);
  const gate = runCli(project, [
    "edit", "--deck", "loop-deck", "--slide", "intro", "--field", "subtitle",
    "--value", '"Mutated"',
  ]);
  assert.equal(gate.status, 1);
  assert.equal(readJsonOutput(gate, "stderr").error.code, "content-lock-gate-rejected");
  fs.rmSync(project, { recursive: true, force: true });
});

test("the edit command documents its contract in --help", () => {
  const result = runCli(shared.project, ["edit", "--help"]);
  assert.equal(result.status, 0);
  for (const marker of [
    "--dry-run",
    "provenance",
    "Content Lock",
    "byte",
    "exit",
  ]) {
    assert.ok(result.stdout.includes(marker), `--help must document "${marker}"`);
  }
});

test("v2 enforcement: a v1 deck is refused with migration guidance", () => {
  const project = makeProject("v1");
  const deckDir = path.join(project, "decks", "v1-deck");
  fs.mkdirSync(deckDir, { recursive: true });
  fs.writeFileSync(path.join(deckDir, "manifest.json"), JSON.stringify({
    schema: "lattice.deck.v1",
    id: "v1-deck",
    title: "V1",
    owner: "t",
    presenter: "T",
    runtime: "^0.2.0",
    theme: "simple-light",
    entry: { content: "./content.js" },
  }, null, 2));
  fs.writeFileSync(path.join(deckDir, "content.js"), 'export default { slides: [{ id: "a", title: "A" }] };\n', "utf8");
  const result = runCli(project, ["edit", "--deck", "v1-deck", "--slide", "a", "--field", "title", "--value", '"x"']);
  assert.equal(result.status, 1);
  const error = readJsonOutput(result, "stderr");
  assert.equal(error.error.code, "deck-not-v2");
  assert.match(error.error.message, /lattice migrate/);
  fs.rmSync(project, { recursive: true, force: true });
});

// ---- Source-map scanner unit coverage (in-process) ----

test("source-map scanner locates values, arrays, calls, and template literals exactly", async () => {
  const { scanSource, findSlideObject, locateFieldPath, buildPatch, serializeJsValue, lineIndentation, jsonValuesEqual } = await import("../src/edit/source-map.js");
  const source = `export default {
  slides: [
    {
      id: "intro",
      title: "First slide",
      meta: { tags: ["a", "b"], deep: { n: 42 } },
    },
    {
      id: "chart",
      points: [
        { at: 1, label: "one" },
        { at: 2, label: "two" },
      ],
      ratio: 3.5,
      fn: Math.max(1, 2),
      tpl: \`x=\${1 + 2} y\`,
      quoted: {
        "kicker": "Stage 01",
        "title": "First stage",
      },
    },
  ],
};
`;
  const records = scanSource(source);
  const intro = findSlideObject(source, records, "intro");
  const title = locateFieldPath(source, records, intro.record, "title");
  assert.equal(source.slice(title.valueStart, title.valueEnd), '"First slide"');
  const deep = locateFieldPath(source, records, intro.record, "meta.deep.n");
  assert.equal(source.slice(deep.valueStart, deep.valueEnd), "42");
  const chart = findSlideObject(source, records, "chart");
  const label = locateFieldPath(source, records, chart.record, "points.1.label");
  assert.equal(source.slice(label.valueStart, label.valueEnd), '"two"');
  const fn = locateFieldPath(source, records, chart.record, "fn");
  assert.equal(source.slice(fn.valueStart, fn.valueEnd), "Math.max(1, 2)");
  const tpl = locateFieldPath(source, records, chart.record, "tpl");
  assert.equal(source.slice(tpl.valueStart, tpl.valueEnd), "`x=${1 + 2} y`");
  const quoted = locateFieldPath(source, records, chart.record, "quoted.title");
  assert.equal(source.slice(quoted.valueStart, quoted.valueEnd), '"First stage"');

  const patch = buildPatch(source, deep, serializeJsValue(43, lineIndentation(source, deep.keyStart)));
  assert.ok(patch.patched.includes("n: 43"));
  assert.deepEqual(patch.span.byteRange, { start: patch.span.charRange.start, end: patch.span.charRange.end });
  assert.ok(jsonValuesEqual({ b: 2, a: 1 }, { a: 1, b: 2 }));
  assert.equal(jsonValuesEqual({ a: 1 }, { a: 2 }), false);

  assert.throws(() => findSlideObject(source, records, "nope"), /slide-not-found|no object literal/);
});

test("project module loader used by the gate writes nothing into the project", async () => {
  const project = makeProject("loader");
  const before = treeState(project);
  const loader = await createProjectModuleLoader(project);
  try {
    const module = await loader.load(path.join(project, "decks", "loop-deck", "content.js"));
    assert.equal(module.default.slides.length, 3);
  } finally {
    await loader.close();
  }
  assert.deepEqual(treeState(project), before);
});
