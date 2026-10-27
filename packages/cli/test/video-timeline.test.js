import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TIMELINE_DECK_ID, writeDeckRegistry, writeProjectConfig, writeTimelineDeck } from "./helpers/timeline-fixture.js";

const cliIndex = fileURLToPath(new URL("../src/index.js", import.meta.url));
// Gitignored tmp INSIDE the package tree, so the project's vite build resolves
// @55aaseclab/lattice-runtime exactly like real business projects.
const tmpRoot = fileURLToPath(new URL("./tmp", import.meta.url));

function makeProject() {
  const projectRoot = mkdtempSync(path.join(tmpRoot, "m7-cli-"));
  writeProjectConfig(projectRoot);
  writeTimelineDeck(projectRoot);
  writeDeckRegistry(projectRoot);
  return projectRoot;
}

function runCli(cwd, args) {
  return spawnSync(process.execPath, [cliIndex, ...args], { cwd, encoding: "utf8", timeout: 300000 });
}

test("video presets prints the machine-readable stop-reveal catalog", () => {
  const result = runCli(process.cwd(), ["video", "presets"]);
  assert.equal(result.status, 0, result.stderr);
  const catalog = JSON.parse(result.stdout);
  assert.equal(catalog.schema, "lattice.stop-reveal-presets.v1");
  assert.equal(catalog.theme, "simple-light");
  const names = catalog.presets.map((preset) => preset.name);
  assert.deepEqual(names, ["fade", "rise", "wipe"]);
  for (const preset of catalog.presets) {
    assert.equal(typeof preset.description, "string");
    for (const [param, spec] of Object.entries(preset.params)) {
      assert.ok(spec.type === "integer" || spec.type === "enum", `${preset.name}.${param}`);
      assert.ok("default" in spec, `${preset.name}.${param} default`);
    }
  }
});

test("video plan compiles the unified timeline into a v2 plan with stop frames (frame order preserved)", () => {
  const projectRoot = makeProject();
  try {
    // Rendering needs a bundle; the plan itself only needs provenance from a
    // real export, so export first.
    const exported = runCli(projectRoot, ["export", "--deck", TIMELINE_DECK_ID]);
    assert.equal(exported.status, 0, exported.stderr);

    const result = runCli(projectRoot, ["video", "plan", "--deck", TIMELINE_DECK_ID]);
    assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout);
    assert.equal(plan.schema, "lattice.video-plan.v2");
    assert.equal(plan.totalFrames, 220); // 90 + 100 + 30 (derived outro dwell)
    assert.equal(plan.audioTracks.length, 1);
    assert.deepEqual(plan.audioTracks[0], { id: "bgm", src: "./assets/audio/tone.wav", startFrame: 0, volume: 0.8 });

    const [intro, reveal, outro] = plan.clips;
    assert.equal(intro.slideId, "intro");
    assert.equal(intro.startFrame, 0);
    assert.equal(intro.durationFrames, 90);
    assert.deepEqual(intro.stops, [{ id: "open", frame: 0 }, { id: "point", frame: 40 }]);
    assert.deepEqual(intro.animation, { preset: "rise", direction: "up", durationFrames: 12, stagger: 3, distancePx: 24 });
    assert.equal(reveal.startFrame, 90);
    assert.equal(reveal.durationFrames, 100);
    assert.deepEqual(reveal.stops, [{ id: "base", frame: 0 }, { id: "step-1", frame: 40 }, { id: "step-2", frame: 70 }]);
    assert.deepEqual(reveal.animation, { preset: "fade", durationFrames: 10, stagger: 0 });
    assert.equal(outro.startFrame, 190);
    assert.equal(outro.durationFrames, 30);
    assert.deepEqual(outro.stops, [{ id: "static", frame: 0 }]);
    assert.deepEqual(outro.animation, { preset: "fade", durationFrames: 10, stagger: 0 });

    // Deterministic re-compile: same plan hash.
    const again = runCli(projectRoot, ["video", "plan", "--deck", TIMELINE_DECK_ID]);
    assert.equal(JSON.parse(again.stdout).provenance.deckHash, plan.provenance.deckHash);
    assert.equal(
      spawnSync(process.execPath, ["-e", `
        const a = JSON.parse(process.argv[1]); const b = JSON.parse(process.argv[2]);
        delete a.provenance.toolchain; delete b.provenance.toolchain;
        process.stdout.write(JSON.stringify(a) === JSON.stringify(b) ? "same" : "diff");
      `, result.stdout, again.stdout], { encoding: "utf8" }).stdout,
      "same",
    );
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("deck with an invalid timeline fails plan compilation with explicit errors", () => {
  const projectRoot = makeProject();
  try {
    const manifestPath = path.join(projectRoot, "decks", TIMELINE_DECK_ID, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.timeline.slides.intro.stops.point.frame = 200; // outside durationFrames 90
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    const result = runCli(projectRoot, ["video", "plan", "--deck", TIMELINE_DECK_ID]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /invalid lattice\.timeline\.v1/);
    assert.match(result.stderr, /outside \[0, 89\]/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("generated video hosts drive reveal by stop frame order (timeline decks only)", async () => {
  const projectRoot = makeProject();
  try {
    const exported = runCli(projectRoot, ["export", "--deck", TIMELINE_DECK_ID]);
    assert.equal(exported.status, 0, exported.stderr);
    const rendered = runCli(projectRoot, ["video", "still", "--deck", TIMELINE_DECK_ID, "--backend", "remotion", "--frame", "0", "--output", path.join(projectRoot, "out", "probe.png")]);
    assert.equal(rendered.status, 0, rendered.stderr + rendered.stdout);
    const renderedHyperframes = runCli(projectRoot, ["video", "still", "--deck", TIMELINE_DECK_ID, "--backend", "hyperframes", "--frame", "0", "--output", path.join(projectRoot, "out", "probe-hf.png")]);
    assert.equal(renderedHyperframes.status, 0, renderedHyperframes.stderr + renderedHyperframes.stdout);

    const manifestPath = path.join(projectRoot, ".lattice", "generated", "remotion", "host", "public", "lattice-host-manifest.json");
    const hostManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    // The host manifest carries the full stop schedule.
    assert.deepEqual(hostManifest.clips[0].stops, [{ id: "open", frame: 0 }, { id: "point", frame: 40 }]);
    assert.deepEqual(hostManifest.clips[0].animation, { preset: "rise", direction: "up", durationFrames: 12, stagger: 3, distancePx: 24 });

    // The generated composition drives stop state + reveal offsets per frame.
    const composition = readFileSync(path.join(projectRoot, ".lattice", "generated", "remotion", "host", "LatticeComposition.jsx"), "utf8");
    assert.match(composition, /__latticeStopState\(clip\.stops, localFrame\)/);
    assert.match(composition, /__latticeApplyRevealOffsets\(canvas/);
    assert.match(composition, /data-lattice-revealed-stops/);
    assert.match(composition, /--lattice-stop-frame-offset/);
    assert.match(composition, /data-lattice-anim/);

    // Same surface in the HyperFrames composition.
    const hyperframes = readFileSync(path.join(projectRoot, ".lattice", "generated", "hyperframes", "composition", "index.html"), "utf8");
    assert.match(hyperframes, /__latticeStopState/);
    assert.match(hyperframes, /data-lattice-anim/);
    assert.match(hyperframes, /data-lattice-stop="open"/);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("lattice edit --timeline edits the manifest through the full auditable loop", () => {
  const projectRoot = makeProject();
  try {
    const manifestPath = path.join(projectRoot, "decks", TIMELINE_DECK_ID, "manifest.json");
    const before = readFileSync(manifestPath, "utf8");

    const dryRun = runCli(projectRoot, ["edit", "--deck", TIMELINE_DECK_ID, "--timeline", "slides.reveal.animation.preset", "--value", '"rise"', "--dry-run", "--actor", "m7-test"]);
    assert.equal(dryRun.status, 0, dryRun.stderr);
    const dryReport = JSON.parse(dryRun.stdout);
    assert.equal(dryReport.dryRun, true);
    assert.equal(dryReport.sourceMap.file, `decks/${TIMELINE_DECK_ID}/manifest.json`);
    assert.equal(existsSync(path.join(projectRoot, ".lattice", "provenance")), false, "dry-run writes no provenance");
    assert.equal(readFileSync(manifestPath, "utf8"), before, "dry-run writes nothing");

    const applied = runCli(projectRoot, ["edit", "--deck", TIMELINE_DECK_ID, "--timeline", "slides.reveal.animation.preset", "--value", '"rise"', "--reason", "M7 animation closure", "--actor", "m7-test"]);
    assert.equal(applied.status, 0, applied.stderr);
    const report = JSON.parse(applied.stdout);
    assert.equal(report.ok, true);
    assert.equal(report.gate.validate.pass, true);
    assert.equal(report.sourceMap.target.fieldPath, "timeline.slides.reveal.animation.preset");
    assert.ok(report.sourceMap.target.byteRange.end > report.sourceMap.target.byteRange.start);
    assert.ok(report.provenance.path.endsWith(".json"));

    const after = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(after.timeline.slides.reveal.animation.preset, "rise");
    // Minimal patch: only the preset value span changed.
    const afterText = readFileSync(manifestPath, "utf8");
    assert.equal(afterText.split("\n").length, before.split("\n").length);

    const provenance = JSON.parse(readFileSync(path.join(projectRoot, report.provenance.path), "utf8"));
    assert.equal(provenance.schema, "lattice.provenance.v1");
    assert.equal(provenance.command, "edit");
    assert.equal(provenance.deck, TIMELINE_DECK_ID);
    assert.equal(provenance.field, "timeline.slides.reveal.animation.preset");
    assert.equal(provenance.value, "rise");
    assert.equal(provenance.sourceMap.file, `decks/${TIMELINE_DECK_ID}/manifest.json`);
    assert.ok(provenance.inputs.sha256 !== provenance.outputs.sha256);

    // The validate loop confirms the edited deck is still valid, and the new
    // animation flows into the plan.
    const validated = runCli(projectRoot, ["validate", "--deck", TIMELINE_DECK_ID]);
    assert.equal(validated.status, 0, validated.stderr);
    runCli(projectRoot, ["export", "--deck", TIMELINE_DECK_ID]);
    const plan = JSON.parse(runCli(projectRoot, ["video", "plan", "--deck", TIMELINE_DECK_ID]).stdout);
    assert.equal(plan.clips[1].animation.preset, "rise");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("lattice edit --timeline refuses illegal presets and parameters before writing", () => {
  const projectRoot = makeProject();
  try {
    const manifestPath = path.join(projectRoot, "decks", TIMELINE_DECK_ID, "manifest.json");
    const before = readFileSync(manifestPath, "utf8");

    const unknownPreset = runCli(projectRoot, ["edit", "--deck", TIMELINE_DECK_ID, "--timeline", "slides.reveal.animation.preset", "--value", '"spin"']);
    assert.equal(unknownPreset.status, 1);
    const report = JSON.parse(unknownPreset.stderr);
    assert.equal(report.error.code, "invalid-timeline-value");
    assert.match(JSON.stringify(report.error.details.errors), /spin/);
    assert.equal(readFileSync(manifestPath, "utf8"), before, "zero writes on refusal");

    const unknownParam = runCli(projectRoot, ["edit", "--deck", TIMELINE_DECK_ID, "--timeline", "slides.reveal.animation.durationFrames", "--value", "0"]);
    assert.equal(unknownParam.status, 1);
    assert.equal(JSON.parse(unknownParam.stderr).error.code, "invalid-timeline-value");
    assert.equal(readFileSync(manifestPath, "utf8"), before, "zero writes on refusal");

    const unknownPath = runCli(projectRoot, ["edit", "--deck", TIMELINE_DECK_ID, "--timeline", "slides.ghost.animation.preset", "--value", '"fade"']);
    assert.equal(unknownPath.status, 1);
    assert.equal(JSON.parse(unknownPath.stderr).error.code, "field-not-found");
    assert.equal(readFileSync(manifestPath, "utf8"), before);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("content lock gate: a locked deck rejects timeline edits with zero writes", () => {
  const projectRoot = makeProject();
  try {
    const locked = runCli(projectRoot, ["lock", "update", "--deck", TIMELINE_DECK_ID, "--actor", "m7-test", "--reason", "freeze before timeline gate test"]);
    assert.equal(locked.status, 0, locked.stderr);

    const manifestPath = path.join(projectRoot, "decks", TIMELINE_DECK_ID, "manifest.json");
    const before = readFileSync(manifestPath, "utf8");
    const rejected = runCli(projectRoot, ["edit", "--deck", TIMELINE_DECK_ID, "--timeline", "slides.reveal.animation.preset", "--value", '"rise"']);
    assert.equal(rejected.status, 1);
    const report = JSON.parse(rejected.stderr);
    assert.equal(report.error.code, "content-lock-gate-rejected");
    assert.equal(report.gate.contentLock.decision, "reject");
    assert.equal(report.zeroWrites, true);
    assert.equal(readFileSync(manifestPath, "utf8"), before, "zero writes on gate rejection");

    // Explicit re-freeze authorizes the timeline change.
    const refrozen = runCli(projectRoot, ["lock", "update", "--deck", TIMELINE_DECK_ID, "--actor", "m7-test", "--reason", "authorized M7 timeline change"]);
    assert.equal(refrozen.status, 0, refrozen.stderr);
    const allowed = runCli(projectRoot, ["edit", "--deck", TIMELINE_DECK_ID, "--timeline", "slides.reveal.animation.preset", "--value", '"rise"']);
    assert.equal(allowed.status, 1, "still rejected: the fingerprint changed but the gate requires the value to already be frozen");
    // Re-freeze BEFORE the edit, then edit → rejected until frozen again.
    const refrozenAgain = runCli(projectRoot, ["lock", "update", "--deck", TIMELINE_DECK_ID, "--actor", "m7-test", "--reason", "freeze the old value again"]);
    assert.equal(refrozenAgain.status, 0, refrozenAgain.stderr);
    const rejected2 = runCli(projectRoot, ["edit", "--deck", TIMELINE_DECK_ID, "--timeline", "slides.reveal.animation.preset", "--value", '"rise"']);
    assert.equal(rejected2.status, 1);
    assert.equal(JSON.parse(rejected2.stderr).error.code, "content-lock-gate-rejected");
    assert.equal(readFileSync(manifestPath, "utf8"), before);
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("lattice edit --timeline and content edits are mutually exclusive", () => {
  const projectRoot = makeProject();
  try {
    const result = runCli(projectRoot, ["edit", "--deck", TIMELINE_DECK_ID, "--timeline", "rhythm.dwell", "--slide", "intro", "--field", "title", "--value", '"X"']);
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stderr).error.code, "mutually-exclusive-arguments");
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});

test("static decks (no timeline) keep compiling exact v1 plans through the same CLI path", () => {
  const projectRoot = makeProject();
  try {
    const deckDir = path.join(projectRoot, "decks", TIMELINE_DECK_ID);
    const manifestPath = path.join(deckDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const timeline = manifest.timeline;
    delete manifest.timeline;
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");
    // Slides keep their static placeholder timing (durationFrames from the
    // definitions), like every frozen deck.
    const exported = runCli(projectRoot, ["export", "--deck", TIMELINE_DECK_ID]);
    assert.equal(exported.status, 0, exported.stderr);
    const plan = JSON.parse(runCli(projectRoot, ["video", "plan", "--deck", TIMELINE_DECK_ID]).stdout);
    assert.equal(plan.schema, "lattice.video-plan.v1");
    for (const clip of plan.clips) {
      assert.equal("stops" in clip, false);
      assert.equal("animation" in clip, false);
    }
    assert.equal(plan.totalFrames, 90 + 100 + 30);
    assert.equal(plan.audioTracks.length, 0);
    void timeline;
  } finally {
    rmSync(projectRoot, { recursive: true, force: true });
  }
});
