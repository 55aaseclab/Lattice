import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, symlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { validateVideoPlan } from "@55aaseclab/lattice-runtime/video-plan";
import { computeBundleIdentityHash } from "../src/video/bundle.js";

const cliIndex = fileURLToPath(new URL("../src/index.js", import.meta.url));
const cliRoot = fileURLToPath(new URL("../", import.meta.url));

const sha256 = (label) => createHash("sha256").update(label).digest("hex");

function writeMinimalExportBundle(bundleDir, deckId) {
  mkdirSync(join(bundleDir, "assets"), { recursive: true });
  writeFileSync(join(bundleDir, "index.html"), `<!doctype html><html><head><title>${deckId}</title></head><body><div id="app"></div></body></html>`, "utf8");
  writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify({
    schema: "lattice.deck.v1",
    id: deckId,
    title: `Deck ${deckId}`,
    entry: { content: "./content.json", layout: "./layout.json", notes: "./notes.json" },
  }), "utf8");
  writeFileSync(join(bundleDir, "content.json"), JSON.stringify({ id: deckId, slides: [] }), "utf8");
  writeFileSync(join(bundleDir, "layout.json"), "[]", "utf8");
  writeFileSync(join(bundleDir, "notes.json"), "[]", "utf8");
  return bundleDir;
}

function makeProject({ decks = {}, config = {}, withExportBundle = true, entryFile = "./content.js" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "lattice-video-cli-"));
  writeFileSync(
    join(root, "lattice.config.js"),
    `export default { title: "Fixture", decksDir: "decks", outDir: "dist", theme: "simple-light", ...${JSON.stringify(config)} };\n`,
    "utf8",
  );
  for (const [deckId, deck] of Object.entries(decks)) {
    const deckDir = join(root, "decks", deckId);
    mkdirSync(deckDir, { recursive: true });
    writeFileSync(
      join(deckDir, "manifest.json"),
      JSON.stringify({
        schema: "lattice.deck.v1",
        id: deckId,
        title: deck.title ?? deckId,
        theme: "simple-light",
        entry: { content: entryFile },
      }, null, 2),
      "utf8",
    );
    writeFileSync(join(deckDir, entryFile), deck.content, "utf8");
    if (withExportBundle) {
      // Genuine minimal static-export bundle under the default outDir, so
      // "video plan" can derive a real bundle identity without a full build.
      writeMinimalExportBundle(join(root, "dist", "static-decks", deckId), deckId);
    }
  }
  return root;
}

function runCli(root, args, extraEnv = {}) {
  return spawnSync(process.execPath, [cliIndex, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 60000,
    env: { ...process.env, ...extraEnv },
  });
}

const DESCRIPTOR = {
  routes: { main: ["a", "b"], alt: ["b"] },
  slides: [
    { id: "a", durationFrames: 30 },
    { id: "b", durationFrames: 60 },
  ],
  fps: 30,
  width: 960,
  height: 540,
};

const NAMED_DESCRIPTOR_CONTENT = `export default { title: "Named deck" };\nexport const videoPlan = ${JSON.stringify(DESCRIPTOR)};\n`;
const DEFAULT_DESCRIPTOR_CONTENT = `export default { videoPlan: ${JSON.stringify(DESCRIPTOR)} };\n`;

test("V1 deck without videoPlan descriptor fails fast with guidance", () => {
  const root = makeProject({
    decks: { "v1-deck": { content: `export default { title: "V1 deck" };\n` } },
  });
  try {
    const result = runCli(root, ["video", "plan", "--deck", "v1-deck"]);
    assert.equal(result.status, 1, `expected exit 1, stderr: ${result.stderr}`);
    assert.ok(result.stderr.includes("videoPlan"), "must explain the videoPlan descriptor contract");
    assert.ok(result.stderr.includes("routes"), "guidance must show the routes map contract");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("named videoPlan export works alongside default deck content", () => {
  const root = makeProject({
    decks: { "named-deck": { content: NAMED_DESCRIPTOR_CONTENT } },
  });
  try {
    const out = join(root, "out", "plan.json");
    const result = runCli(root, ["video", "plan", "--deck", "named-deck", "--output", out]);
    assert.equal(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);

    const plan = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(plan.schema, "lattice.video-plan.v1");
    assert.equal(plan.routeId, "main");
    assert.equal(plan.totalFrames, 90);
    for (const key of ["deckHash", "bundleHash", "inputPropsHash"]) {
      assert.match(plan.provenance[key], /^[0-9a-f]{64}$/, `${key} must be a real sha256 digest`);
    }
    assert.ok(result.stdout.includes("plan-hash:"));
    assert.ok(result.stdout.includes("descriptor: named export videoPlan"));

    const validation = validateVideoPlan(plan);
    assert.equal(validation.ok, true, validation.errors?.join("; "));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("default-export videoPlan descriptor works", () => {
  const root = makeProject({
    decks: { "default-deck": { content: DEFAULT_DESCRIPTOR_CONTENT } },
  });
  try {
    const result = runCli(root, ["video", "plan", "--deck", "default-deck"]);
    assert.equal(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.routeId, "main");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("routes map with --route selects the requested route", () => {
  const root = makeProject({
    decks: { "named-deck": { content: NAMED_DESCRIPTOR_CONTENT } },
  });
  try {
    const result = runCli(root, ["video", "plan", "--deck", "named-deck", "--route", "alt"]);
    assert.equal(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.routeId, "alt");
    assert.equal(plan.totalFrames, 60);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unknown route exits 2 with available routes", () => {
  const root = makeProject({
    decks: { "named-deck": { content: NAMED_DESCRIPTOR_CONTENT } },
  });
  try {
    const result = runCli(root, ["video", "plan", "--deck", "named-deck", "--route", "nope"]);
    assert.equal(result.status, 2);
    assert.ok(result.stderr.includes("nope"));
    assert.ok(result.stderr.includes("main"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("zero durationFrames is rejected, not masked by defaults", () => {
  const descriptor = {
    ...DESCRIPTOR,
    slides: [{ id: "a", durationFrames: 0 }],
    routes: { main: ["a"] },
  };
  const root = makeProject({
    decks: { "zero-deck": { content: `export const videoPlan = ${JSON.stringify(descriptor)};\n` } },
  });
  try {
    const result = runCli(root, ["video", "plan", "--deck", "zero-deck"]);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("durationFrames"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("NaN fps is rejected, not masked by defaults", () => {
  const descriptor = { ...DESCRIPTOR, fps: NaN };
  const root = makeProject({
    decks: { "nan-deck": { content: `export const videoPlan = ${JSON.stringify(descriptor).replace('"fps":null', "fps: NaN")};\n` } },
  });
  try {
    const result = runCli(root, ["video", "plan", "--deck", "nan-deck"]);
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes("fps"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("missing fps/width/height apply documented defaults", () => {
  const descriptor = {
    routes: { main: ["a"] },
    slides: [{ id: "a", durationFrames: 30 }],
  };
  const root = makeProject({
    decks: { "defaults-deck": { content: `export const videoPlan = ${JSON.stringify(descriptor)};\n` } },
  });
  try {
    const result = runCli(root, ["video", "plan", "--deck", "defaults-deck"]);
    assert.equal(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.fps, 30);
    assert.equal(plan.width, 960);
    assert.equal(plan.height, 540);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("successful plan run is deterministic (byte-stable) and validates", () => {
  const root = makeProject({
    decks: { "named-deck": { content: NAMED_DESCRIPTOR_CONTENT } },
  });
  try {
    const out1 = join(root, "out", "plan-1.json");
    const out2 = join(root, "out", "plan-2.json");
    const run1 = runCli(root, ["video", "plan", "--deck", "named-deck", "--output", out1]);
    const run2 = runCli(root, ["video", "plan", "--deck", "named-deck", "--output", out2]);
    assert.equal(run1.status, 0);
    assert.equal(run2.status, 0);
    assert.equal(run1.stdout.includes("plan-hash:"), true);
    assert.equal(
      run1.stdout.match(/plan-hash: ([0-9a-f]{64})/)[1],
      run2.stdout.match(/plan-hash: ([0-9a-f]{64})/)[1],
      "plan hash must be deterministic",
    );
    assert.equal(
      readFileSync(out1, "utf8"),
      readFileSync(out2, "utf8"),
      "plan bytes must be byte-stable",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--bundle-dir with a genuine bundle derives the real bundleHash", () => {
  const root = makeProject({
    decks: { "named-deck": { content: NAMED_DESCRIPTOR_CONTENT } },
    withExportBundle: false,
  });
  try {
    // A genuine minimal static-export-shaped bundle at an explicit path.
    const bundleDir = writeMinimalExportBundle(join(root, "explicit-bundle"), "named-deck");
    const out = join(root, "out", "plan.json");

    const result = runCli(root, ["video", "plan", "--deck", "named-deck", "--bundle-dir", bundleDir, "--output", out]);
    assert.equal(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);
    const plan = JSON.parse(readFileSync(out, "utf8"));
    assert.equal(plan.provenance.bundleHash, computeBundleIdentityHash(bundleDir));
    assert.ok(result.stdout.includes("bundle-hash:"), `stdout must report bundle hash: ${result.stdout}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--bundle-dir with a generic html directory fails fast", () => {
  const root = makeProject({
    decks: { "named-deck": { content: NAMED_DESCRIPTOR_CONTENT } },
  });
  try {
    const fakeBundle = join(root, "fake-bundle");
    mkdirSync(fakeBundle, { recursive: true });
    writeFileSync(join(fakeBundle, "index.html"), "<html></html>", "utf8");

    const result = runCli(root, ["video", "plan", "--deck", "named-deck", "--bundle-dir", fakeBundle]);
    assert.equal(result.status, 2);
    assert.ok(result.stderr.includes("manifest.json"), "must name the missing contract file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("placeholder descriptor bundleHash is rejected; real digest is accepted", () => {
  const placeholder = {
    ...DESCRIPTOR,
    bundleHash: "abc123",
    routes: { main: ["a"] },
    slides: [{ id: "a", durationFrames: 30 }],
  };
  const root = makeProject({
    decks: { "placeholder-deck": { content: `export const videoPlan = ${JSON.stringify(placeholder)};\n` } },
  });
  try {
    const result = runCli(root, ["video", "plan", "--deck", "placeholder-deck"]);
    assert.equal(result.status, 2);
    assert.ok(result.stderr.includes("sha256"), "must demand a real sha256 digest");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  const real = {
    ...placeholder,
    bundleHash: sha256("real-bundle-identity"),
  };
  const root2 = makeProject({
    decks: { "real-hash-deck": { content: `export const videoPlan = ${JSON.stringify(real)};\n` } },
  });
  try {
    const result = runCli(root2, ["video", "plan", "--deck", "real-hash-deck"]);
    assert.equal(result.status, 0, `expected exit 0, stderr: ${result.stderr}`);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.provenance.bundleHash, sha256("real-bundle-identity"));
  } finally {
    rmSync(root2, { recursive: true, force: true });
  }
});

test("video plan never initializes a video backend", () => {
  const root = makeProject({
    decks: { "named-deck": { content: NAMED_DESCRIPTOR_CONTENT } },
  });
  try {
    const probeScript = `
      import { pathToFileURL } from "node:url";
      import { join } from "node:path";
      const cliRoot = process.env.LATTICE_PROBE_CLI_ROOT;
      const projectDir = process.env.LATTICE_PROBE_PROJECT;
      process.chdir(projectDir);
      const { videoCommand } = await import(pathToFileURL(join(cliRoot, "src/commands/video.js")));
      const registry = await import(pathToFileURL(join(cliRoot, "src/video/registry.js")));
      await videoCommand({ args: { deck: "named-deck" }, rest: ["plan"] });
      const ids = registry.listBackendIds();
      if (ids.length !== 0) {
        console.error("video plan initialized backends: " + ids.join(", "));
        process.exit(1);
      }
      console.log("no backends initialized");
    `;
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", probeScript], {
      encoding: "utf8",
      timeout: 60000,
      env: {
        ...process.env,
        LATTICE_PROBE_CLI_ROOT: cliRoot,
        LATTICE_PROBE_PROJECT: root,
      },
    });
    assert.equal(result.status, 0, `probe failed: ${result.stderr || result.stdout}`);
    assert.ok(result.stdout.includes("no backends initialized"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("video doctor without --backend exits 2", () => {
  const root = makeProject({});
  try {
    const result = runCli(root, ["video", "doctor"]);
    assert.equal(result.status, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("video doctor with unknown backend exits 2", () => {
  const root = makeProject({});
  try {
    const result = runCli(root, ["video", "doctor", "--backend", "unknown-thing"]);
    assert.equal(result.status, 2);
    assert.ok(result.stderr.includes("unknown backend") || result.stdout.includes("unknown backend"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("video doctor reports unavailable (exit 2) when required backend packages are missing", () => {
  const root = makeProject({});
  try {
    const result = runCli(root, ["video", "doctor", "--backend", "hyperframes"]);
    // hyperframes is not installed in this repository; doctor must say so
    // honestly with exit code 2 instead of pretending success.
    assert.equal(result.status, 2, `expected exit 2, stdout: ${result.stdout}`);
    assert.ok(result.stdout.includes("unavailable"), `stdout must report unavailable status: ${result.stdout}`);
    assert.ok(result.stdout.includes("HyperFrames"), "must name the missing package");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const SINGLE_SLIDE_DESCRIPTOR = {
  routes: { main: ["a"] },
  slides: [{ id: "a", durationFrames: 30 }],
  fps: 30,
  width: 960,
  height: 540,
};

test("deckHash covers the custom manifest-declared entry: editing it changes the hash", () => {
  const root = makeProject({
    decks: { "custom-entry-deck": { content: `export const videoPlan = ${JSON.stringify(SINGLE_SLIDE_DESCRIPTOR)};\n` } },
    entryFile: "./custom-content.js",
  });
  try {
    const out1 = join(root, "out", "plan-1.json");
    const run1 = runCli(root, ["video", "plan", "--deck", "custom-entry-deck", "--output", out1]);
    assert.equal(run1.status, 0, `expected exit 0, stderr: ${run1.stderr}`);
    const plan1 = JSON.parse(readFileSync(out1, "utf8"));
    assert.equal(plan1.totalFrames, 30);

    const edited = {
      ...SINGLE_SLIDE_DESCRIPTOR,
      slides: [{ id: "a", durationFrames: 60 }],
    };
    writeFileSync(
      join(root, "decks", "custom-entry-deck", "custom-content.js"),
      `export const videoPlan = ${JSON.stringify(edited)};\n`,
      "utf8",
    );
    const out2 = join(root, "out", "plan-2.json");
    const run2 = runCli(root, ["video", "plan", "--deck", "custom-entry-deck", "--output", out2]);
    assert.equal(run2.status, 0, `expected exit 0, stderr: ${run2.stderr}`);
    const plan2 = JSON.parse(readFileSync(out2, "utf8"));
    assert.equal(plan2.totalFrames, 60);

    assert.notEqual(
      plan2.provenance.deckHash,
      plan1.provenance.deckHash,
      "editing the custom-named manifest entry must change deckHash",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deckHash covers nested local modules and deck assets: editing either changes the hash", () => {
  const content = [
    `import { helper } from "./lib/helpers.js";`,
    `export const marker = helper;`,
    `export const videoPlan = ${JSON.stringify(SINGLE_SLIDE_DESCRIPTOR)};`,
    "",
  ].join("\n");
  const root = makeProject({
    decks: { "nested-deck": { content } },
  });
  const deckDir = join(root, "decks", "nested-deck");
  try {
    mkdirSync(join(deckDir, "lib"), { recursive: true });
    writeFileSync(join(deckDir, "lib", "helpers.js"), "export const helper = 1;\n", "utf8");
    mkdirSync(join(deckDir, "assets"), { recursive: true });
    writeFileSync(join(deckDir, "assets", "logo.svg"), "<svg></svg>\n", "utf8");

    const out1 = join(root, "out", "plan-1.json");
    const run1 = runCli(root, ["video", "plan", "--deck", "nested-deck", "--output", out1]);
    assert.equal(run1.status, 0, `expected exit 0, stderr: ${run1.stderr}`);
    const hash1 = JSON.parse(readFileSync(out1, "utf8")).provenance.deckHash;

    writeFileSync(join(deckDir, "assets", "logo.svg"), "<svg width='2'></svg>\n", "utf8");
    const out2 = join(root, "out", "plan-2.json");
    const run2 = runCli(root, ["video", "plan", "--deck", "nested-deck", "--output", out2]);
    assert.equal(run2.status, 0, `expected exit 0, stderr: ${run2.stderr}`);
    const hash2 = JSON.parse(readFileSync(out2, "utf8")).provenance.deckHash;
    assert.notEqual(hash2, hash1, "editing a deck-owned asset must change deckHash");

    writeFileSync(join(deckDir, "lib", "helpers.js"), "export const helper = 2;\n", "utf8");
    const out3 = join(root, "out", "plan-3.json");
    const run3 = runCli(root, ["video", "plan", "--deck", "nested-deck", "--output", out3]);
    assert.equal(run3.status, 0, `expected exit 0, stderr: ${run3.stderr}`);
    const hash3 = JSON.parse(readFileSync(out3, "utf8")).provenance.deckHash;
    assert.notEqual(hash3, hash2, "editing a nested local module must change deckHash");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("identical deck sources at different temp paths and creation orders produce the same deckHash", () => {
  const writeDeckTree = (root, deckId, reverse) => {
    const deckDir = join(root, "decks", deckId);
    mkdirSync(deckDir, { recursive: true });
    const files = [
      ["manifest.json", JSON.stringify({
        schema: "lattice.deck.v1",
        id: deckId,
        title: deckId,
        theme: "simple-light",
        entry: { content: "./content.js" },
      }, null, 2)],
      ["content.js", `export const videoPlan = ${JSON.stringify(SINGLE_SLIDE_DESCRIPTOR)};\n`],
      ["lib/helpers.js", "export const helper = 1;\n"],
      ["assets/logo.svg", "<svg></svg>\n"],
    ];
    for (const [rel, data] of reverse ? [...files].reverse() : files) {
      mkdirSync(join(deckDir, dirname(rel)), { recursive: true });
      writeFileSync(join(deckDir, rel), data, "utf8");
    }
    writeMinimalExportBundle(join(root, "dist", "static-decks", deckId), deckId);
    writeFileSync(
      join(root, "lattice.config.js"),
      `export default { title: "Fixture", decksDir: "decks", outDir: "dist", theme: "simple-light" };\n`,
      "utf8",
    );
  };

  const rootA = mkdtempSync(join(tmpdir(), "lattice-hash-a-"));
  const rootB = mkdtempSync(join(tmpdir(), "lattice-hash-b-"));
  try {
    writeDeckTree(rootA, "same-deck", false);
    writeDeckTree(rootB, "same-deck", true);

    const runA = runCli(rootA, ["video", "plan", "--deck", "same-deck"]);
    const runB = runCli(rootB, ["video", "plan", "--deck", "same-deck"]);
    assert.equal(runA.status, 0, `expected exit 0, stderr: ${runA.stderr}`);
    assert.equal(runB.status, 0, `expected exit 0, stderr: ${runB.stderr}`);
    const hashA = JSON.parse(runA.stdout).provenance.deckHash;
    const hashB = JSON.parse(runB.stdout).provenance.deckHash;
    assert.equal(hashA, hashB, "identical source trees must hash identically regardless of absolute path or creation order");
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test("symlinks in the deck source tree fail fast with a clear diagnostic (no silent omission or escape)", () => {
  const root = makeProject({
    decks: { "symlink-deck": { content: NAMED_DESCRIPTOR_CONTENT } },
  });
  const deckDir = join(root, "decks", "symlink-deck");
  try {
    writeFileSync(join(root, "outside-secret.js"), "export const leak = true;\n", "utf8");
    symlinkSync(join(root, "outside-secret.js"), join(deckDir, "leak.js"));

    const out1 = join(root, "out", "plan-1.json");
    const result = runCli(root, ["video", "plan", "--deck", "symlink-deck", "--output", out1]);
    assert.equal(result.status, 2, `expected exit 2, stderr: ${result.stderr}`);
    assert.ok(result.stderr.includes("symlink"), "diagnostic must name the symlink policy");
    assert.ok(result.stderr.includes("leak.js"), "diagnostic must name the offending entry");
    assert.equal(existsSync(out1), false, "must fail before writing a plan");

    rmSync(join(deckDir, "leak.js"));
    symlinkSync(deckDir, join(deckDir, "loop"));
    const result2 = runCli(root, ["video", "plan", "--deck", "symlink-deck"]);
    assert.equal(result2.status, 2, `expected exit 2 for cyclic symlink, stderr: ${result2.stderr}`);
    assert.ok(result2.stderr.includes("symlink"), "cycle diagnostic must name the symlink policy");
    assert.ok(result2.stderr.includes("loop"), "cycle diagnostic must name the offending entry");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
