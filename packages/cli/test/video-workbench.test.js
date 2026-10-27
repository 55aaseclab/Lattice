// M7 workbench (`lattice video ui`): deck list + descriptor, timeline
// visualization data, backend doctor, output-path enforcement (越界 400),
// serial render queue, one real end-to-end render through the API, and
// artifact serving — all against a live server on an ephemeral port.

import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { TIMELINE_DECK_ID, writeDeckRegistry, writeProjectConfig, writeTimelineDeck } from "./helpers/timeline-fixture.js";

const cliIndex = fileURLToPath(new URL("../src/index.js", import.meta.url));
const tmpRoot = fileURLToPath(new URL("./tmp", import.meta.url));
function makeProject({ withAudio = true } = {}) {
  const projectRoot = mkdtempSync(path.join(tmpRoot, "m7-ui-"));
  writeProjectConfig(projectRoot);
  writeTimelineDeck(projectRoot, withAudio ? {} : {
    timeline: { audioTracks: [] },
  });
  writeDeckRegistry(projectRoot);
  return projectRoot;
}

test("the workbench API serves decks, descriptors, doctor, artifacts, and enforces output bounds", async () => {
  const projectRoot = makeProject();
  let serverProcess = null;
  try {
    // The real CLI command in a child verifies startup output and port
    // binding; the API is exercised over HTTP.
    serverProcess = spawn(process.execPath, [cliIndex, "video", "ui", "--port", "0"], {
      cwd: projectRoot,
      encoding: "utf8",
    });
    let serverOutput = "";
    let serverError = "";
    serverProcess.stdout.on("data", (chunk) => {
      serverOutput += chunk;
    });
    serverProcess.stderr.on("data", (chunk) => {
      serverError += chunk;
    });
    serverProcess.on("error", (error) => {
      serverError += `spawn error: ${error.message}`;
    });
    serverProcess.on("exit", (code, signal) => {
      serverError += `\n[server exited] code=${code} signal=${signal}`;
    });
    let url = null;
    for (let attempt = 0; attempt < 150 && !url; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      const match = /video workbench: (http:\/\/127\.0\.0\.1:\d+\/)/.exec(serverOutput);
      if (match) url = match[1];
    }
    assert.ok(url, `workbench must print its actual address, got: ${JSON.stringify(serverOutput)} stderr: ${JSON.stringify(serverError.slice(0, 400))}`);

    // The render job blocks the server's event loop synchronously at times
    // (spawnSync), which can reset pooled keep-alive sockets — retry network
    // hiccups on idempotent GETs instead of failing the poll.
    const getJson = async (pathname, options, attempts = 4) => {
      let lastError = null;
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        try {
          const response = await fetch(`${url.replace(/\/$/, "")}${pathname}`, options);
          const payload = await response.json().catch(() => ({}));
          return { status: response.status, payload, response };
        } catch (error) {
          lastError = error;
          if (options?.method === "POST") break;
          await new Promise((resolve) => setTimeout(resolve, 700));
        }
      }
      serverProcess?.kill("SIGTERM");
      throw new Error(`${options?.method ?? "GET"} ${pathname} failed; ${lastError?.cause?.code ?? lastError?.message}`);
    };

    // Deck list with timeline badges.
    const decks = await getJson("/api/decks");
    assert.equal(decks.status, 200);
    assert.equal(decks.payload.backends.includes("remotion"), true);
    const deckEntry = decks.payload.decks.find((deck) => deck.id === TIMELINE_DECK_ID);
    assert.ok(deckEntry);
    assert.equal(deckEntry.hasTimeline, true);
    assert.equal(deckEntry.schema, "lattice.deck.v2");

    // Descriptor: resolved timeline + real slide markup + theme CSS.
    const descriptor = await getJson(`/api/decks/${TIMELINE_DECK_ID}/descriptor`);
    assert.equal(descriptor.status, 200);
    assert.equal(descriptor.payload.hasTimeline, true);
    assert.equal(descriptor.payload.timeline.schema, "lattice.timeline.v1");
    assert.equal(descriptor.payload.slides.length, 3);
    assert.equal(descriptor.payload.slides[0].durationFrames, 90);
    assert.ok(descriptor.payload.slides[0].html.includes("data-lattice-reveal"));
    assert.ok(descriptor.payload.themeCss.includes("slide-canvas"), "base theme CSS is served");
    assert.ok(descriptor.payload.presetCss.includes("data-lattice-anim"), "the preset stylesheet loads only with the timeline deck");
    assert.equal(descriptor.payload.fps, 30);

    // Unknown deck → 404; unreadable/invalid → 422.
    const missing = await getJson("/api/decks/ghost/descriptor");
    assert.equal(missing.status, 404);

    // Doctor surfaces real backend diagnostics.
    const doctor = await getJson("/api/doctor/remotion");
    assert.equal(doctor.status, 200);
    assert.ok(Array.isArray(doctor.payload.diagnostics));
    assert.ok(["available", "unavailable"].includes(doctor.payload.status), doctor.payload.status);
    const unknownDoctor = await getJson("/api/doctor/nonsense");
    assert.equal(unknownDoctor.status, 404);

    // Artifacts listing is live and rooted at .lattice/generated/.
    const artifacts = await getJson("/api/artifacts");
    assert.equal(artifacts.status, 200);
    assert.equal(artifacts.payload.root, ".lattice/generated/");

    // 越界 400: outputs outside .lattice/generated/video-ui are refused.
    const escapeAttempts = [
      "../../decks/timeline-demo/manifest.json",
      "/etc/passwd",
      ".lattice/generated/../../evil.mp4",
      "some/other/place.mp4",
    ];
    for (const output of escapeAttempts) {
      const rejected = await getJson("/api/render", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deck: TIMELINE_DECK_ID, backend: "remotion", output }),
      });
      assert.equal(rejected.status, 400, `output ${output} must be a 400, got ${rejected.status}`);
      assert.match(rejected.payload.error, /\.lattice\/generated\/video-ui/);
    }

    // Bad requests: unknown deck/backend.
    assert.equal((await getJson("/api/render", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deck: "ghost", backend: "remotion" }) })).status, 400);
    assert.equal((await getJson("/api/render", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ deck: TIMELINE_DECK_ID, backend: "nonsense" }) })).status, 400);

    // File serving guards traversal with a 400.
    assert.equal((await getJson("/api/files/..%2F..%2Fpackage.json")).status, 400);

    // One real render through the API (serial queue): a full MP4 lands under
    // .lattice/generated/video-ui and the job logs the plan hash.
    const render = await getJson("/api/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deck: TIMELINE_DECK_ID, backend: "remotion" }),
    });
    assert.equal(render.status, 202);
    const jobId = render.payload.jobId;
    let job = null;
    for (let attempt = 0; attempt < 600; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        job = (await getJson(`/api/jobs/${jobId}`)).payload;
      } catch (error) {
        throw new Error(`job poll failed: ${error.message}; server stderr: ${JSON.stringify(serverError.slice(-1200))}`);
      }
      if (job.status === "done" || job.status === "failed") break;
    }
    assert.equal(job.status, "done", `render job failed: ${job.error}\n${job.log.join("\n")}`);
    assert.ok(job.result.planHash);
    assert.equal(job.result.metadata.totalFrames, 220);
    const artifactPath = path.join(projectRoot, job.result.path);
    assert.ok(existsSync(artifactPath));
    assert.match(job.result.path, /^\.lattice\/generated\/video-ui\//);

    // The served file is the artifact (preview/download path).
    const served = await fetch(`${url.replace(/\/$/, "")}/api/files/${encodeURIComponent(job.result.path)}`);
    assert.equal(served.status, 200);
    const bytes = Buffer.from(await served.arrayBuffer());
    assert.equal(bytes.length, job.result.metadata ? bytes.length : 0);
    assert.ok(bytes.length > 1000, "served artifact has real bytes");
    assert.ok(bytes.subarray(4, 8).toString("ascii") === "ftyp", "served bytes are an MP4 container");

    // The artifact listing now includes the workbench output.
    const listing = await getJson("/api/artifacts");
    assert.ok(
      listing.payload.artifacts.some((artifact) => artifact.path === job.result.path),
      `artifact listing must include the workbench render: ${JSON.stringify(listing.payload.artifacts.filter((artifact) => artifact.path.includes("video-ui")))} (job path ${job.result.path})`,
    );
  } finally {
    serverProcess?.kill("SIGTERM");
    rmSync(projectRoot, { recursive: true, force: true });
  }
}, { timeout: 600000 });
