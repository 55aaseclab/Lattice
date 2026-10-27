// Lattice Video Workbench (M7): deck list, unified timeline visualization,
// backend doctor, serialized MP4 rendering, artifact preview/download, and an
// in-page preview that plays the deck timeline through the real Slide
// Runtime (see player.js — same surface present-play drives).

const state = {
  decks: [],
  backends: [],
  selectedDeck: null,
  descriptor: null,
  player: null,
  selectedJobId: null,
  artifactRoot: ".lattice/generated/",
};

const elements = {};

function byId(id) {
  return document.getElementById(id);
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}

async function fetchJson(url, options) {
  const response = await fetch(url, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok && !response.status.toString().startsWith("2")) {
    throw new Error(payload.error ?? `${url} failed (${response.status})`);
  }
  return payload;
}

async function boot() {
  for (const id of ["wb-meta", "wb-deck-list", "wb-doctor", "wb-deck-empty", "wb-deck-view", "wb-deck-name", "wb-deck-timeline-badge", "wb-timeline-summary", "wb-timeline", "wb-preview-stage", "wb-play", "wb-scrubber", "wb-frame-label", "wb-stop-select", "wb-preview-error", "wb-backend-select", "wb-render", "wb-render-status", "wb-render-log", "wb-refresh-artifacts", "wb-artifacts", "wb-artifact-preview"]) {
    elements[id] = byId(id);
  }

  const health = await fetchJson("/api/decks");
  state.decks = health.decks;
  state.backends = health.backends;
  elements["wb-meta"].textContent = `${health.decks.length} deck(s) · backends: ${health.backends.join(", ")}`;

  renderDeckList();
  renderBackendSelect();
  await renderDoctors();
  await refreshArtifacts();

  elements["wb-deck-list"].addEventListener("click", (event) => {
    const button = event.target.closest("button[data-deck]");
    if (button) void selectDeck(button.dataset.deck);
  });
  elements["wb-play"].addEventListener("click", () => togglePlay());
  elements["wb-scrubber"].addEventListener("input", (event) => {
    const frame = Number(event.target.value);
    if (state.player && Number.isInteger(frame)) void state.player.seek(frame).then(updateScrubber);
  });
  elements["wb-stop-select"].addEventListener("change", (event) => {
    const index = Number(event.target.value);
    if (state.player && Number.isInteger(index)) void state.player.seekStop(index).then(updateScrubber);
  });
  elements["wb-render"].addEventListener("click", () => void startRender());
  elements["wb-refresh-artifacts"].addEventListener("click", () => void refreshArtifacts());

  setInterval(() => {
    if (state.selectedJobId) void pollJob(state.selectedJobId);
  }, 1200);
}

function renderDeckList() {
  const items = state.decks.map((deck) => `
    <li>
      <button type="button" data-deck="${esc(deck.id)}" aria-current="${deck.id === state.selectedDeck}">
        ${esc(deck.title)}
        <span class="wb-deck-meta">${esc(deck.id)} · ${esc(deck.schema ?? "?")}${deck.hasTimeline ? " · timeline" : ""}</span>
      </button>
    </li>`).join("");
  elements["wb-deck-list"].innerHTML = items || '<li class="wb-empty">No decks found.</li>';
}

function renderBackendSelect() {
  elements["wb-backend-select"].innerHTML = state.backends
    .map((backend) => `<option value="${esc(backend)}">${esc(backend)}</option>`)
    .join("");
}

async function renderDoctors() {
  const container = elements["wb-doctor"];
  container.innerHTML = state.backends
    .map((backend) => `
      <div class="wb-doctor-backend" data-backend="${esc(backend)}">
        <button type="button" data-run-doctor="${esc(backend)}" class="wb-small">Run doctor: ${esc(backend)}</button>
        <div class="wb-doctor-result" data-result></div>
      </div>`)
    .join("");
  container.addEventListener("click", (event) => {
    const button = event.target.closest("button[data-run-doctor]");
    if (!button) return;
    const backend = button.dataset.runDoctor;
    const resultBox = container.querySelector(`[data-backend="${backend}"] [data-result]`);
    resultBox.textContent = "running…";
    fetchJson(`/api/doctor/${encodeURIComponent(backend)}`)
      .then((report) => {
        const level = report.status === "ok" ? "ok" : "error";
        const issues = report.diagnostics.filter((diag) => diag.level === "error").length;
        resultBox.innerHTML = `
          <p class="wb-doctor-status" data-level="${level}">${esc(report.backend)}: ${esc(report.status)} (${issues} issue(s))</p>
          <pre>${esc(report.diagnostics.map((diag) => `${diag.level === "error" ? "✗" : diag.level === "warn" ? "⚠" : "✓"} ${diag.message}`).join("\n"))}</pre>`;
      })
      .catch((error) => {
        resultBox.innerHTML = `<p class="wb-doctor-status" data-level="error">${esc(error.message)}</p>`;
      });
  });
}

async function selectDeck(deckId) {
  state.selectedDeck = deckId;
  renderDeckList();
  elements["wb-deck-empty"].hidden = true;
  elements["wb-deck-view"].hidden = false;
  elements["wb-deck-name"].textContent = deckId;
  let descriptor;
  try {
    descriptor = await fetchJson(`/api/decks/${encodeURIComponent(deckId)}/descriptor`);
  } catch (error) {
    elements["wb-preview-error"].hidden = false;
    elements["wb-preview-error"].textContent = error.message;
    return;
  }
  elements["wb-preview-error"].hidden = true;
  state.descriptor = descriptor;
  state.player?.destroy();
  state.player = null;
  elements["wb-deck-timeline-badge"].hidden = !descriptor.hasTimeline;
  renderTimeline(descriptor);
  await mountPreview(descriptor);
}

function renderTimeline(descriptor) {
  const container = elements["wb-timeline"];
  const fps = descriptor.fps ?? 30;
  const segments = state.player?.segments ?? buildSegments(descriptor);
  const totalFrames = segments.reduce((sum, segment) => sum + segment.durationFrames, 0);
  const seconds = (totalFrames / fps).toFixed(2);
  elements["wb-timeline-summary"].textContent = `${segments.length} segment(s) · ${totalFrames} frames · ${seconds}s @ ${fps} fps`;
  container.innerHTML = "";

  // One axis per row: segments + stops, and one row per audio track.
  const axis = document.createElement("div");
  axis.className = "wb-axis";
  axis.innerHTML = `<div class="wb-axis-label">segments × stops (frames)</div>`;
  const track = document.createElement("div");
  track.className = "wb-axis-track";
  let cursor = 0;
  for (const segment of segments) {
    const width = (segment.durationFrames / totalFrames) * 100;
    const segmentElement = document.createElement("div");
    segmentElement.className = "wb-segment";
    segmentElement.style.left = `${(cursor / totalFrames) * 100}%`;
    segmentElement.style.width = `${width}%`;
    segmentElement.innerHTML = `<span class="wb-segment-name">${esc(segment.slideId)} · ${segment.durationFrames}f</span>`;
    for (const stop of segment.stops) {
      const tick = document.createElement("div");
      tick.className = "wb-stop-tick";
      tick.style.left = `${((cursor + stop.frame) / totalFrames) * 100}%`;
      tick.innerHTML = `<span class="wb-stop-name">${esc(stop.id)}@${stop.frame}</span>`;
      segmentElement.appendChild(tick);
    }
    track.appendChild(segmentElement);
    cursor += segment.durationFrames;
  }
  axis.appendChild(track);
  container.appendChild(axis);

  for (const trackDescriptor of descriptor.audioTracks ?? []) {
    const audioAxis = document.createElement("div");
    audioAxis.className = "wb-axis";
    audioAxis.innerHTML = `<div class="wb-axis-label">audio · ${esc(trackDescriptor.id)} (start ${trackDescriptor.startFrame}f, volume ${esc(trackDescriptor.volume ?? 1)})</div>`;
    const audioTrack = document.createElement("div");
    audioTrack.className = "wb-axis-track";
    const bar = document.createElement("div");
    bar.className = "wb-audio-bar";
    bar.style.left = `${(trackDescriptor.startFrame / totalFrames) * 100}%`;
    const duration = trackDescriptor.durationFrames ?? Math.max(1, totalFrames - trackDescriptor.startFrame);
    bar.style.width = `${(Math.min(duration, totalFrames - trackDescriptor.startFrame) / totalFrames) * 100}%`;
    bar.innerHTML = `<span class="wb-audio-name">${esc(trackDescriptor.src)}</span>`;
    audioTrack.appendChild(bar);
    audioAxis.appendChild(audioTrack);
    container.appendChild(audioAxis);
  }
}

function buildSegments(descriptor) {
  const route = descriptor.routes?.main ?? descriptor.slides.map((slide) => slide.id);
  const byId = new Map(descriptor.slides.map((slide) => [slide.id, slide]));
  const segments = [];
  for (const slideId of route) {
    const slide = byId.get(slideId);
    if (slide) segments.push({ slideId, durationFrames: slide.durationFrames, stops: slide.stops });
  }
  return segments;
}

async function mountPreview(descriptor) {
  const { createTimelinePlayer } = await import("./player.js");
  const stage = elements["wb-preview-stage"];
  stage.innerHTML = "";
  const canvasHost = document.createElement("div");
  canvasHost.style.width = `${descriptor.canvas?.width ?? 960}px`;
  canvasHost.style.maxWidth = "100%";
  stage.appendChild(canvasHost);
  const styleElement = document.createElement("style");
  styleElement.textContent = `${descriptor.themeCss}${descriptor.presetCss ? `\n${descriptor.presetCss}` : ""}`;
  document.head.appendChild(styleElement);

  state.player = createTimelinePlayer({ stage: canvasHost, descriptor });
  const totalFrames = state.player.totalFrames;
  elements["wb-scrubber"].max = String(totalFrames - 1);
  elements["wb-scrubber"].value = "0";
  elements["wb-stop-select"].innerHTML = state.player.stopTicks
    .map((tick, index) => `<option value="${index}">stop ${index + 1} @ ${tick}</option>`)
    .join("");
  elements["wb-frame-label"].textContent = `frame 0 / ${totalFrames - 1}`;
  await state.player.seek(0);
  updateScrubber();
}

function updateScrubber() {
  if (!state.player) return;
  const frame = state.player.frame;
  elements["wb-scrubber"].value = String(frame);
  elements["wb-frame-label"].textContent = `frame ${frame} / ${state.player.totalFrames - 1}${state.player.playing ? " (playing)" : ""}`;
}

async function togglePlay() {
  if (!state.player) return;
  if (state.player.playing) {
    state.player.pause();
    elements["wb-play"].textContent = "Play";
    updateScrubber();
    return;
  }
  elements["wb-play"].textContent = "Pause";
  if (state.player.frame >= state.player.totalFrames - 1) {
    await state.player.seek(0);
  }
  await state.player.play({ onFrame: updateScrubber });
  elements["wb-play"].textContent = "Play";
  updateScrubber();
}

async function startRender() {
  const deck = state.selectedDeck;
  const backend = elements["wb-backend-select"].value;
  if (!deck || !backend) return;
  elements["wb-render-status"].textContent = "queued…";
  elements["wb-render-log"].hidden = false;
  elements["wb-render-log"].textContent = "";
  try {
    const response = await fetchJson("/api/render", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deck, backend }),
    });
    state.selectedJobId = response.jobId;
    elements["wb-render-status"].textContent = `job ${response.jobId}`;
  } catch (error) {
    elements["wb-render-status"].textContent = error.message;
  }
}

async function pollJob(jobId) {
  let job;
  try {
    job = await fetchJson(`/api/jobs/${encodeURIComponent(jobId)}`);
  } catch {
    return;
  }
  if (job.id === state.selectedJobId) {
    elements["wb-render-log"].textContent = job.log.join("\n");
    elements["wb-render-log"].scrollTop = elements["wb-render-log"].scrollHeight;
    elements["wb-render-status"].textContent = `${job.id}: ${job.status}${job.result ? ` · ${job.result.metadata?.totalFrames ?? "?"} frames` : ""}`;
  }
  if (job.status === "done" || job.status === "failed") {
    state.selectedJobId = null;
    await refreshArtifacts();
  }
}

async function refreshArtifacts() {
  const container = elements["wb-artifacts"];
  try {
    const listing = await fetchJson("/api/artifacts");
    if (listing.artifacts.length === 0) {
      container.innerHTML = `<p class="wb-empty">No artifacts under ${esc(listing.root)} yet.</p>`;
      return;
    }
    const rows = listing.artifacts.map((artifact) => {
      const encoded = encodeURIComponent(artifact.path);
      return `
        <tr>
          <td class="wb-artifact-path">${esc(artifact.path)}</td>
          <td>${artifact.bytes} B</td>
          <td><a href="/api/files/${encoded}" target="_blank" rel="noopener">open</a></td>
          <td><a href="/api/files/${encoded}" download="${esc(artifact.path.split("/").pop())}">download</a></td>
          <td><button type="button" class="wb-small" data-preview="${encoded}">preview</button></td>
        </tr>`;
    }).join("");
    container.innerHTML = `<table><thead><tr><th>Path</th><th>Size</th><th colspan="3">Actions</th></tr></thead><tbody>${rows}</tbody></table>`;
    container.querySelectorAll("button[data-preview]").forEach((button) => {
      button.addEventListener("click", () => void previewArtifact(decodeURIComponent(button.dataset.preview)));
    });
  } catch (error) {
    container.innerHTML = `<p class="wb-error">${esc(error.message)}</p>`;
  }
}

async function previewArtifact(relativePath) {
  const container = elements["wb-artifact-preview"];
  const url = `/api/files/${encodeURIComponent(relativePath)}`;
  const isVideo = relativePath.endsWith(".mp4") || relativePath.endsWith(".webm");
  if (isVideo) {
    container.innerHTML = `<video controls src="${url}" style="width:640px"></video>`;
  } else if (relativePath.endsWith(".png") || relativePath.endsWith(".svg")) {
    container.innerHTML = `<img alt="${esc(relativePath)}" src="${url}" style="width:640px">`;
  } else {
    container.innerHTML = `<p class="wb-muted">No inline preview for ${esc(relativePath)} — use open/download.</p>`;
  }
}

if (typeof document !== "undefined") {
  boot().catch((error) => {
    const meta = document.getElementById("wb-meta");
    if (meta) meta.textContent = `workbench failed to boot: ${error.message}`;
  });
}
