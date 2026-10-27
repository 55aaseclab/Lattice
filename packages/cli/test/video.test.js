import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { ensureBackendsInitialized, getBackend, listBackendIds } from "../src/video/registry.js";
import { validateBackendId, BackendDiagnostic, PreparedRender, RenderArtifact, ArtifactMetadata, VideoBackendError } from "../src/video/backend-contract.js";
import { computeBundleIdentityHash, validateSlideWebBundle } from "../src/video/bundle.js";
import { compileVideoPlan, bakeVideoPlanProvenance } from "@55aaseclab/lattice-runtime/video-plan";

const sha256 = (label) => createHash("sha256").update(label).digest("hex");

// A genuine minimal Lattice Slide Web Bundle: the same file contract that
// "lattice export" produces (index.html + manifest/content/layout/notes JSON
// + assets directory). manifest.id must match the plan deck id, and
// manifest.entry must reference the entry JSON files exactly as the exporter
// records them.
function makeValidBundle(baseDir, { deckId = "test" } = {}) {
  const bundleDir = join(baseDir, "bundle");
  mkdirSync(bundleDir, { recursive: true });
  writeFileSync(
    join(bundleDir, "index.html"),
    `<!doctype html><html><head><title>${deckId}</title></head><body><div id="app"></div></body></html>`,
    "utf8",
  );
  writeFileSync(
    join(bundleDir, "manifest.json"),
    JSON.stringify({
      schema: "lattice.deck.v1",
      id: deckId,
      title: `Deck ${deckId}`,
      entry: {
        content: "./content.json",
        layout: "./layout.json",
        notes: "./notes.json",
      },
    }),
    "utf8",
  );
  writeFileSync(join(bundleDir, "content.json"), JSON.stringify({ id: deckId, slides: [] }), "utf8");
  writeFileSync(join(bundleDir, "layout.json"), JSON.stringify([]), "utf8");
  writeFileSync(join(bundleDir, "notes.json"), JSON.stringify([]), "utf8");
  mkdirSync(join(bundleDir, "assets"), { recursive: true });
  writeFileSync(join(bundleDir, "assets", "placeholder.txt"), "bundle asset\n", "utf8");
  return bundleDir;
}

// Compile a plan and bake real provenance: the bundle hash is computed from
// the actual bundle directory, so adapters accept it end to end.
function makeCompletePlan({ deckId = "test", bundleDir } = {}) {
  const result = compileVideoPlan({
    deckId,
    routeId: "main",
    routes: { main: ["a"] },
    slides: [{ id: "a", durationFrames: 30 }],
  });
  assert.equal(result.ok, true, result.reason || "plan must compile");
  return bakeVideoPlanProvenance(result.plan, {
    deckHash: sha256("deck-source"),
    bundleHash: computeBundleIdentityHash(bundleDir),
    inputPropsHash: sha256("input-props"),
  });
}

ensureBackendsInitialized();

test("backend registry initializes with remotion and hyperframes", () => {
  const ids = listBackendIds();
  assert.ok(ids.includes("remotion"));
  assert.ok(ids.includes("hyperframes"));
  assert.equal(ids.length, 2);
});

test("getBackend returns remotion backend", () => {
  const backend = getBackend("remotion");
  assert.equal(backend.id, "remotion");
  assert.equal(typeof backend.doctor, "function");
  assert.equal(typeof backend.prepare, "function");
  assert.equal(typeof backend.renderStill, "function");
  assert.equal(typeof backend.renderVideo, "function");
  assert.equal(typeof backend.inspectArtifact, "function");
});

test("getBackend returns hyperframes backend", () => {
  const backend = getBackend("hyperframes");
  assert.equal(backend.id, "hyperframes");
  assert.equal(typeof backend.doctor, "function");
  assert.equal(typeof backend.prepare, "function");
});

test("getBackend throws for unknown backend", () => {
  assert.throws(
    () => getBackend("unknown"),
    { name: "VideoBackendError" },
  );
});

test("validateBackendId rejects unknown ids", () => {
  assert.equal(validateBackendId("remotion").ok, true);
  assert.equal(validateBackendId("hyperframes").ok, true);
  assert.equal(validateBackendId("nonexistent").ok, false);
});

test("doctor runs without crashing for remotion", async () => {
  const backend = getBackend("remotion");
  const report = await backend.doctor();
  assert.equal(typeof report.status, "string");
  assert.ok(Array.isArray(report.diagnostics));
  assert.ok(report.diagnostics.length > 0);
  assert.ok(["available", "unavailable"].includes(report.status));
});

test("doctor runs without crashing for hyperframes", async () => {
  const backend = getBackend("hyperframes");
  const report = await backend.doctor();
  assert.equal(typeof report.status, "string");
  assert.ok(Array.isArray(report.diagnostics));
});

test("BackendDiagnostic has correct structure", () => {
  const diag = new BackendDiagnostic({
    level: "error",
    message: "test diagnostic",
    details: { key: "value" },
  });
  assert.equal(diag.level, "error");
  assert.equal(diag.message, "test diagnostic");
  assert.deepStrictEqual(diag.details, { key: "value" });
});

test("PreparedRender has correct fields", () => {
  const pr = new PreparedRender({
    backendId: "remotion",
    planHash: "abc123",
    workDir: "/tmp/test",
  });
  assert.equal(pr.backendId, "remotion");
  assert.equal(pr.planHash, "abc123");
  assert.equal(pr.workDir, "/tmp/test");
});

test("VideoBackendError preserves diagnostics", () => {
  const error = new VideoBackendError("test error", {
    backendId: "remotion",
    diagnostics: [{ message: "missing ffmpeg" }],
    cause: "test-cause",
  });
  assert.equal(error.name, "VideoBackendError");
  assert.equal(error.backendId, "remotion");
  assert.equal(error.diagnostics.length, 1);
  assert.equal(error.cause, "test-cause");
});

test("doctor returns exit 2 when required deps missing", async () => {
  const backend = getBackend("remotion");
  const report = await backend.doctor();
  const hasErrors = report.diagnostics.some((d) => d.level === "error");
  if (hasErrors) {
    assert.equal(report.exitCode, 2);
  }
});

test("hyperframes doctor never references @hyperframes/cli", async () => {
  const backend = getBackend("hyperframes");
  const report = await backend.doctor();
  for (const diag of report.diagnostics) {
    const msg = diag.message || "";
    assert.ok(!msg.includes("@hyperframes/cli"), `unexpected @hyperframes/cli in: ${msg}`);
  }
  const install = report.installInstructions || {};
  for (const val of Object.values(install)) {
    assert.ok(!String(val).includes("@hyperframes/cli"), `unexpected @hyperframes/cli in install: ${val}`);
  }
});

test("hyperframes doctor references package 'hyperframes'", async () => {
  const backend = getBackend("hyperframes");
  const report = await backend.doctor();
  const msg = JSON.stringify(report);
  assert.ok(msg.includes("hyperframes"), "must reference 'hyperframes' package");
});

test("remotion backend prepare validates plan", async () => {
  const workDir = mkdtempSync(join(tmpdir(), "lattice-video-test-"));
  const bundleDir = makeValidBundle(workDir);
  const backend = getBackend("remotion");

  const invalidPlan = {
    schema: "wrong-schema",
    deckId: "",
    routeId: "",
    width: 960,
    height: 540,
    fps: 30,
    totalFrames: 60,
    clips: [],
    audioTracks: [],
  };

  try {
    await backend.prepare({ plan: invalidPlan, bundleDir, workDir, projectRoot: workDir });
    assert.fail("should have thrown for invalid plan");
  } catch (error) {
    assert.equal(error.name, "VideoBackendError");
    assert.equal(error.cause, "invalid-plan");
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});

test("prepare rejects an unbaked plan with empty provenance", async () => {
  const workRoot = mkdtempSync(join(tmpdir(), "lattice-video-unbaked-"));
  const bundleDir = makeValidBundle(workRoot);
  const backend = getBackend("remotion");

  const result = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: { main: ["a"] },
    slides: [{ id: "a", durationFrames: 30 }],
  });
  assert.equal(result.ok, true);

  try {
    await backend.prepare({
      plan: result.plan,
      bundleDir,
      workDir: join(workRoot, ".lattice", "generated", "remotion"),
      projectRoot: workRoot,
    });
    assert.fail("prepare must reject an unbaked (empty provenance) plan");
  } catch (error) {
    assert.equal(error.name, "VideoBackendError");
    assert.equal(error.cause, "invalid-plan");
    assert.ok(error.message.includes("provenance"));
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
  }
});

test("prepare rejects a plan whose provenance names a different bundle", async () => {
  const workRoot = mkdtempSync(join(tmpdir(), "lattice-video-mismatch-"));
  const otherRoot = mkdtempSync(join(tmpdir(), "lattice-video-mismatch-other-"));
  const bundleDir = makeValidBundle(workRoot);
  const backend = getBackend("remotion");

  // Same shape, different bundle content => different identity hash.
  const otherBundle = makeValidBundle(otherRoot, { deckId: "test" });
  writeFileSync(join(otherBundle, "assets", "other.txt"), "different bytes\n", "utf8");

  const plan = compileVideoPlan({
    deckId: "test",
    routeId: "main",
    routes: { main: ["a"] },
    slides: [{ id: "a", durationFrames: 30 }],
  });
  const completePlan = bakeVideoPlanProvenance(plan.plan, {
    deckHash: sha256("deck"),
    bundleHash: computeBundleIdentityHash(otherBundle),
    inputPropsHash: sha256("props"),
  });

  try {
    await backend.prepare({
      plan: completePlan,
      bundleDir,
      workDir: join(workRoot, ".lattice", "generated", "remotion"),
      projectRoot: workRoot,
    });
    assert.fail("prepare must reject mismatched bundle identity");
  } catch (error) {
    assert.equal(error.name, "VideoBackendError");
    assert.equal(error.cause, "bundle-mismatch");
  } finally {
    rmSync(workRoot, { recursive: true, force: true });
    rmSync(otherRoot, { recursive: true, force: true });
  }
});

function makeEscapePlan(bundleDir) {
  return makeCompletePlan({ deckId: "test", bundleDir });
}

for (const backendId of ["remotion", "hyperframes"]) {
  test(`[${backendId}] prepare rejects lexical traversal`, async () => {
    const tmpWorkDir = mkdtempSync(join(tmpdir(), `lattice-video-escape-${backendId}-`));
    const bundleDir = makeValidBundle(tmpWorkDir);
    const backend = getBackend(backendId);
    const validPlan = makeEscapePlan(bundleDir);

    try {
      await backend.prepare({
        plan: validPlan,
        bundleDir,
        workDir: join(tmpWorkDir, ".lattice", "generated", backendId, "..", "..", "evil"),
        projectRoot: tmpWorkDir,
      });
      assert.fail("should have rejected lexical traversal");
    } catch (error) {
      assert.equal(error.name, "VideoBackendError");
      assert.equal(error.cause, "path-escape");
    } finally {
      rmSync(tmpWorkDir, { recursive: true, force: true });
    }
  });

  test(`[${backendId}] prepare rejects wrong backend directory`, async () => {
    const tmpWorkDir = mkdtempSync(join(tmpdir(), `lattice-video-wrongdir-${backendId}-`));
    const bundleDir = makeValidBundle(tmpWorkDir);
    const backend = getBackend(backendId);
    const validPlan = makeEscapePlan(bundleDir);
    const otherBackend = backendId === "remotion" ? "hyperframes" : "remotion";

    try {
      await backend.prepare({
        plan: validPlan,
        bundleDir,
        workDir: join(tmpWorkDir, ".lattice", "generated", otherBackend),
        projectRoot: tmpWorkDir,
      });
      assert.fail(`should have rejected writing into the ${otherBackend} directory`);
    } catch (error) {
      assert.equal(error.name, "VideoBackendError");
      assert.equal(error.cause, "path-escape");
    } finally {
      rmSync(tmpWorkDir, { recursive: true, force: true });
    }
  });

  test(`[${backendId}] prepare rejects symlink-ancestor escape before workDir exists`, async () => {
    const tmpWorkDir = mkdtempSync(join(tmpdir(), `lattice-video-symlink-${backendId}-`));
    const outsideDir = mkdtempSync(join(tmpdir(), "lattice-video-outside-"));
    const bundleDir = makeValidBundle(tmpWorkDir);
    const backend = getBackend(backendId);
    const validPlan = makeEscapePlan(bundleDir);

    mkdirSync(join(tmpWorkDir, ".lattice"), { recursive: true });
    // .lattice/generated is a symlink pointing OUTSIDE the project root; the
    // final workDir does not exist yet, which must not bypass the check.
    symlinkSync(outsideDir, join(tmpWorkDir, ".lattice", "generated"), "dir");

    try {
      await backend.prepare({
        plan: validPlan,
        bundleDir,
        workDir: join(tmpWorkDir, ".lattice", "generated", backendId),
        projectRoot: tmpWorkDir,
      });
      assert.fail("should have rejected symlink-ancestor escape");
    } catch (error) {
      assert.equal(error.name, "VideoBackendError");
      assert.equal(error.cause, "path-escape");
      assert.ok(error.message.includes("symlink"), "diagnostic must mention the symlink escape");
    } finally {
      rmSync(tmpWorkDir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  test(`[${backendId}] prepare accepts the valid in-root generated path and records bundle identity`, async () => {
    const tmpWorkDir = mkdtempSync(join(tmpdir(), `lattice-video-valid-${backendId}-`));
    const bundleDir = makeValidBundle(tmpWorkDir);
    const backend = getBackend(backendId);
    const validPlan = makeEscapePlan(bundleDir);

    try {
      const prepared = await backend.prepare({
        plan: validPlan,
        bundleDir,
        workDir: join(tmpWorkDir, ".lattice", "generated", backendId),
        projectRoot: tmpWorkDir,
      });
      assert.equal(prepared.backendId, backendId);
      assert.equal(prepared.workDir, join(tmpWorkDir, ".lattice", "generated", backendId));
      assert.equal(prepared.bundlePath, bundleDir);
      assert.equal(prepared.bundleHash, computeBundleIdentityHash(bundleDir));

      const projectJson = JSON.parse(readFileSync(
        join(prepared.workDir, `${backendId}-project.json`),
        "utf8",
      ));
      assert.equal(projectJson.bundleDir, bundleDir);
      assert.equal(projectJson.bundleHash, prepared.bundleHash);
      assert.equal(projectJson.planHash, prepared.planHash);

      const header = readFileSync(join(prepared.workDir, `LATTICE_${backendId.toUpperCase()}.md`), "utf8");
      assert.ok(header.includes("DO NOT EDIT"));
      assert.ok(header.includes(`bundle-hash: ${prepared.bundleHash}`));
    } finally {
      rmSync(tmpWorkDir, { recursive: true, force: true });
    }
  });
}

test("backend prepare rejects /tmp/evil traversal", async () => {
  const tmpWorkDir = mkdtempSync(join(tmpdir(), "lattice-video-evil-"));
  const bundleDir = makeValidBundle(tmpWorkDir);
  const backend = getBackend("remotion");

  const validPlan = makeEscapePlan(bundleDir);

  try {
    await backend.prepare({
      plan: validPlan,
      bundleDir,
      workDir: join("/tmp/evil", ".lattice", "generated", "remotion"),
      projectRoot: tmpWorkDir,
    });
    assert.fail("should have rejected /tmp/evil traversal");
  } catch (error) {
    assert.equal(error.name, "VideoBackendError");
    assert.equal(error.cause, "path-escape");
  } finally {
    rmSync(tmpWorkDir, { recursive: true, force: true });
  }
});

test("backend prepare rejects empty bundleDir (generic directory, not a bundle)", async () => {
  const tmpWorkDir = mkdtempSync(join(tmpdir(), "lattice-video-empty-"));
  const bundleDir = mkdtempSync(join(tmpdir(), "lattice-empty-bundle-"));
  const backend = getBackend("remotion");

  const validPlan = makeEscapePlan(makeValidBundle(tmpWorkDir));

  const safeWorkDir = join(tmpWorkDir, ".lattice/generated/remotion");

  try {
    await backend.prepare({ plan: validPlan, bundleDir, workDir: safeWorkDir, projectRoot: tmpWorkDir });
    assert.fail("should have rejected empty directory as bundle");
  } catch (error) {
    assert.equal(error.name, "VideoBackendError");
  } finally {
    rmSync(tmpWorkDir, { recursive: true, force: true });
    rmSync(bundleDir, { recursive: true, force: true });
  }
});

test("bundle validation rejects a generic <html></html> directory", () => {
  const tmp = mkdtempSync(join(tmpdir(), "lattice-generic-bundle-"));
  try {
    writeFileSync(join(tmp, "index.html"), "<html></html>", "utf8");
    assert.throws(
      () => validateSlideWebBundle({ bundleDir: tmp, deckId: "test" }),
      (error) => error.name === "VideoBackendError" && error.message.includes("manifest.json"),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("bundle validation rejects wrong-deck bundles", () => {
  const tmp = mkdtempSync(join(tmpdir(), "lattice-wrong-deck-"));
  try {
    const bundleDir = makeValidBundle(tmp, { deckId: "other-deck" });
    assert.throws(
      () => validateSlideWebBundle({ bundleDir, deckId: "test" }),
      (error) => error.name === "VideoBackendError" && error.message.includes("identity mismatch"),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("bundle validation rejects missing assets directory", () => {
  const tmp = mkdtempSync(join(tmpdir(), "lattice-no-assets-"));
  try {
    const bundleDir = makeValidBundle(tmp);
    rmSync(join(bundleDir, "assets"), { recursive: true, force: true });
    assert.throws(
      () => validateSlideWebBundle({ bundleDir, deckId: "test" }),
      (error) => error.name === "VideoBackendError" && error.message.includes("assets"),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("bundle validation rejects invalid JSON in contract files", () => {
  const tmp = mkdtempSync(join(tmpdir(), "lattice-bad-json-"));
  try {
    const bundleDir = makeValidBundle(tmp);
    writeFileSync(join(bundleDir, "notes.json"), "{not json", "utf8");
    assert.throws(
      () => validateSlideWebBundle({ bundleDir, deckId: "test" }),
      (error) => error.name === "VideoBackendError" && error.message.includes("notes.json"),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("bundle validation rejects a bundle without manifest.entry", () => {
  const tmp = mkdtempSync(join(tmpdir(), "lattice-no-entry-"));
  try {
    const bundleDir = makeValidBundle(tmp);
    const manifest = JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf8"));
    delete manifest.entry;
    writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(manifest), "utf8");
    assert.throws(
      () => validateSlideWebBundle({ bundleDir, deckId: "test" }),
      (error) =>
        error.name === "VideoBackendError" &&
        error.message.includes("entry") &&
        error.message.includes("manifest.json"),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("bundle validation rejects malformed manifest.entry values", () => {
  const badEntries = [
    ["entry is a string", "./content.json", (error) => error.message.includes('"entry" object')],
    ["entry is an array", [], (error) => error.message.includes('"entry" object')],
    ["entry.content missing", { layout: "./layout.json", notes: "./notes.json" }, (error) => error.message.includes("entry.content")],
    ["entry.notes empty string", { content: "./content.json", layout: "./layout.json", notes: "" }, (error) => error.message.includes("entry.notes")],
    ["entry.layout not a string", { content: "./content.json", layout: 42, notes: "./notes.json" }, (error) => error.message.includes("entry.layout")],
  ];
  for (const [label, badEntry, matches] of badEntries) {
    const tmp = mkdtempSync(join(tmpdir(), "lattice-bad-entry-"));
    try {
      const bundleDir = makeValidBundle(tmp);
      const manifest = JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf8"));
      manifest.entry = badEntry;
      writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(manifest), "utf8");
      assert.throws(
        () => validateSlideWebBundle({ bundleDir, deckId: "test" }),
        (error) => error.name === "VideoBackendError" && matches(error),
        `malformed entry must be rejected (${label})`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
});

test("bundle validation rejects a manifest.entry reference to a missing file", () => {
  const tmp = mkdtempSync(join(tmpdir(), "lattice-entry-missing-"));
  try {
    const bundleDir = makeValidBundle(tmp);
    const manifest = JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf8"));
    manifest.entry.notes = "./missing-notes.json";
    writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(manifest), "utf8");
    assert.throws(
      () => validateSlideWebBundle({ bundleDir, deckId: "test" }),
      (error) =>
        error.name === "VideoBackendError" &&
        error.message.includes("entry.notes") &&
        error.message.includes("missing file"),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("bundle validation rejects invalid JSON in the referenced entry target", () => {
  const tmp = mkdtempSync(join(tmpdir(), "lattice-entry-badjson-"));
  try {
    const bundleDir = makeValidBundle(tmp);
    writeFileSync(join(bundleDir, "broken.json"), "{not json", "utf8");
    const manifest = JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf8"));
    manifest.entry.notes = "./broken.json";
    writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(manifest), "utf8");
    assert.throws(
      () => validateSlideWebBundle({ bundleDir, deckId: "test" }),
      (error) =>
        error.name === "VideoBackendError" &&
        error.message.includes("entry.notes") &&
        error.message.includes("broken.json") &&
        error.message.includes("not valid JSON"),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("bundle validation rejects an absolute manifest.entry path", () => {
  const tmp = mkdtempSync(join(tmpdir(), "lattice-entry-absolute-"));
  try {
    const bundleDir = makeValidBundle(tmp);
    writeFileSync(join(tmp, "outside.json"), "{}", "utf8");
    const manifest = JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf8"));
    manifest.entry.content = join(tmp, "outside.json");
    writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(manifest), "utf8");
    assert.throws(
      () => validateSlideWebBundle({ bundleDir, deckId: "test" }),
      (error) =>
        error.name === "VideoBackendError" &&
        error.message.includes("entry.content") &&
        error.message.includes("absolute"),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("bundle validation rejects manifest.entry traversal outside the bundle", () => {
  const tmp = mkdtempSync(join(tmpdir(), "lattice-entry-traversal-"));
  try {
    const bundleDir = makeValidBundle(tmp);
    writeFileSync(join(tmp, "outside.json"), "{}", "utf8");
    const manifest = JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf8"));
    manifest.entry.layout = "../outside.json";
    writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(manifest), "utf8");
    assert.throws(
      () => validateSlideWebBundle({ bundleDir, deckId: "test" }),
      (error) =>
        error.name === "VideoBackendError" &&
        error.message.includes("entry.layout") &&
        error.message.includes("inside the bundle"),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("bundle validation rejects a manifest.entry symlink escape", () => {
  const tmp = mkdtempSync(join(tmpdir(), "lattice-entry-symlink-"));
  try {
    const bundleDir = makeValidBundle(tmp);
    writeFileSync(join(tmp, "outside.json"), "{}", "utf8");
    rmSync(join(bundleDir, "notes.json"));
    symlinkSync(join(tmp, "outside.json"), join(bundleDir, "notes.json"));
    assert.throws(
      () => validateSlideWebBundle({ bundleDir, deckId: "test" }),
      (error) =>
        error.name === "VideoBackendError" &&
        error.message.includes("entry.notes") &&
        error.message.includes("symlink"),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("bundle validation follows manifest.entry references instead of fixed filenames", () => {
  const tmp = mkdtempSync(join(tmpdir(), "lattice-entry-custom-"));
  try {
    const bundleDir = makeValidBundle(tmp);
    // Entry references live in a subdirectory; the root contract files stay in
    // place (the exporter always emits them) but validation must follow the
    // declared references, not the fixed names.
    mkdirSync(join(bundleDir, "data"), { recursive: true });
    writeFileSync(join(bundleDir, "data", "slides.json"), JSON.stringify({ id: "test", slides: [] }), "utf8");
    writeFileSync(join(bundleDir, "data", "rows.json"), "[]", "utf8");
    writeFileSync(join(bundleDir, "data", "speaker.json"), "[]", "utf8");
    // A corrupt root notes.json must not fail validation when the manifest
    // entry no longer references it: no fixed-filename fallback is allowed.
    writeFileSync(join(bundleDir, "notes.json"), "{not json", "utf8");
    const manifest = JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf8"));
    manifest.entry = {
      content: "./data/slides.json",
      layout: "data/rows.json",
      notes: "./data/./speaker.json",
    };
    writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(manifest), "utf8");

    const info = validateSlideWebBundle({ bundleDir, deckId: "test" });
    assert.equal(info.bundlePath, bundleDir);
    assert.equal(info.manifest.entry.content, "./data/slides.json");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("bundle validation rejects a manifest.entry target symlinked within the bundle", () => {
  const tmp = mkdtempSync(join(tmpdir(), "lattice-entry-symlink-ok-"));
  try {
    const bundleDir = makeValidBundle(tmp);
    writeFileSync(join(bundleDir, "data-notes.json"), "[]", "utf8");
    symlinkSync(join(bundleDir, "data-notes.json"), join(bundleDir, "linked-notes.json"));
    const manifest = JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf8"));
    manifest.entry.notes = "./linked-notes.json";
    writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(manifest), "utf8");
    assert.throws(
      () => validateSlideWebBundle({ bundleDir, deckId: "test" }),
      (error) =>
        error.name === "VideoBackendError" &&
        error.cause === "invalid-bundle" &&
        error.message.includes("entry.notes") &&
        error.message.includes("symlink"),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("retargeting an entry-target symlink must be rejected, never accepted with an identical hash", () => {
  const tmpA = mkdtempSync(join(tmpdir(), "lattice-retarget-a-"));
  const tmpB = mkdtempSync(join(tmpdir(), "lattice-retarget-b-"));
  try {
    const bundleDirs = [];
    for (const [tmp, selected] of [[tmpA, "a"], [tmpB, "b"]]) {
      const bundleDir = makeValidBundle(tmp);
      mkdirSync(join(bundleDir, "data"), { recursive: true });
      writeFileSync(join(bundleDir, "data", "a.json"), JSON.stringify({ selection: "A" }), "utf8");
      writeFileSync(join(bundleDir, "data", "b.json"), JSON.stringify({ selection: "B" }), "utf8");
      symlinkSync(join(bundleDir, "data", `${selected}.json`), join(bundleDir, "data", "current.json"));
      const manifest = JSON.parse(readFileSync(join(bundleDir, "manifest.json"), "utf8"));
      manifest.entry.notes = "./data/current.json";
      writeFileSync(join(bundleDir, "manifest.json"), JSON.stringify(manifest), "utf8");
      bundleDirs.push(bundleDir);
    }
    const [bundleA, bundleB] = bundleDirs;

    // The retarget changes the JSON actually consumed (selected A vs B); both
    // bundles must be rejected instead of validated with the same identity.
    for (const bundleDir of [bundleA, bundleB]) {
      assert.throws(
        () => validateSlideWebBundle({ bundleDir, deckId: "test" }),
        (error) =>
          error.name === "VideoBackendError" &&
          error.cause === "invalid-bundle" &&
          error.message.includes("entry.notes") &&
          error.message.includes("current.json") &&
          error.message.includes("symlink"),
        "retargeted symlink bundle must be rejected as invalid-bundle",
      );
      assert.throws(
        () => computeBundleIdentityHash(bundleDir),
        (error) =>
          error.name === "VideoBackendError" &&
          error.cause === "invalid-bundle" &&
          error.message.includes("data/current.json"),
        "identity hashing must fail fast on the entry-target symlink",
      );
    }
  } finally {
    rmSync(tmpA, { recursive: true, force: true });
    rmSync(tmpB, { recursive: true, force: true });
  }
});

test("bundle validation rejects a required root file that is a symlink", () => {
  const tmp = mkdtempSync(join(tmpdir(), "lattice-required-symlink-"));
  try {
    const bundleDir = makeValidBundle(tmp);
    rmSync(join(bundleDir, "layout.json"));
    symlinkSync(join(bundleDir, "notes.json"), join(bundleDir, "layout.json"));
    assert.throws(
      () => validateSlideWebBundle({ bundleDir, deckId: "test" }),
      (error) =>
        error.name === "VideoBackendError" &&
        error.cause === "invalid-bundle" &&
        error.message.includes("layout.json") &&
        error.message.includes("symlink"),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("bundle validation rejects an assets directory that is a symlink", () => {
  const tmp = mkdtempSync(join(tmpdir(), "lattice-assets-symlink-"));
  try {
    const bundleDir = makeValidBundle(tmp);
    mkdirSync(join(bundleDir, "assets-real"), { recursive: true });
    writeFileSync(join(bundleDir, "assets-real", "placeholder.txt"), "bundle asset\n", "utf8");
    rmSync(join(bundleDir, "assets"), { recursive: true });
    symlinkSync(join(bundleDir, "assets-real"), join(bundleDir, "assets"), "dir");
    assert.throws(
      () => validateSlideWebBundle({ bundleDir, deckId: "test" }),
      (error) =>
        error.name === "VideoBackendError" &&
        error.cause === "invalid-bundle" &&
        error.message.includes("assets") &&
        error.message.includes("symlink"),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("bundle validation rejects a nested symlink under assets", () => {
  const tmp = mkdtempSync(join(tmpdir(), "lattice-nested-symlink-"));
  try {
    const bundleDir = makeValidBundle(tmp);
    writeFileSync(join(bundleDir, "secret.json"), "{}", "utf8");
    symlinkSync(join(bundleDir, "secret.json"), join(bundleDir, "assets", "linked.json"));
    assert.throws(
      () => validateSlideWebBundle({ bundleDir, deckId: "test" }),
      (error) =>
        error.name === "VideoBackendError" &&
        error.cause === "invalid-bundle" &&
        error.message.includes("assets/linked.json"),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("computeBundleIdentityHash rejects symlinks instead of silently omitting them", () => {
  const tmp = mkdtempSync(join(tmpdir(), "lattice-hash-symlink-"));
  try {
    const bundleDir = makeValidBundle(tmp);
    symlinkSync(join(bundleDir, "notes.json"), join(bundleDir, "assets", "shim.json"));
    assert.throws(
      () => computeBundleIdentityHash(bundleDir),
      (error) =>
        error.name === "VideoBackendError" &&
        error.cause === "invalid-bundle" &&
        error.message.includes("assets/shim.json"),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("bundle identity hash is deterministic and content-sensitive", () => {
  const tmpA = mkdtempSync(join(tmpdir(), "lattice-hash-a-"));
  const tmpB = mkdtempSync(join(tmpdir(), "lattice-hash-b-"));
  try {
    const bundleA = makeValidBundle(tmpA);
    const bundleB = makeValidBundle(tmpB);
    assert.equal(computeBundleIdentityHash(bundleA), computeBundleIdentityHash(bundleB));

    writeFileSync(join(bundleB, "assets", "extra.bin"), "x", "utf8");
    assert.notEqual(computeBundleIdentityHash(bundleA), computeBundleIdentityHash(bundleB));
  } finally {
    rmSync(tmpA, { recursive: true, force: true });
    rmSync(tmpB, { recursive: true, force: true });
  }
});

test("bundle identity hash is locale-independent (UTF-8 byte order, never localeCompare)", () => {
  const tmp = mkdtempSync(join(tmpdir(), "lattice-hash-locale-"));
  try {
    const bundleDir = makeValidBundle(tmp);
    // Unicode names whose relative order differs between ICU collations:
    // en-US (and C) sorts "ä.txt" before "z.txt", sv-SE sorts it after, so a
    // locale-sensitive sort makes this same tree hash differently per locale.
    writeFileSync(join(bundleDir, "z.txt"), "z", "utf8");
    writeFileSync(join(bundleDir, "ä.txt"), "ä", "utf8");

    const bundleModuleHref = new URL("../src/video/bundle.js", import.meta.url).href;
    const script = `const m = await import(${JSON.stringify(bundleModuleHref)}); process.stdout.write(m.computeBundleIdentityHash(process.argv[1]));`;
    const hashUnderLocale = (lcAll) => {
      const result = spawnSync(process.execPath, ["--input-type=module", "-e", script, bundleDir], {
        encoding: "utf8",
        env: { ...process.env, LC_ALL: lcAll, LANG: lcAll },
      });
      assert.equal(
        result.status,
        0,
        `bundle hash computation failed under LC_ALL=${lcAll}: ${result.stderr}`,
      );
      assert.match(result.stdout, /^[0-9a-f]{64}$/, `unexpected hash output under LC_ALL=${lcAll}`);
      return result.stdout;
    };

    const hashC = hashUnderLocale("C");
    const hashEnUs = hashUnderLocale("en_US.UTF-8");
    const hashSvSe = hashUnderLocale("sv_SE.UTF-8");
    assert.equal(hashC, hashEnUs, "hash must not depend on LC_ALL=C vs en_US.UTF-8");
    assert.equal(hashC, hashSvSe, "hash must not depend on LC_ALL=C vs sv_SE.UTF-8");

    // Content changes must still change the hash under a fixed locale.
    writeFileSync(join(bundleDir, "z.txt"), "z!", "utf8");
    assert.notEqual(hashUnderLocale("C"), hashC);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("backend prepare rejects a symlinked bundle as invalid-bundle before creating the workDir", async () => {
  for (const backendId of ["remotion", "hyperframes"]) {
    const tmpWorkDir = mkdtempSync(join(tmpdir(), `lattice-video-badsymlink-${backendId}-`));
    const bundleDir = makeValidBundle(tmpWorkDir);
    symlinkSync(join(bundleDir, "notes.json"), join(bundleDir, "assets", "leak.json"));
    const backend = getBackend(backendId);
    // Provenance uses a placeholder bundle hash: the bundle cannot be hashed
    // at all, and prepare must reject it during validation before the
    // provenance comparison and before any backend work directory exists.
    const compiled = compileVideoPlan({
      deckId: "test",
      routeId: "main",
      routes: { main: ["a"] },
      slides: [{ id: "a", durationFrames: 30 }],
    });
    assert.equal(compiled.ok, true, compiled.reason || "plan must compile");
    const plan = bakeVideoPlanProvenance(compiled.plan, {
      deckHash: sha256("deck-source"),
      bundleHash: "0".repeat(64),
      inputPropsHash: sha256("input-props"),
    });
    const workDir = join(tmpWorkDir, ".lattice", "generated", backendId);

    try {
      await backend.prepare({ plan, bundleDir, workDir, projectRoot: tmpWorkDir });
      assert.fail(`[${backendId}] prepare should have rejected a symlinked bundle`);
    } catch (error) {
      assert.equal(error.name, "VideoBackendError");
      assert.equal(error.backendId, backendId);
      assert.equal(error.cause, "invalid-bundle");
      assert.ok(
        error.message.includes("assets/leak.json"),
        `[${backendId}] diagnostic must name the symlinked relative path: ${error.message}`,
      );
      assert.ok(!existsSync(workDir), `[${backendId}] prepare must fail before creating the workDir`);
    } finally {
      rmSync(tmpWorkDir, { recursive: true, force: true });
    }
  }
});

test("remotion renderStill without a prepared render is a typed invalid-prepared error (M4: real rendering)", async () => {
  const backend = getBackend("remotion");
  try {
    await backend.renderStill();
    assert.fail("should have thrown");
  } catch (error) {
    assert.equal(error.name, "VideoBackendError");
    assert.equal(error.cause, "invalid-prepared");
  }
});

test("hyperframes renderVideo without a prepared render is a typed invalid-prepared error (M5: real rendering)", async () => {
  const backend = getBackend("hyperframes");
  try {
    await backend.renderVideo();
    assert.fail("should have thrown");
  } catch (error) {
    assert.equal(error.name, "VideoBackendError");
    assert.equal(error.cause, "invalid-prepared");
  }
});

test("injectable probe overrides doctor checks", async () => {
  const { createRemotionBackend } = await import("../src/video/remotion/adapter.js");
  const probe = {
    async checkNodeVersion() {
      return { ok: true, command: "node", version: "v42.0.0" };
    },
    async getLocalPackageVersion(pkg) {
      return { ok: true, packageName: pkg, version: "99.0.0", pkgPath: "/fake/pkg", resolved: "file:///fake/pkg/index.js" };
    },
    async getLocalBinPath(pkg) {
      return { ok: true, packageName: pkg, binPath: "/fake/bin/path" };
    },
    async checkCommand(cmd) {
      return { ok: true, command: cmd, version: "fake 1.0.0" };
    },
  };
  const backend = createRemotionBackend({ probe });
  const report = await backend.doctor();
  assert.equal(report.status, "available");
  assert.equal(report.diagnostics.some((d) => d.message.includes("v99") || d.message.includes("v42")), true,
    "injected probe version should appear in diagnostics");
  assert.equal(report.exitCode, 0);
});

test("injectable probe for missing tools produces unavailable", async () => {
  const { createHyperFramesBackend } = await import("../src/video/hyperframes/adapter.js");
  const probe = {
    async checkNodeVersion() {
      return { ok: true, command: "node", version: "v24.0.0" };
    },
    async getLocalPackageVersion(pkg) {
      return { ok: false, packageName: pkg, message: "not found" };
    },
    async getLocalBinPath(pkg) {
      return { ok: false, packageName: pkg, message: "not found" };
    },
    async checkCommand(cmd) {
      return { ok: false, command: cmd, message: "not found" };
    },
  };
  const backend = createHyperFramesBackend({ probe });
  const report = await backend.doctor();
  assert.equal(report.status, "unavailable");
  assert.equal(report.exitCode, 2);
});

test("missing browser executable is an error, never fake success", async () => {
  const { createRemotionBackend } = await import("../src/video/remotion/adapter.js");
  const probe = {
    async checkNodeVersion() {
      return { ok: true, command: "node", version: "v22.0.0" };
    },
    async getLocalPackageVersion(pkg) {
      return { ok: true, packageName: pkg, version: "4.0.0", pkgPath: "/fake/pkg", resolved: "file:///fake/pkg" };
    },
    async getLocalBinPath(pkg) {
      return { ok: true, packageName: pkg, binPath: "/fake/bin" };
    },
    async checkCommand(cmd) {
      return { ok: true, command: cmd, version: "ffmpeg version 7" };
    },
    async checkBrowserExecutable() {
      return { ok: false, executable: null, message: "no browser anywhere" };
    },
  };
  const backend = createRemotionBackend({ probe });
  const report = await backend.doctor();
  const browserDiag = report.diagnostics.find((d) => d.message.toLowerCase().includes("browser"));
  assert.ok(browserDiag, "doctor must include a browser diagnostic");
  assert.equal(browserDiag.level, "error", "missing browser must be an error");
  assert.equal(report.status, "unavailable", "missing browser must not be fake success");
  assert.equal(report.exitCode, 2);
});

test("present browser executable is reported with path and version", async () => {
  const { createHyperFramesBackend } = await import("../src/video/hyperframes/adapter.js");
  const probe = {
    async checkNodeVersion() {
      return { ok: true, command: "node", version: "v24.0.0" };
    },
    async getLocalPackageVersion(pkg) {
      return { ok: true, packageName: pkg, version: "1.0.0", pkgPath: "/fake/pkg", resolved: "file:///fake/pkg" };
    },
    async getLocalBinPath(pkg) {
      return { ok: true, packageName: pkg, binPath: "/fake/bin" };
    },
    async checkCommand(cmd) {
      return { ok: true, command: cmd, version: "ffmpeg version 7" };
    },
    async checkBrowserExecutable() {
      return { ok: true, executable: "/usr/bin/chromium", version: "Chromium 141.0.0.0" };
    },
  };
  const backend = createHyperFramesBackend({ probe });
  const report = await backend.doctor();
  const browserDiag = report.diagnostics.find((d) => d.message.includes("Chromium 141"));
  assert.ok(browserDiag, "browser version must appear in diagnostics");
  assert.equal(browserDiag.level, "info");
  assert.equal(browserDiag.details.executable, "/usr/bin/chromium");
  assert.equal(report.status, "available");
  assert.equal(report.exitCode, 0);
});

test("package found but CLI binary missing is an error", async () => {
  const { createRemotionBackend } = await import("../src/video/remotion/adapter.js");
  const probe = {
    async checkNodeVersion() {
      return { ok: true, command: "node", version: "v22.0.0" };
    },
    async getLocalPackageVersion(pkg) {
      return { ok: true, packageName: pkg, version: "4.0.0", pkgPath: "/fake/pkg", resolved: "file:///fake/pkg" };
    },
    async getLocalBinPath(pkg) {
      return { ok: false, packageName: pkg, message: "package.json has no bin field" };
    },
    async checkCommand(cmd) {
      return { ok: true, command: cmd, version: "ffmpeg version 7" };
    },
    async checkBrowserExecutable() {
      return { ok: true, executable: "/usr/bin/chromium", version: "Chromium 141.0.0.0" };
    },
  };
  const backend = createRemotionBackend({ probe });
  const report = await backend.doctor();
  const binDiag = report.diagnostics.find((d) => d.message.includes("CLI binary not usable"));
  assert.ok(binDiag, "missing CLI binary must produce a diagnostic");
  assert.equal(binDiag.level, "error", "missing required CLI binary is an error");
  assert.equal(report.exitCode, 2);
});

test("package with missing/invalid version is unavailable, not success", async () => {
  const { createHyperFramesBackend } = await import("../src/video/hyperframes/adapter.js");
  for (const badVersion of [undefined, "unknown", ""]) {
    const probe = {
      async checkNodeVersion() {
        return { ok: true, command: "node", version: "v24.0.0" };
      },
      async getLocalPackageVersion(pkg) {
        return { ok: true, packageName: pkg, version: badVersion, pkgPath: "/fake/pkg", resolved: "file:///fake/pkg" };
      },
      async getLocalBinPath(pkg) {
        return { ok: true, packageName: pkg, binPath: "/fake/bin" };
      },
      async checkCommand(cmd) {
        return { ok: true, command: cmd, version: "ffmpeg version 7" };
      },
      async checkBrowserExecutable() {
        return { ok: true, executable: "/usr/bin/chromium", version: "Chromium 141.0.0.0" };
      },
    };
    const backend = createHyperFramesBackend({ probe });
    const report = await backend.doctor();
    assert.equal(report.status, "unavailable", `version ${JSON.stringify(badVersion)} must not count as available`);
    assert.equal(report.exitCode, 2);
  }
});

test("unparseable HyperFrames Node version must not become available", async () => {
  const { createHyperFramesBackend } = await import("../src/video/hyperframes/adapter.js");
  const probe = {
    async checkNodeVersion() {
      return { ok: true, command: "node", version: "vX.Y.Z" };
    },
    async getLocalPackageVersion(pkg) {
      return { ok: true, packageName: pkg, version: "1.0.0", pkgPath: "/fake/pkg", resolved: "file:///fake/pkg" };
    },
    async getLocalBinPath(pkg) {
      return { ok: true, packageName: pkg, binPath: "/fake/bin" };
    },
    async checkCommand(cmd) {
      return { ok: true, command: cmd, version: "ffmpeg version 7" };
    },
    async checkBrowserExecutable() {
      return { ok: true, executable: "/usr/bin/chromium", version: "Chromium 141.0.0.0" };
    },
  };
  const backend = createHyperFramesBackend({ probe });
  const report = await backend.doctor();
  const nodeDiag = report.diagnostics.find((d) => d.message.includes("could not be parsed"));
  assert.ok(nodeDiag, "unparseable node version must produce a parse-error diagnostic");
  assert.equal(nodeDiag.level, "error");
  assert.equal(report.status, "unavailable");
  assert.equal(report.exitCode, 2);
});

test("old HyperFrames Node version is an error", async () => {
  const { createHyperFramesBackend } = await import("../src/video/hyperframes/adapter.js");
  const probe = {
    async checkNodeVersion() {
      return { ok: true, command: "node", version: "v20.11.0" };
    },
    async getLocalPackageVersion(pkg) {
      return { ok: true, packageName: pkg, version: "1.0.0", pkgPath: "/fake/pkg", resolved: "file:///fake/pkg" };
    },
    async getLocalBinPath(pkg) {
      return { ok: true, packageName: pkg, binPath: "/fake/bin" };
    },
    async checkCommand(cmd) {
      return { ok: true, command: cmd, version: "ffmpeg version 7" };
    },
    async checkBrowserExecutable() {
      return { ok: true, executable: "/usr/bin/chromium", version: "Chromium 141.0.0.0" };
    },
  };
  const backend = createHyperFramesBackend({ probe });
  const report = await backend.doctor();
  const nodeDiag = report.diagnostics.find((d) => d.message.includes("too old"));
  assert.ok(nodeDiag);
  assert.equal(nodeDiag.level, "error");
  assert.equal(report.exitCode, 2);
});

const unsafeAdapterClipPropsCases = [
  ["undefined value", () => ({ bad: undefined })],
  ["function value", () => ({ bad: () => {} })],
  ["symbol value", () => ({ bad: Symbol("leak") })],
  ["bigint value", () => ({ bad: 123n })],
  ["NaN value", () => ({ bad: NaN })],
  ["Infinity value", () => ({ bad: Infinity })],
  ["sparse array", () => { const arr = []; arr[2] = "x"; return { list: arr }; }],
  ["ancestor cycle", () => { const c = { self: null }; c.self = c; return c; }],
  ["symbol-keyed property", () => { const o = { a: 1 }; o[Symbol("hidden")] = "leak"; return o; }],
  ["unsupported prototype", () => ({ bad: new (class Custom {})() })],
  ["symbol-keyed array", () => { const arr = [1, 2]; arr[Symbol("hidden")] = "leak"; return { list: arr }; }],
  ["custom-prototype array", () => ({ list: Object.setPrototypeOf([1], {}) })],
  ["array container", () => []],
];

for (const backendId of ["remotion", "hyperframes"]) {
  for (const [label, makeProps] of unsafeAdapterClipPropsCases) {
    test(`[${backendId}] prepare rejects unsafe clip inputProps (${label}) as invalid-plan before backend work`, async () => {
      const tmpWorkDir = mkdtempSync(join(tmpdir(), `lattice-video-unsafeprops-${backendId}-`));
      const bundleDir = makeValidBundle(tmpWorkDir);
      const backend = getBackend(backendId);
      const plan = makeEscapePlan(bundleDir);
      plan.clips[0].inputProps = makeProps();
      const workDir = join(tmpWorkDir, ".lattice", "generated", backendId);

      try {
        await backend.prepare({ plan, bundleDir, workDir, projectRoot: tmpWorkDir });
        assert.fail(`prepare must reject unsafe clip inputProps (${label})`);
      } catch (error) {
        assert.equal(error.name, "VideoBackendError", `${label}: ${error?.name}`);
        assert.equal(error.cause, "invalid-plan", `${label}: ${error?.message}`);
        assert.ok(
          error.message.includes("clips[0].inputProps"),
          `error must name the clip inputProps location (${label}): ${error.message}`,
        );
        assert.ok(
          !existsSync(workDir),
          `prepare must fail before creating any backend work directory (${label})`,
        );
      } finally {
        rmSync(tmpWorkDir, { recursive: true, force: true });
      }
    });
  }
}

const unsafeNonClipPlanCases = [
  ["function value in provenance.toolchain", (plan) => { plan.provenance.toolchain.node = () => {}; }, "provenance.toolchain"],
  ["non-string provenance.toolchain value", (plan) => { plan.provenance.toolchain.node = 42; }, "provenance.toolchain.node"],
  ["array provenance.toolchain", (plan) => { plan.provenance.toolchain = ["node-22"]; }, "provenance.toolchain must be"],
  ["undefined extra plan field", (plan) => { plan.extra = undefined; }, "$.extra"],
  ["symbol value on an audio track", (plan) => { plan.audioTracks.push({ id: "t", src: "x.mp3", startFrame: 0, meta: Symbol("leak") }); }, "audioTracks[0]"],
  ["symbol-keyed array outside inputProps", (plan) => { const arr = [1, 2]; arr[Symbol("hidden")] = "leak"; plan.list = arr; }, "$.list"],
  ["custom-prototype array outside inputProps", (plan) => { plan.list = Object.setPrototypeOf([1], {}); }, "$.list"],
];

for (const backendId of ["remotion", "hyperframes"]) {
  for (const [label, mutate, expectedLocation] of unsafeNonClipPlanCases) {
    test(`[${backendId}] prepare rejects unsafe non-clip plan values (${label}) as invalid-plan before bundle/workDir activity`, async () => {
      const tmpWorkDir = mkdtempSync(join(tmpdir(), `lattice-video-unsafenonclip-${backendId}-`));
      const bundleDir = makeValidBundle(tmpWorkDir);
      const backend = getBackend(backendId);
      const plan = makeCompletePlan({ deckId: "test", bundleDir });
      mutate(plan);
      const workDir = join(tmpWorkDir, ".lattice", "generated", backendId);
      const untouchedBundleDir = join(tmpWorkDir, "no-such-bundle");

      try {
        await backend.prepare({ plan, bundleDir: untouchedBundleDir, workDir, projectRoot: tmpWorkDir });
        assert.fail(`prepare must reject unsafe non-clip plan values (${label})`);
      } catch (error) {
        assert.equal(error.name, "VideoBackendError", `${label}: got ${error?.name}, not a wrapped backend error`);
        assert.equal(error.cause, "invalid-plan", `${label}: ${error?.message}`);
        assert.ok(
          error.message.includes(expectedLocation),
          `error must name the unsafe value location (${label}): ${error.message}`,
        );
        assert.ok(
          !existsSync(workDir),
          `prepare must fail before creating any backend work directory (${label})`,
        );
      } finally {
        rmSync(tmpWorkDir, { recursive: true, force: true });
      }
    });
  }
}
