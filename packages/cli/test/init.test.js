import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { initCommand } from "../src/commands/init.js";

function packageFrom(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
}

test("init uses registry semver dependencies by default", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-init-"));
  const target = path.join(parent, "registry-project");
  await initCommand({ args: { "no-install": true }, rest: [target] });

  const packageJson = packageFrom(target);
  assert.equal(packageJson.dependencies["@55aaseclab/lattice-runtime"], "^0.1.2");
  assert.equal(packageJson.devDependencies["@55aaseclab/lattice-cli"], "^0.1.2");
  assert.equal(Object.values(packageJson.dependencies).some((value) => value.startsWith("file:")), false);
  assert.equal(Object.values(packageJson.devDependencies).some((value) => value.startsWith("file:")), false);
});

test("init supports explicit local monorepo dependencies", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-init-local-"));
  const target = path.join(parent, "local-project");
  await initCommand({ args: { local: true, "no-install": true }, rest: [target] });

  const packageJson = packageFrom(target);
  assert.match(packageJson.dependencies["@55aaseclab/lattice-runtime"], /^file:/);
  assert.match(packageJson.devDependencies["@55aaseclab/lattice-cli"], /^file:/);
});
