import { execFile, execFileSync } from "node:child_process";
import fsSync from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BackendDiagnostic } from "./backend-contract.js";
import { resolveChromiumExecutable } from "../commands/browser.js";

export async function checkCommand(command, args = ["--version"]) {
  return new Promise((resolve) => {
    const child = execFile(command, args, { timeout: 10000 }, (error, stdout, stderr) => {
      if (error) {
        resolve({ ok: false, command, message: `not found or failed: ${error.message}`, output: (stderr || "") + (stdout || "") });
      } else {
        const version = (stdout + stderr).trim().split("\n")[0] || "unknown";
        resolve({ ok: true, command, version });
      }
    });
    child.on("error", (error) => {
      resolve({ ok: false, command, message: `cannot spawn: ${error.message}`, output: "" });
    });
  });
}

/**
 * Return the directory of the package.json whose `name` equals the requested
 * package name, starting from `entryPath` and walking up. `entryPath` is
 * either a file inside the package (a resolved module entry point, where the
 * package root is an ancestor) or a candidate package directory itself (e.g.
 * <npm root -g>/<name>, whose own package.json must be checked first, not
 * skipped). This is the only reliable root resolution for scoped packages and
 * workspace symlinks: entry-point directory heuristics break for `@scope/pkg`
 * layouts.
 */
function resolvePackageRootByManifestName({ entryPath, packageName }) {
  let dir = path.resolve(entryPath);
  try {
    if (fsSync.statSync(dir).isFile()) dir = path.dirname(dir);
  } catch {
    dir = path.dirname(dir);
  }
  const root = path.parse(dir).root;
  for (;;) {
    try {
      const pkgJson = JSON.parse(fsSync.readFileSync(path.join(dir, "package.json"), "utf8"));
      if (pkgJson && pkgJson.name === packageName) {
        return dir;
      }
    } catch {
      // no readable package.json here; keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function resolvePackageRootFromUrl(resolvedUrl, packageName) {
  let entryPath;
  try {
    entryPath = fsSync.realpathSync(fileURLToPath(resolvedUrl));
  } catch {
    entryPath = fileURLToPath(resolvedUrl);
  }
  return resolvePackageRootByManifestName({ entryPath, packageName });
}

export async function checkNodePackage(packageName, { globalRoot, resolveSpecifier } = {}) {
  try {
    const resolved = import.meta.resolve(resolveSpecifier ?? packageName);
    const pkgDir = resolvePackageRootFromUrl(resolved, packageName);
    if (!pkgDir) {
      return {
        ok: false,
        packageName,
        message: `resolved to ${resolved} but no package.json with name "${packageName}" was found above it`,
      };
    }
    return { ok: true, packageName, resolved, pkgDir };
  } catch {
    try {
      const npmRoot = globalRoot ?? execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
      const globalPath = path.join(npmRoot, packageName);
      const globalStat = fsSync.statSync(globalPath);
      if (!globalStat.isDirectory()) throw new Error("not a directory");
      const pkgDir = resolvePackageRootByManifestName({ entryPath: globalPath, packageName });
      if (!pkgDir) {
        return {
          ok: false,
          packageName,
          message: `found ${globalPath} but its package.json does not declare name "${packageName}"`,
        };
      }
      return { ok: true, packageName, resolved: globalPath, pkgDir };
    } catch {
      return { ok: false, packageName, message: `package not found: ${packageName}` };
    }
  }
}

export function isValidPackageVersion(version) {
  return typeof version === "string" && version.length > 0 && version !== "unknown";
}

export async function getLocalPackageVersion(packageName, options = {}) {
  const pkgCheck = await checkNodePackage(packageName, options);
  if (!pkgCheck.ok) return { ok: false, packageName, message: pkgCheck.message };
  try {
    const pkgJsonPath = path.join(pkgCheck.pkgDir, "package.json");
    const pkgJson = JSON.parse(await fsSync.promises.readFile(pkgJsonPath, "utf8"));
    const version = pkgJson.version;
    if (!isValidPackageVersion(version)) {
      return {
        ok: false,
        packageName,
        message: `package found at ${pkgCheck.pkgDir} but its version is missing or invalid (${JSON.stringify(version ?? null)})`,
      };
    }
    return {
      ok: true,
      packageName,
      version,
      pkgPath: pkgCheck.pkgDir,
      resolved: pkgCheck.resolved,
    };
  } catch (e) {
    return { ok: false, packageName, message: `cannot read package.json: ${e.message}` };
  }
}

export async function getLocalBinPath(packageName, binName, options = {}) {
  const pkgCheck = await checkNodePackage(packageName, options);
  if (!pkgCheck.ok) return { ok: false, packageName, message: pkgCheck.message };
  try {
    const pkgJsonPath = path.join(pkgCheck.pkgDir, "package.json");
    const pkgJson = JSON.parse(await fsSync.promises.readFile(pkgJsonPath, "utf8"));
    if (!pkgJson.bin) return { ok: false, packageName, message: "package.json has no bin field" };
    let binRelative;
    if (typeof pkgJson.bin === "string") {
      binRelative = pkgJson.bin;
    } else if (binName) {
      // An explicitly requested bin name must match an exact object key;
      // silently substituting another bin hides real breakage.
      binRelative = pkgJson.bin[binName];
    } else {
      binRelative = Object.values(pkgJson.bin)[0];
    }
    if (!binRelative) return { ok: false, packageName, message: `no bin entry for ${binName || packageName}` };
    const binPath = path.resolve(pkgCheck.pkgDir, binRelative);
    await fsSync.promises.access(binPath, fsSync.constants.R_OK);
    return { ok: true, packageName, binPath, pkgDir: pkgCheck.pkgDir };
  } catch (e) {
    return { ok: false, packageName, message: `cannot resolve bin path: ${e.message}` };
  }
}

export async function checkCommandVersion(command, args = ["--version"]) {
  try {
    const { execFileSync } = await import("node:child_process");
    const output = execFileSync(command, args, { encoding: "utf8", timeout: 10000 }).trim();
    return { ok: true, command, version: output.split("\n")[0] };
  } catch {
    return { ok: false, command, message: `cannot run ${command}` };
  }
}

export async function checkNodeVersion() {
  return {
    ok: true,
    command: "node",
    version: process.version,
  };
}

/**
 * Honest browser diagnostic: a real executable must be found (explicit path,
 * LATTICE_CHROMIUM, Playwright cache, or system install) and must report a
 * version. A missing or non-runnable browser is never a fake success.
 */
export async function checkBrowserExecutable({ env = process.env } = {}) {
  const executable = resolveChromiumExecutable({ env });
  if (!executable) {
    return {
      ok: false,
      executable: null,
      message: "searched LATTICE_CHROMIUM, Playwright browser cache, and system Chrome/Chromium locations",
    };
  }
  const versionCheck = await checkCommand(executable, ["--version"]);
  if (!versionCheck.ok) {
    return {
      ok: false,
      executable,
      message: `found ${executable} but it is not runnable: ${versionCheck.message}`,
    };
  }
  return { ok: true, executable, version: versionCheck.version };
}

export function formatMissingToolDiagnostic({ command, message }) {
  return new BackendDiagnostic({
    level: "error",
    message: `Missing required tool: ${command}`,
    details: { command, error: message },
  });
}

export function formatMissingPackageDiagnostic({ packageName, message }) {
  return new BackendDiagnostic({
    level: "error",
    message: `Missing required package: ${packageName}`,
    details: { packageName, error: message },
  });
}

export function formatInstallGuidance(diagnostics, installInstructions) {
  return {
    status: diagnostics.some((d) => d.level === "error") ? "unavailable" : "available",
    missingCount: diagnostics.filter((d) => d.level === "error").length,
    totalCount: diagnostics.length,
    diagnostics,
    installInstructions,
    exitCode: diagnostics.some((d) => d.level === "error") ? 2 : 0,
  };
}
