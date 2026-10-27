import { promises as fs } from "node:fs";
import path from "node:path";
import { validateVideoPlan, hashVideoPlan, serializeVideoPlan } from "@55aaseclab/lattice-runtime/video-plan";
import {
  BackendDiagnostic,
  PreparedRender,
  RenderArtifact,
  VideoBackendError,
} from "../backend-contract.js";
import { resolveGeneratedWorkDir } from "../generated-path.js";
import { validateSlideWebBundle } from "../bundle.js";
import { generateRemotionHost } from "./host-template.js";
import { probeArtifactWithFfprobe, resolveFfprobeExecutable } from "./probe.js";
import { mixPlanAudioIntoVideo, readPlanFromWorkDir } from "../audio-mix.js";
import {
  assertHostClipsBound,
  ensureHostBundle,
  readHostManifest,
  resolveRenderBrowserExecutable,
  selectHostComposition,
  writeRemotionFailureLog,
} from "./render-support.js";
import {
  checkCommand,
  getLocalPackageVersion,
  getLocalBinPath,
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

      // The M4 render path executes through the core `remotion` package and
      // the official bundler; doctor reports their actually-installed
      // versions so a render can always be tied to a concrete toolchain.
      for (const packageName of ["remotion", "@remotion/bundler"]) {
        const packageInfo = await probeHost.getLocalPackageVersion(packageName);
        if (!packageInfo.ok || !isValidPackageVersion(packageInfo.version)) {
          diagnostics.push(new BackendDiagnostic({
            level: "error",
            message: `${packageName} not found or its version is missing/invalid. Install with: npm install ${packageName}`,
            details: {
              package: packageName,
              install: `npm install ${packageName}`,
              error: packageInfo.ok ? `invalid version: ${JSON.stringify(packageInfo.version ?? null)}` : packageInfo.message,
            },
          }));
        } else {
          diagnostics.push(new BackendDiagnostic({
            level: "info",
            message: `${packageName} v${packageInfo.version} at ${packageInfo.pkgPath}`,
            details: {
              package: packageName,
              resolved: packageInfo.resolved,
              pkgPath: packageInfo.pkgPath,
              version: packageInfo.version,
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
        requiredPackages: ["@remotion/cli", "@remotion/renderer", "remotion", "@remotion/bundler"],
        requiredTools: ["ffmpeg", "ffprobe", "chromium"],
        installRemotion: "npm install @remotion/cli @remotion/renderer @remotion/bundler remotion react react-dom",
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
        "Remotion adapter generated host (M4). host/ is a generated Remotion",
        "project built from this VideoPlan and the Slide Web Bundle copied to",
        "host/public/bundle. The composition renders the bundle's own slide",
        "markup at the plan's integer frames and waits for per-frame paint",
        "acknowledgment. Render with: lattice video still / lattice video render.",
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

      // Generated Remotion host: deterministic regeneration from (plan,
      // bundle) — safe to re-run before every render.
      const host = await generateRemotionHost({
        workDir: safeWorkDir,
        plan,
        planHash,
        bundlePath: bundleInfo.bundlePath,
        bundleHash: bundleInfo.bundleHash,
        manifest: bundleInfo.manifest,
      });

      const remotionProject = {
        schema: "lattice.remotion-project.v1",
        planHash,
        deckId: plan.deckId,
        routeId: plan.routeId,
        bundleDir: bundleInfo.bundlePath,
        bundleHash: bundleInfo.bundleHash,
        videoPlanPath: path.join(safeWorkDir, "video-plan.json"),
        host: {
          compositionId: host.hostManifest.compositionId,
          hostDir: host.hostDir,
          entryPoint: host.entryPoint,
          publicDir: host.publicDir,
          manifestPath: host.manifestPath,
          configPath: host.configPath,
        },
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

    async renderStill(input = {}) {
      const { prepared = null, frame, output } = input;

      if (!prepared || typeof prepared !== "object" || prepared.backendId !== REMOTION_BACKEND_ID ||
          typeof prepared.planHash !== "string" || typeof prepared.workDir !== "string") {
        throw new VideoBackendError(
          "renderStill requires a PreparedRender produced by this backend's prepare()",
          { backendId: REMOTION_BACKEND_ID, diagnostics: [], cause: "invalid-prepared" },
        );
      }
      if (!Number.isInteger(frame) || frame < 0) {
        await writeRemotionFailureLog({
          workDir: prepared.workDir,
          kind: "render-still-invalid-frame",
          planHash: prepared.planHash,
          context: { frame: String(frame) },
          error: new Error(`renderStill requires a non-negative integer frame, got ${String(frame)}`),
        });
        throw new VideoBackendError(
          `renderStill requires a non-negative integer frame, got ${String(frame)}`,
          { backendId: REMOTION_BACKEND_ID, diagnostics: [], cause: "invalid-frame" },
        );
      }
      if (typeof output !== "string" || output === "") {
        await writeRemotionFailureLog({
          workDir: prepared.workDir,
          kind: "render-still-invalid-output",
          planHash: prepared.planHash,
          context: { frame: String(frame) },
          error: new Error("renderStill requires a non-empty output path"),
        });
        throw new VideoBackendError(
          "renderStill requires a non-empty output path",
          { backendId: REMOTION_BACKEND_ID, diagnostics: [], cause: "invalid-output" },
        );
      }

      const { manifest } = await readHostManifest({ workDir: prepared.workDir, planHash: prepared.planHash });
      if (!Number.isInteger(manifest.totalFrames) || frame >= manifest.totalFrames) {
        await writeRemotionFailureLog({
          workDir: prepared.workDir,
          kind: "render-still-invalid-frame",
          planHash: prepared.planHash,
          context: { frame: String(frame), totalFrames: String(manifest.totalFrames) },
          error: new Error(`frame ${frame} is outside the plan range [0, ${manifest.totalFrames - 1}]`),
        });
        throw new VideoBackendError(
          `frame ${frame} is outside the plan range [0, ${manifest.totalFrames - 1}] (totalFrames ${manifest.totalFrames})`,
          { backendId: REMOTION_BACKEND_ID, diagnostics: [], cause: "invalid-frame" },
        );
      }
      assertHostClipsBound(manifest);

      const resolvedOutput = path.resolve(output);
      await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });

      try {
        const serveUrl = await ensureHostBundle({ workDir: prepared.workDir, planHash: prepared.planHash });
        const browserExecutable = await resolveRenderBrowserExecutable();
        const composition = await selectHostComposition({ serveUrl, compositionId: manifest.compositionId, browserExecutable });
        const { renderStill: remotionRenderStill } = await import("@remotion/renderer");
        await remotionRenderStill({
          composition,
          serveUrl,
          frame,
          output: resolvedOutput,
          imageFormat: "png",
          overwrite: true,
          inputProps: {},
          browserExecutable,
        });
      } catch (error) {
        const failureLog = await writeRemotionFailureLog({
          workDir: prepared.workDir,
          kind: "render-still",
          planHash: prepared.planHash,
          context: { frame: String(frame), output: resolvedOutput },
          error,
          diagnostics: error instanceof VideoBackendError ? error.diagnostics : [],
        });
        throw new VideoBackendError(
          `Remotion still rendering failed for frame ${frame}: ${error?.message ?? String(error)}` +
            (failureLog ? ` (failure log: ${failureLog})` : ""),
          {
            backendId: REMOTION_BACKEND_ID,
            diagnostics: error instanceof VideoBackendError
              ? error.diagnostics
              : [new BackendDiagnostic({ level: "error", message: String(error?.stack ?? error) })],
            cause: error instanceof VideoBackendError && error.cause === "invalid-frame" ? "invalid-frame" : "render-failed",
          },
        );
      }

      const { ffprobePath } = await resolveFfprobeExecutable();
      const metadata = await probeArtifactWithFfprobe({ ffprobePath, artifactPath: resolvedOutput });
      if (metadata.width !== manifest.width || metadata.height !== manifest.height) {
        throw new VideoBackendError(
          `rendered still has unexpected dimensions ${metadata.width}x${metadata.height}, expected ${manifest.width}x${manifest.height}: ${resolvedOutput}`,
          { backendId: REMOTION_BACKEND_ID, diagnostics: [], cause: "artifact-mismatch" },
        );
      }

      return new RenderArtifact({
        path: resolvedOutput,
        backendId: REMOTION_BACKEND_ID,
        planHash: prepared.planHash,
        frame,
        metadata,
      });
    },

    async renderVideo(input = {}) {
      const { prepared = null, output } = input;

      if (!prepared || typeof prepared !== "object" || prepared.backendId !== REMOTION_BACKEND_ID ||
          typeof prepared.planHash !== "string" || typeof prepared.workDir !== "string") {
        throw new VideoBackendError(
          "renderVideo requires a PreparedRender produced by this backend's prepare()",
          { backendId: REMOTION_BACKEND_ID, diagnostics: [], cause: "invalid-prepared" },
        );
      }
      if (typeof output !== "string" || output === "") {
        throw new VideoBackendError(
          "renderVideo requires a non-empty output path",
          { backendId: REMOTION_BACKEND_ID, diagnostics: [], cause: "invalid-output" },
        );
      }

      const { manifest } = await readHostManifest({ workDir: prepared.workDir, planHash: prepared.planHash });
      assertHostClipsBound(manifest);

      const resolvedOutput = path.resolve(output);
      await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });

      try {
        const serveUrl = await ensureHostBundle({ workDir: prepared.workDir, planHash: prepared.planHash });
        const browserExecutable = await resolveRenderBrowserExecutable();
        const composition = await selectHostComposition({ serveUrl, compositionId: manifest.compositionId, browserExecutable });
        const { renderMedia } = await import("@remotion/renderer");
        const renderResult = await renderMedia({
          composition,
          serveUrl,
          codec: "h264",
          outputLocation: resolvedOutput,
          overwrite: true,
          inputProps: {},
          browserExecutable,
        });
        if (renderResult?.outputLocation && path.resolve(renderResult.outputLocation) !== resolvedOutput) {
          // renderMedia reports where the artifact actually landed; anything
          // other than the requested path would break the isolation contract.
          throw new Error(
            `renderMedia wrote to ${renderResult.outputLocation} instead of the requested ${resolvedOutput}`,
          );
        }
      } catch (error) {
        const failureLog = await writeRemotionFailureLog({
          workDir: prepared.workDir,
          kind: "render-video",
          planHash: prepared.planHash,
          context: { output: resolvedOutput },
          error,
          diagnostics: error instanceof VideoBackendError ? error.diagnostics : [],
        });
        throw new VideoBackendError(
          `Remotion video rendering failed: ${error?.message ?? String(error)}` +
            (failureLog ? ` (failure log: ${failureLog})` : ""),
          {
            backendId: REMOTION_BACKEND_ID,
            diagnostics: error instanceof VideoBackendError
              ? error.diagnostics
              : [new BackendDiagnostic({ level: "error", message: String(error?.stack ?? error) })],
            cause: "render-failed",
          },
        );
      }

      // M7 audioTracks: plans that declare audio get them mixed into one
      // AAC track after the base render (same ffmpeg graph for both
      // backends); silent plans skip the post-process entirely.
      const plan = await readPlanFromWorkDir({ workDir: prepared.workDir, backendId: REMOTION_BACKEND_ID });
      if ((plan?.audioTracks ?? []).length > 0) {
        try {
          await mixPlanAudioIntoVideo({ plan, bundleDir: prepared.bundlePath, videoPath: resolvedOutput, backendId: REMOTION_BACKEND_ID });
        } catch (error) {
          const failureLog = await writeRemotionFailureLog({
            workDir: prepared.workDir,
            kind: "audio-mix",
            planHash: prepared.planHash,
            context: { output: resolvedOutput },
            error,
            diagnostics: [],
          });
          throw new VideoBackendError(
            `Remotion audio mix failed: ${error?.message ?? String(error)}` + (failureLog ? ` (failure log: ${failureLog})` : ""),
            { backendId: REMOTION_BACKEND_ID, diagnostics: [], cause: "audio-mix-failed" },
          );
        }
      }

      const { ffprobePath } = await resolveFfprobeExecutable();
      const metadata = await probeArtifactWithFfprobe({ ffprobePath, artifactPath: resolvedOutput });
      const mismatches = [];
      if (metadata.width !== manifest.width) mismatches.push(`width ${metadata.width} != ${manifest.width}`);
      if (metadata.height !== manifest.height) mismatches.push(`height ${metadata.height} != ${manifest.height}`);
      if (metadata.fps !== manifest.fps) mismatches.push(`fps ${metadata.fps} != ${manifest.fps}`);
      if (metadata.totalFrames !== manifest.totalFrames) mismatches.push(`totalFrames ${metadata.totalFrames} != ${manifest.totalFrames}`);
      if (mismatches.length > 0) {
        const failureLog = await writeRemotionFailureLog({
          workDir: prepared.workDir,
          kind: "render-video-probe",
          planHash: prepared.planHash,
          context: { output: resolvedOutput, mismatches: mismatches.join("; ") },
          error: new Error(`rendered MP4 failed ffprobe verification: ${mismatches.join("; ")}`),
          diagnostics: [],
        });
        throw new VideoBackendError(
          `rendered MP4 failed ffprobe verification: ${mismatches.join("; ")}` +
            (failureLog ? ` (failure log: ${failureLog})` : ""),
          { backendId: REMOTION_BACKEND_ID, diagnostics: [], cause: "artifact-mismatch" },
        );
      }

      return new RenderArtifact({
        path: resolvedOutput,
        backendId: REMOTION_BACKEND_ID,
        planHash: prepared.planHash,
        frame: null,
        metadata,
      });
    },

    async inspectArtifact(artifactPath) {
      if (typeof artifactPath !== "string" || artifactPath === "") {
        throw new VideoBackendError(
          "inspectArtifact requires a non-empty artifact path",
          { backendId: REMOTION_BACKEND_ID, diagnostics: [], cause: "invalid-artifact-path" },
        );
      }
      const { ffprobePath } = await resolveFfprobeExecutable();
      return probeArtifactWithFfprobe({ ffprobePath, artifactPath: path.resolve(artifactPath) });
    },
  };
}
