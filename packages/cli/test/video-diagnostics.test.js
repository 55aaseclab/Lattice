import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { checkNodePackage, getLocalBinPath } from "../src/video/diagnostics.js";

// Deterministic fake "<npm root -g>" layouts: these tests never depend on the
// globally installed packages of the machine running them (except the two
// explicitly conditional real-environment tests at the end).
function makeFakeGlobalRoot() {
  return mkdtempSync(join(tmpdir(), "lattice-diagnostics-global-"));
}

function installFakeGlobalPackage(globalRoot, dirName, manifest, extraFiles = []) {
  const dir = join(globalRoot, dirName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify(manifest), "utf8");
  for (const rel of extraFiles) {
    const target = join(dir, rel);
    mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "#!/bin/sh\nexit 0\n", "utf8");
  }
  return dir;
}

test("global fallback checks the candidate package directory's own package.json", async () => {
  const globalRoot = makeFakeGlobalRoot();
  try {
    const dir = installFakeGlobalPackage(globalRoot, "fake-global-tool", {
      name: "fake-global-tool",
      version: "1.0.0",
    });
    const result = await checkNodePackage("fake-global-tool", { globalRoot });
    assert.equal(result.ok, true, `expected ok, got: ${result.message}`);
    assert.equal(result.pkgDir, dir);
    assert.equal(result.resolved, dir);
  } finally {
    rmSync(globalRoot, { recursive: true, force: true });
  }
});

test("global fallback resolves scoped package directories by manifest name", async () => {
  const globalRoot = makeFakeGlobalRoot();
  try {
    const dir = installFakeGlobalPackage(globalRoot, join("@fake-scope", "fake-scoped-tool"), {
      name: "@fake-scope/fake-scoped-tool",
      version: "2.0.0",
    });
    const result = await checkNodePackage("@fake-scope/fake-scoped-tool", { globalRoot });
    assert.equal(result.ok, true, `expected ok, got: ${result.message}`);
    assert.equal(result.pkgDir, dir);
  } finally {
    rmSync(globalRoot, { recursive: true, force: true });
  }
});

test("global fallback rejects a candidate directory whose manifest declares a different name", async () => {
  const globalRoot = makeFakeGlobalRoot();
  try {
    installFakeGlobalPackage(globalRoot, "fake-mismatched", {
      name: "some-other-name",
      version: "1.0.0",
    });
    const result = await checkNodePackage("fake-mismatched", { globalRoot });
    assert.equal(result.ok, false);
    assert.ok(result.message.includes("does not declare name"), result.message);
    assert.ok(result.message.includes('"fake-mismatched"'), result.message);
  } finally {
    rmSync(globalRoot, { recursive: true, force: true });
  }
});

test("global fallback reports not found when the candidate directory is absent", async () => {
  const globalRoot = makeFakeGlobalRoot();
  try {
    const result = await checkNodePackage("fake-absent-tool", { globalRoot });
    assert.equal(result.ok, false);
    assert.ok(result.message.includes("package not found"), result.message);
  } finally {
    rmSync(globalRoot, { recursive: true, force: true });
  }
});

test("local node_modules resolution still walks up from the resolved entry file to the manifest", async () => {
  const result = await checkNodePackage("vite");
  assert.equal(result.ok, true, `vite is a dependency of this package; got: ${result.message}`);
  const manifest = JSON.parse(readFileSync(join(result.pkgDir, "package.json"), "utf8"));
  assert.equal(manifest.name, "vite");
});

test("getLocalBinPath picks the exact requested key among multiple bins and never falls back", async () => {
  const globalRoot = makeFakeGlobalRoot();
  try {
    const dir = installFakeGlobalPackage(
      globalRoot,
      "fake-multi-bin",
      {
        name: "fake-multi-bin",
        version: "1.0.0",
        bin: { alpha: "./bin/alpha.js", beta: "./bin/beta.js" },
      },
      ["bin/alpha.js", "bin/beta.js"],
    );
    const beta = await getLocalBinPath("fake-multi-bin", "beta", { globalRoot });
    assert.equal(beta.ok, true, `expected ok, got: ${beta.message}`);
    assert.equal(beta.binPath, join(dir, "bin", "beta.js"));

    const wrong = await getLocalBinPath("fake-multi-bin", "definitely-wrong", { globalRoot });
    assert.equal(wrong.ok, false, "a wrong bin name must not fall back to an arbitrary first bin");
    assert.ok(wrong.message.includes("definitely-wrong"), wrong.message);
  } finally {
    rmSync(globalRoot, { recursive: true, force: true });
  }
});

test("getLocalBinPath requires the exact key even for a single-bin object", async () => {
  const globalRoot = makeFakeGlobalRoot();
  try {
    const dir = installFakeGlobalPackage(
      globalRoot,
      "fake-single-bin",
      {
        name: "fake-single-bin",
        version: "1.0.0",
        bin: { "fake-single-bin": "./bin/cli.js" },
      },
      ["bin/cli.js"],
    );
    const right = await getLocalBinPath("fake-single-bin", "fake-single-bin", { globalRoot });
    assert.equal(right.ok, true, `expected ok, got: ${right.message}`);
    assert.equal(right.binPath, join(dir, "bin", "cli.js"));

    const wrong = await getLocalBinPath("fake-single-bin", "other", { globalRoot });
    assert.equal(wrong.ok, false, "the only bin must not be substituted for a different requested name");
    assert.ok(wrong.message.includes("other"), wrong.message);
  } finally {
    rmSync(globalRoot, { recursive: true, force: true });
  }
});

test("getLocalBinPath resolves string-form bin according to npm semantics", async () => {
  const globalRoot = makeFakeGlobalRoot();
  try {
    const dir = installFakeGlobalPackage(
      globalRoot,
      "fake-string-bin",
      { name: "fake-string-bin", version: "1.0.0", bin: "./cli.js" },
      ["cli.js"],
    );
    const result = await getLocalBinPath("fake-string-bin", "fake-string-bin", { globalRoot });
    assert.equal(result.ok, true, `expected ok, got: ${result.message}`);
    assert.equal(result.binPath, join(dir, "cli.js"));
  } finally {
    rmSync(globalRoot, { recursive: true, force: true });
  }
});

test("getLocalBinPath fails honestly when the bin field is absent", async () => {
  const globalRoot = makeFakeGlobalRoot();
  try {
    installFakeGlobalPackage(globalRoot, "fake-no-bin", { name: "fake-no-bin", version: "1.0.0" });
    const result = await getLocalBinPath("fake-no-bin", "fake-no-bin", { globalRoot });
    assert.equal(result.ok, false);
    assert.ok(result.message.includes("no bin field"), result.message);
  } finally {
    rmSync(globalRoot, { recursive: true, force: true });
  }
});

test("getLocalBinPath fails when the declared bin file is missing", async () => {
  const globalRoot = makeFakeGlobalRoot();
  try {
    installFakeGlobalPackage(globalRoot, "fake-dead-bin", {
      name: "fake-dead-bin",
      version: "1.0.0",
      bin: { "fake-dead-bin": "./bin/missing.js" },
    });
    const result = await getLocalBinPath("fake-dead-bin", "fake-dead-bin", { globalRoot });
    assert.equal(result.ok, false);
    assert.ok(result.message.includes("cannot resolve bin path"), result.message);
  } finally {
    rmSync(globalRoot, { recursive: true, force: true });
  }
});

test("getLocalBinPath fails when the declared bin file is unreadable", async (t) => {
  if (typeof process.getuid === "function" && process.getuid() === 0) {
    return t.skip("running as root ignores file permissions");
  }
  const globalRoot = makeFakeGlobalRoot();
  try {
    const dir = installFakeGlobalPackage(
      globalRoot,
      "fake-locked-bin",
      { name: "fake-locked-bin", version: "1.0.0", bin: { "fake-locked-bin": "./bin/locked.js" } },
      ["bin/locked.js"],
    );
    chmodSync(join(dir, "bin", "locked.js"), 0o000);
    const result = await getLocalBinPath("fake-locked-bin", "fake-locked-bin", { globalRoot });
    chmodSync(join(dir, "bin", "locked.js"), 0o644);
    assert.equal(result.ok, false, "an unreadable bin must not be reported as usable");
    assert.ok(result.message.includes("cannot resolve bin path"), result.message);
  } finally {
    rmSync(globalRoot, { recursive: true, force: true });
  }
});

test("getLocalBinPath with the exact key resolves vite in this worktree; a wrong key fails", async () => {
  const right = await getLocalBinPath("vite", "vite");
  assert.equal(right.ok, true, `vite bin must resolve in this worktree: ${right.message}`);
  assert.ok(right.binPath.startsWith(right.pkgDir), right.binPath);

  const wrong = await getLocalBinPath("vite", "definitely-wrong");
  assert.equal(wrong.ok, false, "a wrong bin name must not fall back to vite's arbitrary first bin");
  assert.ok(wrong.message.includes("definitely-wrong"), wrong.message);
});

test("checkNodePackage accepts packages genuinely installed under npm root -g", async (t) => {
  let npmRoot;
  try {
    npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
  } catch {
    return t.skip("npm is not available on PATH to query its global root");
  }
  for (const name of ["npm", "corepack"]) {
    let installed = true;
    try {
      installed = statSync(join(npmRoot, name)).isDirectory();
    } catch {
      installed = false;
    }
    if (!installed) continue;
    const result = await checkNodePackage(name);
    assert.equal(result.ok, true, `global ${name} must resolve, got: ${result.message}`);
    const manifest = JSON.parse(readFileSync(join(result.pkgDir, "package.json"), "utf8"));
    assert.equal(manifest.name, name);
  }
});
