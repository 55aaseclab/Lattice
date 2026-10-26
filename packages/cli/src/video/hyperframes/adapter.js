import { promises as fs } from "node:fs";
import path from "node:path";
import { validateVideoPlan, hashVideoPlan, serializeVideoPlan } from "@55aaseclab/lattice-runtime/video-plan";
import {
  BackendDiagnostic,
  PreparedRender,
  VideoBackendError,
} from "../backend-contract.js";
import { resolveGeneratedWorkDir } from "../generated-path.js";
import { validateSlideWebBundle } from "../bundle.js";
import {
  checkCommand,
  getLocalPackageVersion,
  getLocalBinPath,
  checkCommandVersion,
  checkBrowserExecutable,
  isValidPackageVersion,
  formatMissingToolDiagnostic,
  formatInstallGuidance,
} from "../diagnostics.js";

export const HYPERFRAMES_BACKEND_ID = "hyperframes";

function asBackendError(error, backendId) {
  if (error instanceof VideoBackendError) {
    return new VideoBackendError(error.message, {
      backendId,
      diagnostics: error.diagnostics,
      cause: error.cause,
    });
  }
  return error;
}

export function createHyperFramesBackend({ probe = null } = {}) {
  const probeHost = {
    async checkNodeVersion() {
      const { checkNodeVersion: cnv } = await import("../diagnostics.js");
      return cnv();
    },
    async checkCommandVersion(cmd, args) {
      const { checkCommandVersion: ccv } = await import("../diagnostics.js");
      return ccv(cmd, args);
    },
    async checkNodePackage(pkg) {
      const { checkNodePackage: cnp } = await import("../diagnostics.js");
      return cnp(pkg);
    },
    async getLocalPackageVersion(pkg) {
      const { getLocalPackageVersion: glpv } = await import("../diagnostics.js");
      return glpv(pkg);
    },
    async getLocalBinPath(pkg, binName) {
      const { getLocalBinPath: glbp } = await import("../diagnostics.js");
      return glbp(pkg, binName);
    },
    async checkCommand(cmd, args) {
      const { checkCommand: cc } = await import("../diagnostics.js");
      return cc(cmd, args);
    },
    async checkBrowserExecutable(options) {
      const { checkBrowserExecutable: cbe } = await import("../diagnostics.js");
      return cbe(options);
    },
    ...probe,
  };

  return {
    id: HYPERFRAMES_BACKEND_ID,

    async doctor() {
      const diagnostics = [];

      const nodeCheck = await probeHost.checkNodeVersion();
      if (!nodeCheck.ok) {
        diagnostics.push(new BackendDiagnostic({
          level: "error",
          message: `Node.js not found: ${nodeCheck.message || nodeCheck.version}`,
          details: { command: "node" },
        }));
      } else {
        const nodeVersion = nodeCheck.version.replace(/^v/, "");
        const major = Number(nodeVersion.split(".")[0]);
        if (!Number.isInteger(major)) {
          // An unparseable version must never be reported as available.
          diagnostics.push(new BackendDiagnostic({
            level: "error",
            message: `Node.js version "${nodeCheck.version}" could not be parsed. HyperFrames requires Node.js >=22.`,
            details: { command: "node", version: nodeCheck.version, required: ">=22" },
          }));
        } else if (major < 22) {
          diagnostics.push(new BackendDiagnostic({
            level: "error",
            message: `Node.js ${nodeCheck.version} is too old. HyperFrames requires Node.js >=22. Current: ${nodeCheck.version}`,
            details: { command: "node", version: nodeCheck.version, required: ">=22" },
          }));
        } else {
          diagnostics.push(new BackendDiagnostic({
            level: "info",
            message: `Node.js: ${nodeCheck.version} (HyperFrames requires >=22)`,
            details: { command: "node", version: nodeCheck.version, required: ">=22" },
          }));
        }
      }

      const hyperframesInfo = await probeHost.getLocalPackageVersion("hyperframes");
      if (!hyperframesInfo.ok || !isValidPackageVersion(hyperframesInfo.version)) {
        diagnostics.push(new BackendDiagnostic({
          level: "error",
          message: `HyperFrames not found or its version is missing/invalid. Install with: npm install hyperframes`,
          details: {
            package: "hyperframes",
            install: "npm install hyperframes",
            binary: "npx hyperframes",
            error: hyperframesInfo.ok ? `invalid version: ${JSON.stringify(hyperframesInfo.version ?? null)}` : hyperframesInfo.message,
          },
        }));
      } else {
        const binInfo = await probeHost.getLocalBinPath("hyperframes", "hyperframes");
        if (!binInfo.ok) {
          diagnostics.push(new BackendDiagnostic({
            level: "error",
            message: `HyperFrames CLI binary not usable: ${binInfo.message}. Reinstall with: npm install hyperframes`,
            details: {
              package: "hyperframes",
              version: hyperframesInfo.version,
              pkgPath: hyperframesInfo.pkgPath,
              error: binInfo.message,
            },
          }));
        } else {
          diagnostics.push(new BackendDiagnostic({
            level: "info",
            message: `HyperFrames v${hyperframesInfo.version} found at ${hyperframesInfo.pkgPath} (bin: ${binInfo.binPath})`,
            details: {
              package: "hyperframes",
              resolved: hyperframesInfo.resolved,
              pkgPath: hyperframesInfo.pkgPath,
              version: hyperframesInfo.version,
              binPath: binInfo.binPath,
              binary: "hyperframes",
            },
          }));
        }
      }

      const ffmpegCheck = await probeHost.checkCommand("ffmpeg", ["-version"]);
      if (!ffmpegCheck.ok) {
        diagnostics.push(formatMissingToolDiagnostic(ffmpegCheck));
      } else {
        diagnostics.push(new BackendDiagnostic({
          level: "info",
          message: `ffmpeg: ${ffmpegCheck.version}`,
          details: { command: "ffmpeg", version: ffmpegCheck.version },
        }));
      }

      const ffprobeCheck = await probeHost.checkCommand("ffprobe", ["-version"]);
      if (!ffprobeCheck.ok) {
        diagnostics.push(formatMissingToolDiagnostic(ffprobeCheck));
      } else {
        diagnostics.push(new BackendDiagnostic({
          level: "info",
          message: `ffprobe: ${ffprobeCheck.version}`,
          details: { command: "ffprobe", version: ffprobeCheck.version },
        }));
      }

      const browserCheck = await probeHost.checkBrowserExecutable();
      if (!browserCheck.ok) {
        diagnostics.push(new BackendDiagnostic({
          level: "error",
          message: `No Chromium/Chrome browser executable found (${browserCheck.message}). Rendering requires a browser; pass LATTICE_CHROMIUM or install Chromium/Chrome.`,
          details: { command: "browser", error: browserCheck.message },
        }));
      } else {
        diagnostics.push(new BackendDiagnostic({
          level: "info",
          message: `Browser: ${browserCheck.version} at ${browserCheck.executable}`,
          details: { command: "browser", executable: browserCheck.executable, version: browserCheck.version },
        }));
      }

      return formatInstallGuidance(diagnostics, {
        node: ">=22 (required by HyperFrames)",
        requiredPackages: ["hyperframes"],
        requiredTools: ["ffmpeg", "ffprobe", "chromium"],
        installHyperFrames: "npm install hyperframes",
        cliUsage: "npx hyperframes",
        installFfmpeg: "apt-get install ffmpeg  /  brew install ffmpeg  /  choco install ffmpeg",
        installBrowser: "npx playwright install chromium  /  apt-get install chromium  /  set LATTICE_CHROMIUM",
      });
    },

    async prepare({ plan, bundleDir, workDir, projectRoot }) {
      if (!plan || typeof plan !== "object") {
        throw new VideoBackendError(
          "prepare requires a valid plan object",
          { backendId: HYPERFRAMES_BACKEND_ID, diagnostics: [], cause: "invalid-prepare-args" },
        );
      }

      const planValidation = validateVideoPlan(plan);
      if (!planValidation.ok) {
        throw new VideoBackendError(
          `prepare received invalid plan: ${planValidation.errors.join("; ")}`,
          {
            backendId: HYPERFRAMES_BACKEND_ID,
            diagnostics: planValidation.errors.map((e) => new BackendDiagnostic({ level: "error", message: e })),
            cause: "invalid-plan",
          },
        );
      }

      let bundleInfo;
      try {
        bundleInfo = validateSlideWebBundle({ bundleDir, deckId: plan.deckId });
      } catch (error) {
        throw asBackendError(error, HYPERFRAMES_BACKEND_ID);
      }

      if (plan.provenance.bundleHash !== bundleInfo.bundleHash) {
        throw new VideoBackendError(
          `plan provenance.bundleHash (${plan.provenance.bundleHash}) does not match the actual Slide Web Bundle hash (${bundleInfo.bundleHash}) for deck "${plan.deckId}". Re-run "lattice video plan" against this bundle.`,
          { backendId: HYPERFRAMES_BACKEND_ID, diagnostics: [], cause: "bundle-mismatch" },
        );
      }

      const planHash = hashVideoPlan(plan);
      let safeWorkDir;
      try {
        safeWorkDir = resolveGeneratedWorkDir({ workDir, backendId: HYPERFRAMES_BACKEND_ID, projectRoot });
      } catch (error) {
        throw asBackendError(error, HYPERFRAMES_BACKEND_ID);
      }

      await fs.mkdir(safeWorkDir, { recursive: true });

      const headerLines = [
        "DO NOT EDIT — generated by Lattice HyperFrames adapter",
        `plan-hash: ${planHash}`,
        `bundle-hash: ${bundleInfo.bundleHash}`,
        `deck: ${plan.deckId}`,
        `route: ${plan.routeId}`,
        `backend: ${HYPERFRAMES_BACKEND_ID}`,
        "---",
        "HyperFrames adapter foundation (M3). Still and video rendering require",
        "installed HyperFrames (npm install hyperframes).",
        "Run: lattice video doctor --backend hyperframes",
        "",
      ];

      await fs.writeFile(
        path.join(safeWorkDir, "LATTICE_HYPERFRAMES.md"),
        headerLines.join("\n"),
        "utf8",
      );

      const canonicalPlanBytes = serializeVideoPlan(plan);
      await fs.writeFile(
        path.join(safeWorkDir, "video-plan.json"),
        canonicalPlanBytes,
        "utf8",
      );

      const hyperframesProject = {
        schema: "lattice.hyperframes-project.v1",
        planHash,
        deckId: plan.deckId,
        routeId: plan.routeId,
        bundleDir: bundleInfo.bundlePath,
        bundleHash: bundleInfo.bundleHash,
        videoPlanPath: path.join(safeWorkDir, "video-plan.json"),
      };

      await fs.writeFile(
        path.join(safeWorkDir, "hyperframes-project.json"),
        JSON.stringify(hyperframesProject, null, 2),
        "utf8",
      );

      return new PreparedRender({
        backendId: HYPERFRAMES_BACKEND_ID,
        planHash,
        workDir: safeWorkDir,
        bundlePath: bundleInfo.bundlePath,
        bundleHash: bundleInfo.bundleHash,
      });
    },

    async renderStill() {
      throw new VideoBackendError(
        "HyperFrames still rendering not available at M3. " +
        "Install hyperframes and check with: " +
        "lattice video doctor --backend hyperframes",
        { backendId: HYPERFRAMES_BACKEND_ID, diagnostics: [], cause: "unsupported-render-method" },
      );
    },

    async renderVideo() {
      throw new VideoBackendError(
        "HyperFrames video rendering not available at M3. " +
        "Install hyperframes and check with: " +
        "lattice video doctor --backend hyperframes",
        { backendId: HYPERFRAMES_BACKEND_ID, diagnostics: [], cause: "unsupported-render-method" },
      );
    },

    async inspectArtifact() {
      throw new VideoBackendError(
        "Artifact inspection requires ffprobe. Check with: lattice video doctor --backend hyperframes",
        { backendId: HYPERFRAMES_BACKEND_ID, diagnostics: [], cause: "unsupported-render-method" },
      );
    },
  };
}
