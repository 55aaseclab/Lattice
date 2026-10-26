import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// A14 — Presentation must start and complete page/step navigation with no
// Remotion/HyperFrames installation or initialization. Proven three ways:
//   1. static source scan (no backend reference anywhere in the surface),
//   2. dependency manifest scan (no backend package is even declared),
//   3. dynamic execution under a module loader that hard-fails on any
//      backend specifier — the machine AND the browser surface module must
//      import and run a full navigation sequence without them.

const runtimeRoot = fileURLToPath(new URL("../", import.meta.url));
const presentationSource = join(runtimeRoot, "src", "presentation", "index.js");
const surfaceSource = join(runtimeRoot, "src", "renderer", "presentation-app.js");

const BACKEND_PATTERN = /remotion|hyperframes/i;

test("presentation sources contain no backend references", () => {
  for (const file of [presentationSource, surfaceSource, join(runtimeRoot, "src", "renderer", "presentation.css")]) {
    const source = readFileSync(file, "utf8");
    const lines = source.split("\n");
    lines.forEach((line, index) => {
      assert.ok(!BACKEND_PATTERN.test(line), `${file}:${index + 1} mentions a video backend: ${line.trim()}`);
    });
  }
});

test("runtime package manifest declares no backend dependency", () => {
  const manifest = JSON.parse(readFileSync(join(runtimeRoot, "package.json"), "utf8"));
  for (const section of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const entries = Object.keys(manifest[section] ?? {});
    for (const name of entries) {
      assert.ok(!BACKEND_PATTERN.test(name), `${section} must not declare backend package "${name}"`);
    }
  }
});

test("presentation imports and runs under a backend-blocking module loader", () => {
  const workDir = mkdtempSync(join(tmpdir(), "lattice-presentation-isolation-"));
  try {
    const loaderPath = join(workDir, "backend-guard-loader.mjs");
    writeFileSync(
      loaderPath,
      `
const FORBIDDEN = /(^|\\/)(@)?(remotion|hyperframes)(\\/|$)/i;
export function resolve(specifier, context, nextResolve) {
  if (FORBIDDEN.test(specifier)) {
    throw new Error("FORBIDDEN BACKEND IMPORT: " + specifier);
  }
  return nextResolve(specifier, context);
}
export function load(url, context, nextLoad) {
  if (FORBIDDEN.test(url)) {
    throw new Error("FORBIDDEN BACKEND MODULE: " + url);
  }
  return nextLoad(url, context);
}
`,
      "utf8",
    );

    const runnerPath = join(workDir, "isolation-runner.mjs");
    const presentationUrl = pathToFileURL(presentationSource).href;
    const surfaceUrl = pathToFileURL(surfaceSource).href;
    writeFileSync(
      runnerPath,
      `
import assert from "node:assert/strict";
import {
  createPresentationModel,
  initialPresentationState,
  presentationNext,
  presentationPrevious,
  presentationFirst,
  presentationLast,
  presentationEnterBranch,
  presentationExitBranch,
  playSegmentFrames,
  parsePresentationAddress,
} from ${JSON.stringify(presentationUrl)};
await import(${JSON.stringify(surfaceUrl)});

const deck = {
  id: "isolation",
  fps: 30,
  routes: { main: ["a", "b"], detail: ["b"] },
  slides: [
    { id: "a", durationFrames: 10, stops: [{ id: "open", frame: 0 }, { id: "reveal", frame: 5, navigation: "play" }] },
    { id: "b", durationFrames: 10, stops: [{ id: "one", frame: 0 }, { id: "two", frame: 9 }] },
  ],
};
const model = createPresentationModel(deck);
let state = initialPresentationState(model);
state = presentationNext(model, state).state;
assert.equal(state.stopId, "reveal");
const play = presentationNext(model, state);
assert.equal(play.intent.kind, "seek"); // cross-slide
state = play.state;
assert.equal(state.slideId, "b");
const segment = { kind: "play", fromFrame: 0, toFrame: 9 };
assert.equal(playSegmentFrames(segment).at(-1), 9);
state = presentationLast(model, state).state;
assert.equal(state.stopId, "two");
state = presentationPrevious(model, state).state;
assert.equal(state.stopId, "one");
const entered = presentationEnterBranch(model, state, "detail");
assert.equal(entered.state.routeId, "detail");
const returned = presentationExitBranch(model, entered.state);
assert.equal(returned.intent.stopId, "one");
const parsed = parsePresentationAddress(model, new URLSearchParams("slide=b&stop=two"));
assert.equal(parsed.ok, true);
assert.equal(parsed.address.stopId, "two");
console.log("ISOLATION_OK");
`,
      "utf8",
    );

    const result = spawnSync(process.execPath, ["--experimental-loader", loaderPath, runnerPath], {
      encoding: "utf8",
      timeout: 30000,
      cwd: runtimeRoot,
    });
    assert.equal(
      result.status,
      0,
      `presentation must import and run without backend packages.\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
    assert.ok(result.stdout.includes("ISOLATION_OK"), `expected success marker, got: ${result.stdout}`);
    assert.ok(!/FORBIDDEN BACKEND/.test(result.stderr), `loader guard tripped: ${result.stderr}`);
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
});
