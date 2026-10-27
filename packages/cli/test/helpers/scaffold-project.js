// Test helper: scaffold a template deck into an existing project directory
// (in-process), wiring node_modules so the scaffolded deck resolves the
// runtime package the same way an installed project would.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const cliRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const defaultRuntimeRoot = path.resolve(cliRoot, "..", "runtime");

export function scaffoldTemplate(projectDir, templateId, vars = {}, { runtimeRoot = defaultRuntimeRoot } = {}) {
  const decksDir = path.join(projectDir, "decks");
  fs.mkdirSync(decksDir, { recursive: true });
  const args = [
    path.join(cliRoot, "src", "index.js"),
    "template", "scaffold", templateId, "--deck", vars.deckId,
  ];
  if (vars.title) args.push("--title", vars.title);
  if (vars.stages !== undefined) args.push("--stages", String(vars.stages));
  const result = spawnSync(process.execPath, args, { cwd: projectDir, encoding: "utf8", timeout: 120000 });
  if (result.status !== 0) {
    throw new Error(`template scaffold failed: ${result.stderr || result.stdout}`);
  }
  if (runtimeRoot) {
    // Wire node_modules so the scaffolded deck resolves the runtime package
    // exactly like an installed project would.
    const nodeModules = path.join(projectDir, "node_modules", "@55aaseclab");
    fs.mkdirSync(nodeModules, { recursive: true });
    const link = path.join(nodeModules, "lattice-runtime");
    try {
      fs.symlinkSync(runtimeRoot, link, "dir");
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  return path.join(decksDir, vars.deckId);
}
