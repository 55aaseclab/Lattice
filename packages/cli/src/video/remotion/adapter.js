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

export const REMOTION_BACKEND_ID = "remotion";

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

export function createRemotionBackend({ probe = null } = {}) {
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
    id: REMOTION_BACKEND_ID,

    async doctor() {
      const diagnostics = [];

      const nodeCheck = await probeHost.checkNodeVersion();
      if (!nodeCheck.ok) {
        diagnostics.push(new BackendDiagnostic({
          level: "error",
          message: `Node.js not found or incompatible: ${nodeCheck.message || nodeCheck.version}`,
          details: { command: "node" },
        }));
      } else {
        const nodeVersion = nodeCheck.version.replace(/^v/, "");
        const major = Number(nodeVersion.split(".")[0]);
        if (!Number.isInteger(major)) {
          diagnostics.push(new BackendDiagnostic({
            level: "error",
            message: `Node.js version "${nodeCheck.version}" could not be parsed. Remotion requires Node.js >=18.`,
            details: { command: "node", version: nodeCheck.version, required: ">=18" },
          }));
        } else if (major < 18) {
          diagnostics.push(new BackendDiagnostic({
            level: "error",
            message: `Node.js ${nodeCheck.version} is too old. Remotion requires Node.js >=18. Current: ${nodeCheck.version}`,
            details: { command: "node", version: nodeCheck.version, required: ">=18" },
          }));
        } else {
          diagnostics.push(new BackendDiagnostic({
            level: "info",
            message: `Node.js: ${nodeCheck.version} (Remotion requires >=18)`,
            details: { command: "node", version: nodeCheck.version, required: ">=18" },
          }));
        }
      }

      const remotionCliInfo = await probeHost.getLocalPackageVersion("@remotion/cli");
      if (!remotionCliInfo.ok || !isValidPackageVersion(remotionCliInfo.version)) {
        diagnostics.push(new BackendDiagnostic({
          level: "error",
          message: `Remotion CLI not found or its version is missing/invalid. Install with: npm install @remotion/cli`,
          details: {
            package: "@remotion/cli",
            install: "npm install @remotion/cli",
            error: remotionCliInfo.ok ? `invalid version: ${JSON.stringify(remotionCliInfo.version ?? null)}` : remotionCliInfo.message,
          },
        }));
      } else {
        const binInfo = await probeHost.getLocalBinPath("@remotion/cli", "remotion");
        if (!binInfo.ok) {
          // A usable backend needs the actual CLI binary, not just the package
          // directory: a package without its bin is not renderable.
          diagnostics.push(new BackendDiagnostic({
            level: "error",
            message: `Remotion CLI binary not usable: ${binInfo.message}. Reinstall with: npm install @remotion/cli`,
            details: {
              package: "@remotion/cli",
              version: remotionCliInfo.version,
              pkgPath: remotionCliInfo.pkgPath,
              error: binInfo.message,
            },
          }));
        } else {
          diagnostics.push(new BackendDiagnostic({
            level: "info",
            message: `Remotion CLI v${remotionCliInfo.version} at ${remotionCliInfo.pkgPath} (bin: ${binInfo.binPath})`,
            details: {
              package: "@remotion/cli",
              resolved: remotionCliInfo.resolved,
              pkgPath: remotionCliInfo.pkgPath,
              version: remotionCliInfo.version,
              binPath: binInfo.binPath,
            },
          }));
        }
      }

      const rendererInfo = await probeHost.getLocalPackageVersion("@remotion/renderer");
      if (!rendererInfo.ok || !isValidPackageVersion(rendererInfo.version)) {
        diagnostics.push(new BackendDiagnostic({
          level: "error",
          message: `@remotion/renderer not found or its version is missing/invalid. Install with: npm install @remotion/renderer`,
          details: {
            package: "@remotion/renderer",
            install: "npm install @remotion/renderer",
            error: rendererInfo.ok ? `invalid version: ${JSON.stringify(rendererInfo.version ?? null)}` : rendererInfo.message,
          },
        }));
      } else {
        diagnostics.push(new BackendDiagnostic({
          level: "info",
          message: `Remotion renderer v${rendererInfo.version} at ${rendererInfo.pkgPath}`,
          details: {
            package: "@remotion/renderer",
            resolved: rendererInfo.resolved,
            pkgPath: rendererInfo.pkgPath,
            version: rendererInfo.version,
          },
        }));
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

      // Frame rendering needs a real browser executable. A missing browser is
      // an error, never a fake success.
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
        node: ">=18 (required)",
        requiredPackages: ["@remotion/cli", "@remotion/renderer"],
        requiredTools: ["ffmpeg", "ffprobe", "chromium"],
        installRemotion: "npm install @remotion/cli @remotion/renderer react react-dom",
        installFfmpeg: "apt-get install ffmpeg  /  brew install ffmpeg  /  choco install ffmpeg",
        installBrowser: "npx playwright install chromium  /  apt-get install chromium  /  set LATTICE_CHROMIUM",
      });
    },

    async prepare({ plan, bundleDir, workDir, projectRoot }) {
      if (!plan || typeof plan !== "object") {
        throw new VideoBackendError(
          "prepare requires a valid plan object",
          { backendId: REMOTION_BACKEND_ID, diagnostics: [], cause: "invalid-prepare-args" },
        );
      }

      const planValidation = validateVideoPlan(plan);
      if (!planValidation.ok) {
        throw new VideoBackendError(
          `prepare received invalid plan: ${planValidation.errors.join("; ")}`,
          {
            backendId: REMOTION_BACKEND_ID,
            diagnostics: planValidation.errors.map((e) => new BackendDiagnostic({ level: "error", message: e })),
            cause: "invalid-plan",
          },
        );
      }

      let bundleInfo;
      try {
        bundleInfo = validateSlideWebBundle({ bundleDir, deckId: plan.deckId });
      } catch (error) {
        throw asBackendError(error, REMOTION_BACKEND_ID);
      }

      // Consume the bundle identity: a plan whose provenance names a different
      // bundle must never be prepared against this one.
      if (plan.provenance.bundleHash !== bundleInfo.bundleHash) {
        throw new VideoBackendError(
          `plan provenance.bundleHash (${plan.provenance.bundleHash}) does not match the actual Slide Web Bundle hash (${bundleInfo.bundleHash}) for deck "${plan.deckId}". Re-run "lattice video plan" against this bundle.`,
          { backendId: REMOTION_BACKEND_ID, diagnostics: [], cause: "bundle-mismatch" },
        );
      }

      const planHash = hashVideoPlan(plan);
      let safeWorkDir;
      try {
        safeWorkDir = resolveGeneratedWorkDir({ workDir, backendId: REMOTION_BACKEND_ID, projectRoot });
      } catch (error) {
        throw asBackendError(error, REMOTION_BACKEND_ID);
      }

      await fs.mkdir(safeWorkDir, { recursive: true });

      const headerLines = [
        "DO NOT EDIT — generated by Lattice Remotion adapter",
        `plan-hash: ${planHash}`,
        `bundle-hash: ${bundleInfo.bundleHash}`,
        `deck: ${plan.deckId}`,
        `route: ${plan.routeId}`,
        `backend: ${REMOTION_BACKEND_ID}`,
        "---",
        "Remotion adapter foundation (M3). Still and video rendering require",
        "installed Remotion packages (@remotion/cli, @remotion/renderer).",
        "Run: lattice video doctor --backend remotion",
        "",
      ];

      await fs.writeFile(
        path.join(safeWorkDir, "LATTICE_REMOTION.md"),
        headerLines.join("\n"),
        "utf8",
      );

      const canonicalPlanBytes = serializeVideoPlan(plan);
      await fs.writeFile(
        path.join(safeWorkDir, "video-plan.json"),
        canonicalPlanBytes,
        "utf8",
      );

      const remotionProject = {
        schema: "lattice.remotion-project.v1",
        planHash,
        deckId: plan.deckId,
        routeId: plan.routeId,
        bundleDir: bundleInfo.bundlePath,
        bundleHash: bundleInfo.bundleHash,
        videoPlanPath: path.join(safeWorkDir, "video-plan.json"),
      };

      await fs.writeFile(
        path.join(safeWorkDir, "remotion-project.json"),
        JSON.stringify(remotionProject, null, 2),
        "utf8",
      );

      return new PreparedRender({
        backendId: REMOTION_BACKEND_ID,
        planHash,
        workDir: safeWorkDir,
        bundlePath: bundleInfo.bundlePath,
        bundleHash: bundleInfo.bundleHash,
      });
    },

    async renderStill() {
      throw new VideoBackendError(
        "Remotion still rendering not available at M3. " +
        "Install @remotion/cli @remotion/renderer react react-dom and check with: " +
        "lattice video doctor --backend remotion",
        { backendId: REMOTION_BACKEND_ID, diagnostics: [], cause: "unsupported-render-method" },
      );
    },

    async renderVideo() {
      throw new VideoBackendError(
        "Remotion video rendering not available at M3. " +
        "Install @remotion/cli @remotion/renderer react react-dom and check with: " +
        "lattice video doctor --backend remotion",
        { backendId: REMOTION_BACKEND_ID, diagnostics: [], cause: "unsupported-render-method" },
      );
    },

    async inspectArtifact() {
      throw new VideoBackendError(
        "Artifact inspection requires ffprobe. Check with: lattice video doctor --backend remotion",
        { backendId: REMOTION_BACKEND_ID, diagnostics: [], cause: "unsupported-render-method" },
      );
    },
  };
}
