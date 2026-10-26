import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { computeContentFingerprint, verifyContentLock } from "@55aaseclab/lattice-runtime/content-lock";

const cliIndex = fileURLToPath(new URL("../src/index.js", import.meta.url));

const SLIDE_IDS = ["intro", "chart", "closing"];

function buildSlidesMarkup() {
  return [
    `<section class="slide-canvas" data-slide-number="1"><div class="sl-grid"><h1 data-lattice-id="intro-title">Intro</h1></div></section>`,
    `<section class="slide-canvas" data-slide-number="2"><div class="sl-grid"><svg data-lattice-id="chart-svg" viewBox="0 0 10 10"></svg></div></section>`,
    `<section class="slide-canvas" data-slide-number="3"><div class="sl-grid"><p data-lattice-id="closing-copy">Closing</p></div></section>`,
  ];
}

function writeFixture(root, { withLock = true } = {}) {
  const deckDir = join(root, "decks", "mig-deck");
  mkdirSync(join(deckDir, "assets"), { recursive: true });
  mkdirSync(join(root, "decks"), { recursive: true });
  writeFileSync(
    join(root, "lattice.config.js"),
    `export default { title: "Migrate Fixture", decksDir: "decks", outDir: "dist", registry: "./decks/registry.js", theme: "simple-light", dev: { port: 0, host: "127.0.0.1" } };\n`,
    "utf8",
  );
  writeFileSync(
    join(root, "decks", "registry.js"),
    `const slides = ${JSON.stringify(buildSlidesMarkup())};\n` +
    `export const deckRegistry = {\n` +
    `  "mig-deck": { id: "mig-deck", title: "Migrate Fixture Deck", owner: "fixture-owner", presenter: "Fixture Presenter", description: "v1 to v2 migration fixture", buildSlides: () => slides },\n` +
    `};\n`,
    "utf8",
  );
  const manifest = {
    schema: "lattice.deck.v1",
    id: "mig-deck",
    title: "Migrate Fixture Deck",
    owner: "fixture-owner",
    presenter: "Fixture Presenter",
    runtime: "^0.2.0",
    theme: "simple-light",
    entry: { content: "./content.js", layout: "./layout.js", notes: "./notes.js" },
    assets: "./assets/",
  };
  writeFileSync(join(deckDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(join(deckDir, "content.js"), `export default { intro: { title: "Intro" }, chart: {}, closing: {} };\n`, "utf8");
  writeFileSync(join(deckDir, "layout.js"), `export default { slides: [] };\n`, "utf8");
  writeFileSync(join(deckDir, "notes.js"), `export default { intro: "Say hello.", closing: "Say goodbye." };\n`, "utf8");
  writeFileSync(
    join(deckDir, "slides.js"),
    `import content from "./content.js";\nimport notes from "./notes.js";\nconst slides = ${JSON.stringify(buildSlidesMarkup())};\nexport function buildSlides() { return slides; }\nvoid content; void notes;\n`,
    "utf8",
  );

  if (withLock) {
    const contentMod = { intro: { title: "Intro" }, chart: {}, closing: {} };
    const notesMod = { intro: "Say hello.", closing: "Say goodbye." };
    const fingerprint = computeContentFingerprint(contentMod, manifest, notesMod, buildSlidesMarkup());
    mkdirSync(join(root, ".lattice", "content-locks"), { recursive: true });
    writeFileSync(
      join(root, ".lattice", "content-locks", "mig-deck.json"),
      `${JSON.stringify({ schema: "lattice.content-lock.v4", deckId: "mig-deck", createdAt: "2026-10-26T00:00:00.000Z", fingerprint }, null, 2)}\n`,
      "utf8",
    );
  }
  return manifest;
}

function snapshotTree(root) {
  const files = {};
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[full.slice(root.length + 1)] = readFileSync(full);
    }
  };
  walk(root);
  return files;
}

function makeProject({ withLock } = {}) {
  const root = mkdtempSync(join(tmpdir(), "lattice-migrate-"));
  writeFixture(root, { withLock });
  return root;
}

function runCli(root, args) {
  return spawnSync(process.execPath, [cliIndex, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 120000,
    env: process.env,
  });
}

test("migrate --dry-run verifies and writes nothing", () => {
  const root = makeProject();
  try {
    const before = snapshotTree(root);
    const result = runCli(root, ["migrate", "--deck", "mig-deck", ...SLIDE_IDS.flatMap((id) => ["--slide", id]), "--dry-run"]);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes("dry run"));
    assert.ok(result.stdout.includes("lattice.migration-report.v1"));
    assert.deepEqual(snapshotTree(root), before, "dry run must not write any file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrate writes the v2 manifest, slide entry, and report; deck then validates and plans as v2", async () => {
  const root = makeProject();
  try {
    const result = runCli(root, ["migrate", "--deck", "mig-deck", ...SLIDE_IDS.flatMap((id) => ["--slide", id])]);
    assert.equal(result.status, 0, `stderr: ${result.stderr}`);
    assert.ok(result.stdout.includes("VERIFY OK"), `content lock must verify: ${result.stdout}`);

    const manifest = JSON.parse(readFileSync(join(root, "decks/mig-deck/manifest.json"), "utf8"));
    assert.equal(manifest.schema, "lattice.deck.v2");
    assert.deepEqual(manifest.routes, { main: SLIDE_IDS });
    assert.deepEqual(manifest.canvas, { width: 960, height: 540 });
    assert.equal(manifest.fps, 30);
    assert.deepEqual(manifest.publication, { audience: "private" });
    assert.equal(manifest.entry.slides, "./slides.v2.js");

    const report = JSON.parse(readFileSync(join(root, ".lattice/migration/mig-deck.json"), "utf8"));
    assert.equal(report.reportSchema, "lattice.migration-report.v1");
    assert.deepEqual(report.slideIds, SLIDE_IDS);
    assert.equal(report.slideDigests.length, 3);
    assert.deepEqual(report.contentIdentityManifest.schema, "lattice.deck.v1");

    const slidesModule = readFileSync(join(root, "decks/mig-deck/slides.v2.js"), "utf8");
    assert.ok(slidesModule.includes("export const slideDefinitions"));

    const validate = runCli(root, ["validate", "--deck", "mig-deck"]);
    assert.equal(validate.status, 0, `v2 validate failed: ${validate.stderr}`);

    // Slide html must be byte-for-byte the buildSlides() output.
    const loaded = await import(`${"file://" + join(root, "decks/mig-deck/slides.v2.js")}`);
    assert.deepEqual(loaded.slideDefinitions.map((slide) => slide.html), buildSlidesMarkup());
    assert.deepEqual(loaded.slideDefinitions.map((slide) => slide.id), SLIDE_IDS);
    for (const slide of loaded.slideDefinitions) {
      assert.deepEqual(slide.durationFrames, 1);
      assert.deepEqual(slide.stops, [{ id: "static", frame: 0, navigation: "jump" }]);
    }

    // VideoPlan compiles from the v2 manifest + slide definitions.
    mkdirSync(join(root, "dist", "static-decks", "mig-deck", "assets"), { recursive: true });
    writeFileSync(join(root, "dist/static-decks/mig-deck/index.html"), "<!doctype html><html><body><div id=app></div></body></html>", "utf8");
    writeFileSync(join(root, "dist/static-decks/mig-deck/manifest.json"), JSON.stringify({
      schema: "lattice.deck.v2", id: "mig-deck", title: "Migrate Fixture Deck",
      entry: { content: "./content.json", layout: "./layout.json", notes: "./notes.json" },
    }), "utf8");
    writeFileSync(join(root, "dist/static-decks/mig-deck/content.json"), "{}", "utf8");
    writeFileSync(join(root, "dist/static-decks/mig-deck/layout.json"), "[]", "utf8");
    writeFileSync(join(root, "dist/static-decks/mig-deck/notes.json"), "[]", "utf8");
    const plan = runCli(root, ["video", "plan", "--deck", "mig-deck", "--output", join(root, "plan.json")]);
    assert.equal(plan.status, 0, `video plan failed: ${plan.stderr}`);
    const planJson = JSON.parse(readFileSync(join(root, "plan.json"), "utf8"));
    assert.equal(planJson.deckId, "mig-deck");
    assert.equal(planJson.fps, 30);
    assert.equal(planJson.totalFrames, 3);
    assert.deepEqual(planJson.clips.map((clip) => clip.slideId), SLIDE_IDS);
    assert.ok(!JSON.stringify(planJson).includes("remotion"));
    assert.ok(!JSON.stringify(planJson).includes("hyperframes"));
    assert.ok(!JSON.stringify(planJson).includes("seconds"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrate is idempotent: a second run is a no-op with zero writes", () => {
  const root = makeProject();
  try {
    const first = runCli(root, ["migrate", "--deck", "mig-deck", ...SLIDE_IDS.flatMap((id) => ["--slide", id])]);
    assert.equal(first.status, 0, first.stderr);
    const afterFirst = snapshotTree(root);
    const second = runCli(root, ["migrate", "--deck", "mig-deck", ...SLIDE_IDS.flatMap((id) => ["--slide", id])]);
    assert.equal(second.status, 0, second.stderr);
    assert.ok(second.stdout.includes("no-op"));
    assert.deepEqual(snapshotTree(root), afterFirst, "second run must not change any byte");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrate is deterministic across identical sources", () => {
  const rootA = makeProject();
  const rootB = makeProject();
  try {
    const runA = runCli(rootA, ["migrate", "--deck", "mig-deck", ...SLIDE_IDS.flatMap((id) => ["--slide", id])]);
    const runB = runCli(rootB, ["migrate", "--deck", "mig-deck", ...SLIDE_IDS.flatMap((id) => ["--slide", id])]);
    assert.equal(runA.status, 0, runA.stderr);
    assert.equal(runB.status, 0, runB.stderr);
    for (const rel of ["decks/mig-deck/manifest.json", "decks/mig-deck/slides.v2.js", ".lattice/migration/mig-deck.json"]) {
      assert.deepEqual(
        readFileSync(join(rootA, rel)),
        readFileSync(join(rootB, rel)),
        `${rel} must be byte-identical across runs`,
      );
    }
  } finally {
    rmSync(rootA, { recursive: true, force: true });
    rmSync(rootB, { recursive: true, force: true });
  }
});

test("migrate fails fast on slide-id count mismatch without writing", () => {
  const root = makeProject();
  try {
    const before = snapshotTree(root);
    const result = runCli(root, ["migrate", "--deck", "mig-deck", "--slide", "intro", "--slide", "chart"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not match buildSlides\(\) output count/);
    assert.deepEqual(snapshotTree(root), before, "failed migration must not write");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrate fails fast on an invalid v1 manifest and requires an explicit slide order", () => {
  const root = makeProject();
  try {
    const manifestPath = join(root, "decks/mig-deck/manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    delete manifest.presenter;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    const result = runCli(root, ["migrate", "--deck", "mig-deck", "--slide", "intro", "--slide", "chart", "--slide", "closing"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /v1 manifest is invalid/);

    const healthy = makeProject({ withLock: false });
    try {
      const noOrder = runCli(healthy, ["migrate", "--deck", "mig-deck"]);
      assert.equal(noOrder.status, 1);
      assert.match(noOrder.stderr, /no slide order provided/);
    } finally {
      rmSync(healthy, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrate refuses to run when the pre-migration content lock does not verify", () => {
  const root = makeProject();
  try {
    const lockPath = join(root, ".lattice/content-locks/mig-deck.json");
    const lock = JSON.parse(readFileSync(lockPath, "utf8"));
    lock.fingerprint.compositeHash = "0".repeat(64);
    writeFileSync(lockPath, JSON.stringify(lock, null, 2), "utf8");
    const result = runCli(root, ["migrate", "--deck", "mig-deck", ...SLIDE_IDS.flatMap((id) => ["--slide", id])]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /does not verify before migration/);
    assert.equal(existsSync(join(root, "decks/mig-deck/slides.v2.js")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrated deck keeps the frozen content identity: lock verifies against the report manifest", async () => {
  const root = makeProject();
  try {
    const run = runCli(root, ["migrate", "--deck", "mig-deck", ...SLIDE_IDS.flatMap((id) => ["--slide", id])]);
    assert.equal(run.status, 0, run.stderr);

    const report = JSON.parse(readFileSync(join(root, ".lattice/migration/mig-deck.json"), "utf8"));
    const stored = JSON.parse(readFileSync(join(root, ".lattice/content-locks/mig-deck.json"), "utf8"));
    const contentMod = await import(`${"file://" + join(root, "decks/mig-deck/content.js")}`);
    const notesMod = await import(`${"file://" + join(root, "decks/mig-deck/notes.js")}`);
    const loaded = await import(`${"file://" + join(root, "decks/mig-deck/slides.v2.js")}`);

    const fingerprint = computeContentFingerprint(
      contentMod.default,
      report.contentIdentityManifest,
      notesMod.default,
      loaded.slideDefinitions.map((slide) => slide.html),
    );
    const verify = verifyContentLock(fingerprint, stored.fingerprint);
    assert.equal(verify.ok, true, JSON.stringify(verify));

    const v2Manifest = JSON.parse(readFileSync(join(root, "decks/mig-deck/manifest.json"), "utf8"));
    assert.equal(v2Manifest.title, report.contentIdentityManifest.title);
    assert.equal(v2Manifest.owner, report.contentIdentityManifest.owner);
    assert.equal(v2Manifest.presenter, report.contentIdentityManifest.presenter);
    assert.equal(v2Manifest.id, report.contentIdentityManifest.id);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---- Verified idempotence (A08): exit 0 only with complete, consistent evidence ----

function migrateOnce(root) {
  const run = runCli(root, ["migrate", "--deck", "mig-deck", ...SLIDE_IDS.flatMap((id) => ["--slide", id])]);
  assert.equal(run.status, 0, run.stderr);
  return snapshotTree(root);
}

test("migrate refuses the no-op when the migration report is missing, without writing", () => {
  const root = makeProject();
  try {
    migrateOnce(root);
    rmSync(join(root, ".lattice/migration/mig-deck.json"));
    const before = snapshotTree(root);
    const second = runCli(root, ["migrate", "--deck", "mig-deck"]);
    assert.equal(second.status, 1);
    assert.match(second.stderr, /migration report .* is missing or unreadable/);
    assert.deepEqual(snapshotTree(root), before, "failed evidence verification must not write");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrate refuses a broken v2 manifest with no slide entry or report, without writing", () => {
  const root = makeProject();
  try {
    writeFileSync(join(root, "decks/mig-deck/manifest.json"), '{\n  "schema": "lattice.deck.v2",\n  "id": "broken"\n}\n', "utf8");
    const before = snapshotTree(root);
    const result = runCli(root, ["migrate", "--deck", "mig-deck"]);
    assert.equal(result.status, 1, `stderr: ${result.stderr}`);
    assert.match(result.stderr, /fails v2 validation/);
    assert.deepEqual(snapshotTree(root), before, "a refused no-op must not write");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrate refuses the no-op when migration evidence disagrees with the live deck, without writing", () => {
  const root = makeProject();
  try {
    migrateOnce(root);
    const reportPath = join(root, ".lattice/migration/mig-deck.json");
    const report = JSON.parse(readFileSync(reportPath, "utf8"));

    // Corrupt slide digests: sources changed (or report tampered) after migration.
    report.slideDigests[0].sha256 = "0".repeat(64);
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const beforeDigestRun = snapshotTree(root);
    const digestRun = runCli(root, ["migrate", "--deck", "mig-deck"]);
    assert.equal(digestRun.status, 1);
    assert.match(digestRun.stderr, /slide digests no longer match buildSlides\(\) output/);
    assert.deepEqual(snapshotTree(root), beforeDigestRun, "inconsistent evidence must fail explicitly with no writes");

    // Inconsistent slideIds/routes evidence.
    const fresh = JSON.parse(readFileSync(reportPath, "utf8"));
    fresh.slideIds = [...fresh.slideIds.slice(1), fresh.slideIds[0]];
    writeFileSync(reportPath, `${JSON.stringify(fresh, null, 2)}\n`, "utf8");
    const beforeIdsRun = snapshotTree(root);
    const idsRun = runCli(root, ["migrate", "--deck", "mig-deck"]);
    assert.equal(idsRun.status, 1);
    assert.match(idsRun.stderr, /slideIds\/routes disagree with the live v2 deck/);
    assert.deepEqual(snapshotTree(root), beforeIdsRun, "inconsistent evidence must fail explicitly with no writes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrate refuses a structurally corrupt deterministic report, without writing", () => {
  const root = makeProject();
  try {
    migrateOnce(root);
    const reportPath = join(root, ".lattice/migration/mig-deck.json");
    const report = JSON.parse(readFileSync(reportPath, "utf8"));
    report.fromSchema = "lattice.deck.v999";
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
    const before = snapshotTree(root);

    const result = runCli(root, ["migrate", "--deck", "mig-deck"]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /complete deterministic record|invalid frozen lattice\.deck\.v1 identity/);
    assert.deepEqual(snapshotTree(root), before, "corrupt report metadata must fail with no writes");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("migrate refuses the no-op when the live v2 manifest drifted from the frozen identity, without writing", () => {
  const root = makeProject();
  try {
    migrateOnce(root);
    const manifestPath = join(root, "decks/mig-deck/manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.owner = "drifted-owner";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const before = snapshotTree(root);
    const second = runCli(root, ["migrate", "--deck", "mig-deck"]);
    assert.equal(second.status, 1);
    assert.match(second.stderr, /content identity continuity failed/);
    assert.match(second.stderr, /owner/);
    assert.deepEqual(snapshotTree(root), before, "identity drift must not be written back or repaired silently");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a healthy migrated deck stays byte-identical on the verified no-op re-run", () => {
  const root = makeProject();
  try {
    migrateOnce(root);
    const afterFirst = snapshotTree(root);
    const second = runCli(root, ["migrate", "--deck", "mig-deck"]);
    assert.equal(second.status, 0, second.stderr);
    assert.ok(second.stdout.includes("migration evidence verified"));
    assert.ok(second.stdout.includes("Content Lock"));
    assert.ok(second.stdout.includes("VERIFY OK"));
    assert.deepEqual(snapshotTree(root), afterFirst, "healthy no-op must be byte-identical");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
