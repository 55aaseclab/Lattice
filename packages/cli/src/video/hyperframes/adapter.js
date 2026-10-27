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
import { generateHyperFramesHost, resolveVendoredGsapSource } from "./host-template.js";
import { probeArtifactWithFfprobe, resolveFfprobeExecutable } from "../remotion/probe.js";
import {
  assertHostClipsBound,
  captureStillViaSnapshot,
  readHostManifest,
  renderVideoViaCli,
  resolveHyperFramesCliEntry,
  resolvePinnedBrowserEnv,
  writeHyperFramesFailureLog,
} from "./render-support.js";
import {
  checkCommand,
  getLocalPackageVersion,
  getLocalBinPath,
  isValidPackageVersion,
  formatMissingToolDiagnostic,
  formatInstallGuidance,
} from "../diagnostics.js";

export const HYPERFRAMES_BACKEND_ID = "hyperframes";

// The hyperframes package exposes no "." export main; its package.json is the
// only resolvable specifier, so package resolution goes through the manifest
// while diagnostics still key on the real package name.
const HYPERFRAMES_RESOLVE_SPECIFIER = "hyperframes/package.json";

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
    async getLocalPackageVersion(pkg, options) {
      const { getLocalPackageVersion: glpv } = await import("../diagnostics.js");
      return glpv(pkg, options);
    },
    async getLocalBinPath(pkg, binName, options) {
      const { getLocalBinPath: glbp } = await import("../diagnostics.js");
      return glbp(pkg, binName, options);
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

      const hyperframesInfo = await probeHost.getLocalPackageVersion("hyperframes", { resolveSpecifier: HYPERFRAMES_RESOLVE_SPECIFIER });
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
        const binInfo = await probeHost.getLocalBinPath("hyperframes", "hyperframes", { resolveSpecifier: HYPERFRAMES_RESOLVE_SPECIFIER });
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

      // The generated composition drives time through a vendored GSAP runtime
      // inlined at generation time; doctor reports the actually-installed
      // version so a render can always be tied to a concrete toolchain.
      const gsapInfo = await probeHost.getLocalPackageVersion("gsap");
      if (!gsapInfo.ok || !isValidPackageVersion(gsapInfo.version)) {
        diagnostics.push(new BackendDiagnostic({
          level: "error",
          message: `gsap not found or its version is missing/invalid. Install with: npm install gsap`,
          details: {
            package: "gsap",
            install: "npm install gsap",
            error: gsapInfo.ok ? `invalid version: ${JSON.stringify(gsapInfo.version ?? null)}` : gsapInfo.message,
          },
        }));
      } else {
        diagnostics.push(new BackendDiagnostic({
          level: "info",
          message: `gsap v${gsapInfo.version} at ${gsapInfo.pkgPath} (inlined into the generated composition)`,
          details: {
            package: "gsap",
            resolved: gsapInfo.resolved,
            pkgPath: gsapInfo.pkgPath,
            version: gsapInfo.version,
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
          message: `Browser: ${browserCheck.version} at ${browserCheck.executable} (pinned for render parity with the Remotion backend)`,
          details: { command: "browser", executable: browserCheck.executable, version: browserCheck.version },
        }));
      }

      return formatInstallGuidance(diagnostics, {
        node: ">=22 (required by HyperFrames)",
        requiredPackages: ["hyperframes", "gsap"],
        requiredTools: ["ffmpeg", "ffprobe", "chromium"],
        installHyperFrames: "npm install hyperframes@0.8.206 gsap@3.15.0",
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

      // Consume the bundle identity: a plan whose provenance names a different
      // bundle must never be prepared against this one.
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
        "HyperFrames adapter generated master composition (M5). composition/ is a",
        "generated HyperFrames project built from this VideoPlan and the Slide Web",
        "Bundle copied to composition/bundle. The composition renders the bundle's",
        "own slide markup at the plan's integer frames through a GSAP timeline that",
        "both the render pipeline and snapshot captures seek. Render with:",
        "lattice video still / lattice video render.",
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

      // Generated HyperFrames master composition: deterministic regeneration
      // from (plan, bundle) — safe to re-run before every render.
      const gsapSource = await resolveVendoredGsapSource();
      const host = await generateHyperFramesHost({
        workDir: safeWorkDir,
        plan,
        planHash,
        bundlePath: bundleInfo.bundlePath,
        bundleHash: bundleInfo.bundleHash,
        manifest: bundleInfo.manifest,
        gsapSource,
      });

      const hyperframesProject = {
        schema: "lattice.hyperframes-project.v1",
        planHash,
        deckId: plan.deckId,
        routeId: plan.routeId,
        bundleDir: bundleInfo.bundlePath,
        bundleHash: bundleInfo.bundleHash,
        videoPlanPath: path.join(safeWorkDir, "video-plan.json"),
        composition: {
          compositionId: host.hostManifest.compositionId,
          compositionDir: host.compositionDir,
          entryPoint: host.entryPoint,
          manifestPath: host.manifestPath,
        },
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

    async renderStill(input = {}) {
      const { prepared = null, frame, output } = input;

      if (!prepared || typeof prepared !== "object" || prepared.backendId !== HYPERFRAMES_BACKEND_ID ||
          typeof prepared.planHash !== "string" || typeof prepared.workDir !== "string") {
        throw new VideoBackendError(
          "renderStill requires a PreparedRender produced by this backend's prepare()",
          { backendId: HYPERFRAMES_BACKEND_ID, diagnostics: [], cause: "invalid-prepared" },
        );
      }
      if (!Number.isInteger(frame) || frame < 0) {
        await writeHyperFramesFailureLog({
          workDir: prepared.workDir,
          kind: "render-still-invalid-frame",
          planHash: prepared.planHash,
          context: { frame: String(frame) },
          error: new Error(`renderStill requires a non-negative integer frame, got ${String(frame)}`),
        });
        throw new VideoBackendError(
          `renderStill requires a non-negative integer frame, got ${String(frame)}`,
          { backendId: HYPERFRAMES_BACKEND_ID, diagnostics: [], cause: "invalid-frame" },
        );
      }
      if (typeof output !== "string" || output === "") {
        await writeHyperFramesFailureLog({
          workDir: prepared.workDir,
          kind: "render-still-invalid-output",
          planHash: prepared.planHash,
          context: { frame: String(frame) },
          error: new Error("renderStill requires a non-empty output path"),
        });
        throw new VideoBackendError(
          "renderStill requires a non-empty output path",
          { backendId: HYPERFRAMES_BACKEND_ID, diagnostics: [], cause: "invalid-output" },
        );
      }

      const { manifest } = await readHostManifest({ workDir: prepared.workDir, planHash: prepared.planHash });
      if (!Number.isInteger(manifest.totalFrames) || frame >= manifest.totalFrames) {
        await writeHyperFramesFailureLog({
          workDir: prepared.workDir,
          kind: "render-still-invalid-frame",
          planHash: prepared.planHash,
          context: { frame: String(frame), totalFrames: String(manifest.totalFrames) },
          error: new Error(`frame ${frame} is outside the plan range [0, ${manifest.totalFrames - 1}]`),
        });
        throw new VideoBackendError(
          `frame ${frame} is outside the plan range [0, ${manifest.totalFrames - 1}] (totalFrames ${manifest.totalFrames})`,
          { backendId: HYPERFRAMES_BACKEND_ID, diagnostics: [], cause: "invalid-frame" },
        );
      }
      assertHostClipsBound(manifest);

      const resolvedOutput = path.resolve(output);
      await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });

      let capturedPath;
      try {
        const env = await resolvePinnedBrowserEnv();
        capturedPath = await captureStillViaSnapshot({
          compositionDir: path.join(prepared.workDir, "composition"),
          stillsDir: path.join(prepared.workDir, "stills"),
          frame,
          fps: manifest.fps,
          env,
        });
        await fs.copyFile(capturedPath, resolvedOutput);
      } catch (error) {
        const failureLog = await writeHyperFramesFailureLog({
          workDir: prepared.workDir,
          kind: "render-still",
          planHash: prepared.planHash,
          context: { frame: String(frame), output: resolvedOutput },
          error,
          diagnostics: error instanceof VideoBackendError ? error.diagnostics : [],
        });
        throw new VideoBackendError(
          `HyperFrames still rendering failed for frame ${frame}: ${error?.message ?? String(error)}` +
            (failureLog ? ` (failure log: ${failureLog})` : ""),
          {
            backendId: HYPERFRAMES_BACKEND_ID,
            diagnostics: error instanceof VideoBackendError
              ? error.diagnostics
              : [new BackendDiagnostic({ level: "error", message: String(error?.stack ?? error) })],
            cause: error instanceof VideoBackendError && (
              error.cause === "invalid-frame" || error.cause === "missing-host" || error.cause === "host-mismatch" ||
              error.cause === "invalid-host" || error.cause === "unbound-slide-content" || error.cause === "missing-browser"
            ) ? error.cause : "render-failed",
          },
        );
      }

      const { ffprobePath } = await resolveFfprobeExecutable({ backendId: HYPERFRAMES_BACKEND_ID });
      const metadata = await probeArtifactWithFfprobe({ ffprobePath, artifactPath: resolvedOutput, backendId: HYPERFRAMES_BACKEND_ID });
      if (metadata.width !== manifest.width || metadata.height !== manifest.height) {
        throw new VideoBackendError(
          `rendered still has unexpected dimensions ${metadata.width}x${metadata.height}, expected ${manifest.width}x${manifest.height}: ${resolvedOutput}`,
          { backendId: HYPERFRAMES_BACKEND_ID, diagnostics: [], cause: "artifact-mismatch" },
        );
      }

      return new RenderArtifact({
        path: resolvedOutput,
        backendId: HYPERFRAMES_BACKEND_ID,
        planHash: prepared.planHash,
        frame,
        metadata,
      });
    },

    async renderVideo(input = {}) {
      const { prepared = null, output } = input;

      if (!prepared || typeof prepared !== "object" || prepared.backendId !== HYPERFRAMES_BACKEND_ID ||
          typeof prepared.planHash !== "string" || typeof prepared.workDir !== "string") {
        throw new VideoBackendError(
          "renderVideo requires a PreparedRender produced by this backend's prepare()",
          { backendId: HYPERFRAMES_BACKEND_ID, diagnostics: [], cause: "invalid-prepared" },
        );
      }
      if (typeof output !== "string" || output === "") {
        throw new VideoBackendError(
          "renderVideo requires a non-empty output path",
          { backendId: HYPERFRAMES_BACKEND_ID, diagnostics: [], cause: "invalid-output" },
        );
      }

      const { manifest } = await readHostManifest({ workDir: prepared.workDir, planHash: prepared.planHash });
      assertHostClipsBound(manifest);

      const resolvedOutput = path.resolve(output);
      await fs.mkdir(path.dirname(resolvedOutput), { recursive: true });

      try {
        const env = await resolvePinnedBrowserEnv();
        await renderVideoViaCli({
          compositionDir: path.join(prepared.workDir, "composition"),
          fps: manifest.fps,
          output: resolvedOutput,
          env,
        });
      } catch (error) {
        const failureLog = await writeHyperFramesFailureLog({
          workDir: prepared.workDir,
          kind: "render-video",
          planHash: prepared.planHash,
          context: { output: resolvedOutput },
          error,
          diagnostics: error instanceof VideoBackendError ? error.diagnostics : [],
        });
        throw new VideoBackendError(
          `HyperFrames video rendering failed: ${error?.message ?? String(error)}` +
            (failureLog ? ` (failure log: ${failureLog})` : ""),
          {
            backendId: HYPERFRAMES_BACKEND_ID,
            diagnostics: error instanceof VideoBackendError
              ? error.diagnostics
              : [new BackendDiagnostic({ level: "error", message: String(error?.stack ?? error) })],
            cause: error instanceof VideoBackendError && (
              error.cause === "missing-host" || error.cause === "host-mismatch" ||
              error.cause === "invalid-host" || error.cause === "unbound-slide-content" || error.cause === "missing-browser"
            ) ? error.cause : "render-failed",
          },
        );
      }

      const { ffprobePath } = await resolveFfprobeExecutable({ backendId: HYPERFRAMES_BACKEND_ID });
      const metadata = await probeArtifactWithFfprobe({ ffprobePath, artifactPath: resolvedOutput, backendId: HYPERFRAMES_BACKEND_ID });
      const mismatches = [];
      if (metadata.width !== manifest.width) mismatches.push(`width ${metadata.width} != ${manifest.width}`);
      if (metadata.height !== manifest.height) mismatches.push(`height ${metadata.height} != ${manifest.height}`);
      if (metadata.fps !== manifest.fps) mismatches.push(`fps ${metadata.fps} != ${manifest.fps}`);
      if (metadata.totalFrames !== manifest.totalFrames) mismatches.push(`totalFrames ${metadata.totalFrames} != ${manifest.totalFrames}`);
      if (mismatches.length > 0) {
        const failureLog = await writeHyperFramesFailureLog({
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
          { backendId: HYPERFRAMES_BACKEND_ID, diagnostics: [], cause: "artifact-mismatch" },
        );
      }

      return new RenderArtifact({
        path: resolvedOutput,
        backendId: HYPERFRAMES_BACKEND_ID,
        planHash: prepared.planHash,
        frame: null,
        metadata,
      });
    },

    async inspectArtifact(artifactPath) {
      if (typeof artifactPath !== "string" || artifactPath === "") {
        throw new VideoBackendError(
          "inspectArtifact requires a non-empty artifact path",
          { backendId: HYPERFRAMES_BACKEND_ID, diagnostics: [], cause: "invalid-artifact-path" },
        );
      }
      const { ffprobePath } = await resolveFfprobeExecutable({ backendId: HYPERFRAMES_BACKEND_ID });
      return probeArtifactWithFfprobe({ ffprobePath, artifactPath: path.resolve(artifactPath), backendId: HYPERFRAMES_BACKEND_ID });
    },
  };
}
