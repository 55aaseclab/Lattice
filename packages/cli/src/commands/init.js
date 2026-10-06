import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const templateDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "templates", "project");

export async function initCommand({ args, rest }) {
  const targetDir = path.resolve(rest[0] ?? ".");
  const projectName = path.basename(targetDir);
  const theme = args.theme ?? "simple-light";

  if (fs.existsSync(path.join(targetDir, "lattice.config.js"))) {
    throw new Error(`refusing to overwrite existing Lattice project at ${targetDir}`);
  }
  if (!fs.existsSync(path.join(templateDir, "lattice.config.js"))) {
    throw new Error(`CLI project template is missing: ${templateDir}`);
  }

  fs.mkdirSync(targetDir, { recursive: true });
  fs.cpSync(templateDir, targetDir, { recursive: true });

  const runtimeDep = relativeFileDep(targetDir, path.resolve(templateDir, "..", "..", "..", "..", "runtime"));
  const cliDep = relativeFileDep(targetDir, path.resolve(templateDir, "..", "..", ".."));

  const packageJson = {
    name: projectName,
    version: "0.1.0",
    private: true,
    type: "module",
    scripts: {
      dev: "lattice dev",
      build: "lattice build",
      validate: "lattice validate",
      export: "lattice export",
      preview: "lattice preview",
    },
    dependencies: {
      "@55aaseclab/lattice-runtime": runtimeDep,
    },
    devDependencies: {
      "@55aaseclab/lattice-cli": cliDep,
    },
  };
  fs.writeFileSync(path.join(targetDir, "package.json"), `${JSON.stringify(packageJson, null, 2)}\n`);

  console.log(`[lattice] initialized Lattice project at ${targetDir}`);
  console.log(`[lattice] theme: ${theme}`);

  if (!args["no-install"]) {
    console.log("[lattice] installing dependencies (npm install)...");
    const install = spawnSync("npm", ["install", "--no-fund", "--no-audit"], { cwd: targetDir, stdio: "inherit" });
    if (install.status !== 0) {
      throw new Error("npm install failed");
    }
  }

  console.log(`
Next steps:
  cd ${targetDir}
  npm run dev                    # dev server with launcher
  npm run dev -- --deck demo     # open the demo deck directly
  npm run dev -- --deck demo --grid=1   # inspect the demo deck with its grid overlay
  npm run validate               # validate manifests, placements, and assets
  npm run build                  # build the portal to dist/
  npm run export -- --deck demo  # export a self-contained static deck`);
}

function relativeFileDep(fromDir, toDir) {
  return `file:${path.relative(fromDir, toDir).split(path.sep).join("/")}`;
}
