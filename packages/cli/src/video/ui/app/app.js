const language = localStorage.getItem('praxis.locale') === 'zh' ? 'zh-CN' : 'en';
function t(english, chinese, ...values) {
  return (language === 'en' ? english : chinese).replace(/\{(\d+)\}/g, (_, index) => String(values[index]));
}
document.documentElement.lang = language;
if (language === 'zh-CN') {
  for (const node of document.querySelectorAll('[data-zh]')) node.textContent = node.dataset.zh;
  for (const node of document.querySelectorAll('[data-zh-label]')) node.setAttribute('aria-label', node.dataset.zhLabel);
}
const languageButton = document.querySelector('#language');
if (languageButton) {
  languageButton.textContent = t('简体中文', 'English');
  languageButton.addEventListener('click', () => {
    const next = language === 'en' ? 'zh' : 'en';
    localStorage.setItem('praxis.locale', next);
    document.cookie = 'praxis_locale=' + next + '; Path=/; SameSite=Lax; Max-Age=31536000' + (location.protocol === 'https:' ? '; Secure' : '');
    location.reload();
  });
}

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

// Issue 005: the workbench is a portal route (/workbench/<deck-id>), so every
// API URL is namespaced under the injected base; the strict deck scope (a
// path scope, injected by the scoped shell) replaces the old ?deck= override.
const workbenchBase = typeof window !== "undefined" && window.__LATTICE_WORKBENCH_BASE ? String(window.__LATTICE_WORKBENCH_BASE) : "";
const scopedDeck = typeof window !== "undefined" && window.__LATTICE_WORKBENCH_DECK ? String(window.__LATTICE_WORKBENCH_DECK) : null;
// Issue 008: the shell re-reads the app sources per request and versions the
// /@fs module URLs; the player import carries the same version so a
// player.js edit produces a URL the browser has never cached. Without a
// shell-injected version (e.g. tests importing the app directly) the import
// degrades to today's stable URL.
const assetVersion = typeof window !== "undefined" && window.__LATTICE_WORKBENCH_ASSET_VERSION
  ? `?v=${String(window.__LATTICE_WORKBENCH_ASSET_VERSION)}`
  : "";

function apiUrl(path) {
  return `${workbenchBase}/api${path}`;
}

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
  for (const id of ["wb-meta", "wb-deck-list", "wb-deck-empty", "wb-deck-view", "wb-deck-name", "wb-deck-timeline-badge", "wb-timeline-summary", "wb-timeline", "wb-audience", "wb-audience-summary", "wb-refresh-audience", "wb-preview-stage", "wb-play", "wb-scrubber", "wb-frame-label", "wb-stop-select", "wb-preview-error", "wb-backend-select", "wb-render", "wb-render-status", "wb-render-log", "wb-refresh-artifacts", "wb-artifacts", "wb-artifact-preview"]) {
    elements[id] = byId(id);
  }

  // Wire the static DOM first: a failure in the data flow below (server
  // hiccup, racing seek) must never leave the controls dead.
  if (elements["wb-deck-list"]) {
    elements["wb-deck-list"].addEventListener("click", (event) => {
      const button = event.target.closest("button[data-deck]");
      if (button) void selectDeck(button.dataset.deck);
    });
  }
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
  elements["wb-refresh-audience"].addEventListener("click", () => void refreshAudience(state.selectedDeck));

  if (scopedDeck) {
    // Strictly deck-scoped route (/workbench/<deck-id>): bootstrap from
    // /api/backends only — never pull the project's other decks — and open
    // directly on the scoped deck's timeline. The deck picker is hidden by
    // the shell (body.wb-scoped) and stays empty.
    const health = await fetchJson(apiUrl("/backends"));
    state.backends = health.backends;
    elements["wb-meta"].textContent = "";
    renderBackendSelect();
    await refreshArtifacts(scopedDeck);
    await selectDeck(scopedDeck);
  } else {
    const health = await fetchJson(apiUrl("/decks"));
    state.decks = health.decks;
    state.backends = health.backends;
    elements["wb-meta"].textContent = t("Decks: {0}", "{0}份文稿", health.decks.length);

    renderDeckList();
    renderBackendSelect();
    await refreshArtifacts();

    // Deck picker fallback entry (/workbench): ?deck=<id> still lands
    // directly on that deck's view.
    const urlDeck = new URLSearchParams(window.location.search).get("deck");
    if (urlDeck) {
      const known = state.decks.some((deck) => deck.id === urlDeck);
      if (known) {
        await selectDeck(urlDeck);
      } else {
        elements["wb-deck-empty"].hidden = false;
        elements["wb-deck-empty"].innerHTML = t("Deck {0} was not found. Choose another deck.", "找不到文稿{0}，请选择其他文稿。", esc(JSON.stringify(urlDeck)));
        elements["wb-meta"].textContent = t("{0} · Deck unavailable", "{0} · 文稿不可用", elements["wb-meta"].textContent);
      }
    }
  }

  setInterval(() => {
    if (state.selectedJobId) void pollJob(state.selectedJobId);
  }, 1200);
}

function renderDeckList() {
  if (!elements["wb-deck-list"]) return;
  const items = state.decks.map((deck) => `
    <li>
      <button type="button" data-deck="${esc(deck.id)}" aria-current="${deck.id === state.selectedDeck}">
        ${esc(deck.title)}
        <span class="wb-deck-meta">${esc(deck.id)}${deck.hasTimeline ? t(" · Timeline", " · 含时间轴") : ""}</span>
      </button>
    </li>`).join("");
  elements["wb-deck-list"].innerHTML = items || t("<li class=\"wb-empty\">No decks available.</li>", "<li class=\"wb-empty\">暂无文稿。</li>");
}

function renderBackendSelect() {
  elements["wb-backend-select"].innerHTML = state.backends
    .map((backend) => `<option value="${esc(backend)}">${esc(backend)}</option>`)
    .join("");
}

async function selectDeck(deckId) {
  state.selectedDeck = deckId;
  renderDeckList();
  // Keep the address honest in the picker: a selected deck is addressable as
  // ?deck=<id>, so refresh/deep links land on the same view. The scoped
  // route (/workbench/<deck-id>) keeps its path-pure URL.
  if (!scopedDeck) {
    const url = new URL(window.location.href);
    if (url.searchParams.get("deck") !== deckId) {
      url.searchParams.set("deck", deckId);
      window.history.replaceState(null, "", `${url.pathname}${url.search}`);
    }
  }
  elements["wb-deck-empty"].hidden = true;
  elements["wb-deck-view"].hidden = false;
  elements["wb-deck-name"].textContent = deckId;
  void refreshAudience(deckId);
  let descriptor;
  try {
    descriptor = await fetchJson(apiUrl(`/decks/${encodeURIComponent(deckId)}/descriptor`));
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
  elements["wb-timeline-summary"].textContent = t("Slides: {0} · Frames: {1} · Seconds: {2}", "{0}页 · {1}帧 · {2}秒", segments.length, totalFrames, seconds);
  container.innerHTML = "";

  // One axis per row: segments + stops, and one row per audio track.
  const axis = document.createElement("div");
  axis.className = "wb-axis";
  axis.innerHTML = t("<div class=\"wb-axis-label\">Slides and steps (frames)</div>", "<div class=\"wb-axis-label\">页面与步骤（帧）</div>");
  const track = document.createElement("div");
  track.className = "wb-axis-track";
  let cursor = 0;
  for (const segment of segments) {
    const width = (segment.durationFrames / totalFrames) * 100;
    const segmentElement = document.createElement("div");
    segmentElement.className = "wb-segment";
    segmentElement.style.left = `${(cursor / totalFrames) * 100}%`;
    segmentElement.style.width = `${width}%`;
    segmentElement.innerHTML = t("<span class=\"wb-segment-name\">{0} · {1} frames</span>", "<span class=\"wb-segment-name\">{0} · {1}帧</span>", esc(segment.slideId), segment.durationFrames);
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

  // Audio lanes stack BELOW the main segment/stop axis (UI tweak), grouped
  // with a visual separator; each lane keeps its left label + role styling.
  const audioGroup = document.createElement("div");
  audioGroup.className = "wb-audio-group";
  for (const trackDescriptor of descriptor.audioTracks ?? []) {
    const audioAxis = document.createElement("div");
    audioAxis.className = "wb-axis";
    // M10 dual-track visualization: narration and bgm are distinct roles on
    // the timeline, styled and labeled from the deck's timeline.audio
    // declarations (voice / style+seed); other track ids stay generic.
    const declaration = descriptor.timeline?.audio ?? null;
    const role = trackDescriptor.id === "narration" || trackDescriptor.id === "bgm" ? trackDescriptor.id : null;
    if (role) audioAxis.classList.add(`wb-axis-${role}`);
    const details = [];
    if (role === "narration" && declaration?.narration?.voice) details.push(t("Voice: {0}", "音色 {0}", declaration.narration.voice));
    if (role === "bgm" && declaration?.bgm) details.push(t("Style: {0}{1}", "风格 {0}{1}", declaration.bgm.style, declaration.bgm.seed !== undefined ? t(" · Seed: {0}", " · 种子 {0}", declaration.bgm.seed) : ""));
    details.push(t("Start frame: {0}", "起点 {0}帧", trackDescriptor.startFrame), t("Volume: {0}", "音量 {0}", esc(trackDescriptor.volume ?? 1)));
    audioAxis.innerHTML = t("<div class=\"wb-axis-label\">Audio · {0} ({1})</div>", "<div class=\"wb-axis-label\">音轨 · {0} ({1})</div>", role ? `<span class="wb-audio-role">${role === "narration" ? t("Narration", "讲解") : t("Music", "音乐")}</span>` : esc(trackDescriptor.id), details.join(", "));
    const audioTrack = document.createElement("div");
    audioTrack.className = "wb-axis-track";
    const bar = document.createElement("div");
    bar.className = role ? `wb-audio-bar wb-audio-${role}` : "wb-audio-bar";
    bar.style.left = `${(trackDescriptor.startFrame / totalFrames) * 100}%`;
    const duration = trackDescriptor.durationFrames ?? Math.max(1, totalFrames - trackDescriptor.startFrame);
    bar.style.width = `${(Math.min(duration, totalFrames - trackDescriptor.startFrame) / totalFrames) * 100}%`;
    // The narration track is stitched per slide segment — show where each
    // segment's narration window sits on the bar (the segment's span minus
    // its reveal tail is where speech is fitted; the deck's duration contract
    // keeps it inside the slide's frames).
    if (role === "narration") {
      for (const segment of segments) {
        const windowStart = Math.max(0, segment.startFrame - trackDescriptor.startFrame);
        const tick = document.createElement("div");
        tick.className = "wb-audio-segment-mark";
        tick.style.left = `${(windowStart / totalFrames) * 100}%`;
        tick.setAttribute("data-narration-segment", segment.slideId);
        audioTrack.appendChild(tick);
      }
    }
    bar.innerHTML = `<span class="wb-audio-name">${esc(trackDescriptor.src)}</span>`;
    audioTrack.appendChild(bar);
    audioAxis.appendChild(audioTrack);
    audioGroup.appendChild(audioAxis);
  }
  if (audioGroup.children.length > 0) container.appendChild(audioGroup);
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
  const { createTimelinePlayer } = await import(/* @vite-ignore */ `./player.js${assetVersion}`);
  if (state.descriptor !== descriptor) return;
  const stage = elements["wb-preview-stage"];
  stage.innerHTML = "";
  const canvasHost = document.createElement("div");
  const width = descriptor.canvas?.width ?? 960;
  const height = descriptor.canvas?.height ?? 540;
  Object.assign(canvasHost.style, { position: "absolute", top: "0", width: `${width}px`, height: `${height}px`, transformOrigin: "top left" });
  stage.appendChild(canvasHost);
  const styleElement = document.createElement("style");
  styleElement.textContent = `${descriptor.themeCss}${descriptor.presetCss ? `\n${descriptor.presetCss}` : ""}`;
  document.head.appendChild(styleElement);

  const player = createTimelinePlayer({
    stage: canvasHost,
    descriptor,
    // Issue 007: audio asset URLs are canonical API paths in the descriptor;
    // the audio elements need the workbench base prefix like every other
    // app-side fetch (apiUrl takes the path AFTER the /api segment).
    audioAssets: (descriptor.audioAssets ?? []).map((asset) => ({ ...asset, url: apiUrl(asset.url.replace(/^\/api(?=\/)/, "")) })),
  });
  state.player = player;
  // Fit only the outer display host; the runtime keeps its logical canvas.
  let previousWidth = -1, fitFrame = null, disposed = false;
  const fit = () => {
    const available = stage.clientWidth;
    if (available < 1 || available === previousWidth) return;
    previousWidth = available;
    const scale = Math.min(1, available / width);
    stage.style.height = `${height * scale}px`;
    canvasHost.style.left = `${(available - width * scale) / 2}px`;
    canvasHost.style.transform = `scale(${scale})`;
  };
  const scheduleFit = () => {
    if (disposed || fitFrame !== null) return;
    fitFrame = window.requestAnimationFrame(() => { fitFrame = null; fit(); });
  };
  const observer = typeof ResizeObserver === "function" ? new ResizeObserver(scheduleFit) : null;
  if (observer) observer.observe(stage);
  else window.addEventListener("resize", scheduleFit);
  const destroy = player.destroy.bind(player);
  const dispose = event => { if (!event.persisted) player.destroy(); };
  player.destroy = () => {
    if (disposed) return;
    disposed = true;
    observer?.disconnect();
    if (fitFrame !== null) window.cancelAnimationFrame(fitFrame);
    if (!observer) window.removeEventListener("resize", scheduleFit);
    window.removeEventListener("pagehide", dispose);
    destroy();
    canvasHost.remove();
    styleElement.remove();
    if (state.player === player) state.player = null;
    if (window.__latticeWorkbenchPlayer === player) delete window.__latticeWorkbenchPlayer;
  };
  window.addEventListener("pagehide", dispose);
  fit();
  const totalFrames = player.totalFrames;
  elements["wb-scrubber"].max = String(totalFrames - 1);
  elements["wb-scrubber"].value = "0";
  elements["wb-stop-select"].innerHTML = player.stopTicks
    .map((tick, index) => t("<option value=\"{0}\">Step {1} (frame {2})</option>", "<option value=\"{0}\">步骤{1}（第{2}帧）</option>", index, index + 1, tick))
    .join("");
  elements["wb-frame-label"].textContent = t("Frame 0 / {0}", "第0帧 / 共{0}帧", totalFrames - 1);
  await player.seek(0);
  if (state.player !== player) return;
  updateScrubber();
  // Machine-readable surface for tests and the inspection harness (same
  // pattern as window.__latticeInspection): the live player instance. Set
  // only after the initial seek settles — its existence also signals that
  // the preview finished mounting (no racy mid-boot access).
  window.__latticeWorkbenchPlayer = player;
}

function updateScrubber() {
  if (!state.player) return;
  const frame = state.player.frame;
  elements["wb-scrubber"].value = String(frame);
  elements["wb-frame-label"].textContent = t("Frame {0} / {1}{2}", "第{0}帧 / 共{1}帧{2}", frame, state.player.totalFrames - 1, state.player.playing ? t(" (playing)", "（播放中）") : "");
}

async function togglePlay() {
  if (!state.player) return;
  if (state.player.playing) {
    state.player.pause();
    elements["wb-play"].textContent = t("Play", "播放");
    updateScrubber();
    return;
  }
  elements["wb-play"].textContent = t("Pause", "暂停");
  if (state.player.frame >= state.player.totalFrames - 1) {
    await state.player.seek(0);
  }
  await state.player.play({ onFrame: updateScrubber });
  elements["wb-play"].textContent = t("Play", "播放");
  updateScrubber();
}

async function startRender() {
  const deck = state.selectedDeck;
  const backend = elements["wb-backend-select"].value;
  if (!deck || !backend) return;
  elements["wb-render-status"].textContent = t("Queuing…", "正在排队…");
  elements["wb-render-log"].hidden = false;
  elements["wb-render-log"].textContent = "";
  try {
    const response = await fetchJson(apiUrl("/render"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ deck, backend }),
    });
    state.selectedJobId = response.jobId;
    elements["wb-render-status"].textContent = t("Exporting…", "正在导出…");
  } catch (error) {
    elements["wb-render-status"].textContent = error.message;
  }
}

async function pollJob(jobId) {
  let job;
  try {
    job = await fetchJson(apiUrl(`/jobs/${encodeURIComponent(jobId)}`));
  } catch {
    return;
  }
  if (job.id === state.selectedJobId) {
    elements["wb-render-log"].textContent = job.log.join("\n");
    elements["wb-render-log"].scrollTop = elements["wb-render-log"].scrollHeight;
    elements["wb-render-status"].textContent = `${({ queued: t("Queued", "排队中"), running: t("Exporting", "正在导出"), done: t("Exported", "导出完成"), failed: t("Export failed", "导出失败") })[job.status] ?? job.status}${job.result ? t(" · {0} frames", " · {0}帧", job.result.metadata?.totalFrames ?? "?") : ""}`;
  }
  if (job.status === "done" || job.status === "failed") {
    state.selectedJobId = null;
    await refreshArtifacts();
  }
}

async function refreshArtifacts(deckFilter = null) {
  const container = elements["wb-artifacts"];
  try {
    // Scoped views pass their deck so the listing never shows another
    // deck's artifacts.
    const listing = await fetchJson(apiUrl(`/artifacts${deckFilter ? `?deck=${encodeURIComponent(deckFilter)}` : ""}`));
    if (listing.artifacts.length === 0) {
      container.innerHTML = t("<p class=\"wb-empty\">No exported files.</p>", "<p class=\"wb-empty\">暂无导出文件。</p>");
      return;
    }
    const rows = listing.artifacts.map((artifact) => {
      const encoded = encodeURIComponent(artifact.path);
      return `
        <tr>
          <td class="wb-artifact-path">${esc(artifact.path)}</td>
          <td>${artifact.bytes} B</td>
          <td><a href="${esc(apiUrl(`/files/${encoded}`))}" target="_blank" rel="noopener">${t("Open", "打开")}</a></td>
          <td><a href="${esc(apiUrl(`/files/${encoded}`))}" download="${esc(artifact.path.split("/").pop())}">${t("Download", "下载")}</a></td>
          <td><button type="button" class="wb-small" data-preview="${encoded}">${t("Preview", "预览")}</button></td>
        </tr>`;
    }).join("");
    container.innerHTML = t("<table><thead><tr><th>File</th><th>Size</th><th colspan=\"3\">Actions</th></tr></thead><tbody>{0}</tbody></table>", "<table><thead><tr><th>文件</th><th>大小</th><th colspan=\"3\">操作</th></tr></thead><tbody>{0}</tbody></table>", rows);
    container.querySelectorAll("button[data-preview]").forEach((button) => {
      button.addEventListener("click", () => void previewArtifact(decodeURIComponent(button.dataset.preview)));
    });
  } catch (error) {
    container.innerHTML = `<p class="wb-error">${esc(error.message)}</p>`;
  }
}

async function previewArtifact(relativePath) {
  const container = elements["wb-artifact-preview"];
  const url = apiUrl(`/files/${encodeURIComponent(relativePath)}`);
  const isVideo = relativePath.endsWith(".mp4") || relativePath.endsWith(".webm");
  if (isVideo) {
    container.innerHTML = `<video controls src="${url}" style="width:640px"></video>`;
  } else if (relativePath.endsWith(".png") || relativePath.endsWith(".svg")) {
    container.innerHTML = `<img alt="${esc(relativePath)}" src="${url}" style="width:640px">`;
  } else {
    container.innerHTML = t("<p class=\"wb-muted\">Preview unavailable. Open or download this file.</p>", "<p class=\"wb-muted\">该文件暂不支持预览，可以打开或下载。</p>");
  }
}

// ---- 观众席 · Audience panel (AI audience v1.2) ------------------------------
//
// Reads the deck's rehearsal sessions through /api/decks/<id>/audience
// (strictly deck-scoped, no-store) and renders session history, the
// per-round score curve, verdict status, and the current (residual) findings.

const AUDIENCE_DIMENSIONS = ["accuracy", "clarity", "pacing", "structure", "audio"];
const AUDIENCE_DIMENSION_NAMES = { accuracy: t("Accuracy", "准确性"), clarity: t("Clarity", "清晰度"), pacing: t("Pacing", "节奏"), structure: t("Structure", "结构"), audio: t("Audio", "音频") };
const AUDIENCE_DIMENSION_COLORS = {
  accuracy: "#b3362a",
  clarity: "#2f6b55",
  pacing: "#c46b35",
  structure: "#3b5b8c",
  audio: "#7a5b9a",
};

function audienceMeanScores(round) {
  const perDimension = {};
  let personaCount = 0;
  for (const review of round.reviews ?? []) {
    if (!review.scores) continue;
    personaCount += 1;
    for (const dimension of AUDIENCE_DIMENSIONS) {
      const value = review.scores[dimension];
      if (typeof value === "number" && Number.isFinite(value)) {
        (perDimension[dimension] ??= []).push(value);
      }
    }
  }
  const means = {};
  for (const [dimension, values] of Object.entries(perDimension)) {
    means[dimension] = values.reduce((sum, value) => sum + value, 0) / values.length;
  }
  return { means, personaCount };
}

function audienceScoreCurveSvg(rounds) {
  const width = 480;
  const height = 140;
  const padLeft = 26;
  const padBottom = 20;
  const innerWidth = width - padLeft - 8;
  const innerHeight = height - padBottom - 10;
  const x = (index) => padLeft + (rounds.length <= 1 ? innerWidth / 2 : (index / (rounds.length - 1)) * innerWidth);
  const y = (score) => 10 + (1 - score / 5) * innerHeight;
  const gridLines = [0, 1, 2, 3, 4, 5].map((score) =>
    `<line x1="${padLeft}" y1="${y(score).toFixed(1)}" x2="${width - 8}" y2="${y(score).toFixed(1)}" stroke="#eeeeee" stroke-width="1"></line>` +
    `<text x="${padLeft - 4}" y="${(y(score) + 3).toFixed(1)}" font-size="9" fill="#888888" text-anchor="end">${score}</text>`
  ).join("");
  const roundLabels = rounds.map((round, index) =>
    `<text x="${x(index).toFixed(1)}" y="${height - 6}" font-size="9" fill="#888888" text-anchor="middle">R${round.n}</text>`
  ).join("");
  const dimensionData = AUDIENCE_DIMENSIONS.map((dimension) => {
    const points = [];
    rounds.forEach((round, index) => {
      const { means } = audienceMeanScores(round);
      if (typeof means[dimension] === "number") points.push([x(index), y(means[dimension])]);
    });
    return { dimension, points };
  }).filter((entry) => entry.points.length >= 2);
  const polylines = dimensionData.map(({ dimension, points }) =>
    `<polyline fill="none" stroke="${AUDIENCE_DIMENSION_COLORS[dimension]}" stroke-width="1.5" points="${points.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(" ")}"></polyline>`
  ).join("");
  const legend = dimensionData.map(({ dimension }) =>
    `<span class="wb-audience-legend-item"><span class="wb-audience-legend-swatch" style="background:${AUDIENCE_DIMENSION_COLORS[dimension]}"></span>${AUDIENCE_DIMENSION_NAMES[dimension]}</span>`
  ).join("");
  return t("<svg class=\"wb-audience-curve\" viewBox=\"0 0 {0} {1}\" role=\"img\" aria-label=\"Scores by rehearsal\">{2}{3}{4}</svg>", "<svg class=\"wb-audience-curve\" viewBox=\"0 0 {0} {1}\" role=\"img\" aria-label=\"各轮排练评分\">{2}{3}{4}</svg>", width, height, gridLines, roundLabels, polylines) +
    (legend ? `<p class="wb-audience-legend">${legend}</p>` : "");
}

function audienceRoundRows(rounds) {
  return rounds.map((round) => {
    const improvement = round.improvement
      ? `${round.improvement.improved ? t("Improved", "有改进") : t("No improvement yet", "暂无改进")}${round.improvement.resolvedPrevious ? t(" ({0} resolved)", "（已解决{0}项）", round.improvement.resolvedPrevious) : ""}`
      : "—";
    return `<tr><td>R${round.n}</td><td>${round.findingsCount}</td><td>${round.verdicts.resolved}/${round.verdicts.persists}</td><td>${round.improvements}</td><td>${esc(improvement)}</td></tr>`;
  }).join("");
}

function audienceFindingsRows(findings, cap = 20) {
  return findings.slice(0, cap).map((finding) => {
    const address = finding.frameAddress ? `${esc(finding.frameAddress.slideId)}@${esc(finding.frameAddress.localFrame)}` : "—";
    return `<tr><td class="wb-audience-finding-id">${esc(finding.id)}</td><td>${esc(finding.severity)}</td><td>${esc(AUDIENCE_DIMENSION_NAMES[finding.dimension] ?? finding.dimension)}</td><td><code>${address}</code></td><td>${esc(finding.comment)}</td></tr>`;
  }).join("") + (findings.length > cap ? t("<tr><td colspan=\"5\" class=\"wb-muted\">… {0} more open findings</td></tr>", "<tr><td colspan=\"5\" class=\"wb-muted\">… 另有{0}项待处理问题</td></tr>", findings.length - cap) : "");
}

function audienceOutcome(value) {
  return { ongoing: t("In progress", "进行中"), converged: t("Converged", "已收敛"), escalated: t("Pending", "待处理"), inconclusive: t("No conclusion", "暂无结论") }[value] ?? value ?? t("No conclusion", "暂无结论");
}

async function refreshAudience(deckId) {
  const container = elements["wb-audience"];
  if (!container || !deckId) return;
  try {
    const panel = await fetchJson(apiUrl(`/decks/${encodeURIComponent(deckId)}/audience`));
    const sessions = panel.sessions ?? [];
    elements["wb-audience-summary"].textContent = sessions.length === 0
      ? t("No rehearsals yet", "暂无排练记录")
      : t("Rehearsals: {0} · Latest: {1}", "{0}次排练 · 最近：{1}", sessions.length, audienceOutcome(panel.latest?.convergence?.outcome));
    if (sessions.length === 0) {
      container.innerHTML = t("<p class=\"wb-empty\">This deck has no rehearsals yet.</p>", "<p class=\"wb-empty\">这份文稿还没有排练记录。</p>");
      return;
    }
    const latest = panel.latest;
    const conclusion = latest.conclusion
      ? t("<span class=\"pill wb-pill-{0}\">Outcome: {1}</span>", "<span class=\"pill wb-pill-{0}\">结论：{1}</span>", esc(latest.conclusion.outcome ?? "info"), esc(audienceOutcome(latest.conclusion.outcome)))
      : "";
    container.innerHTML = `
      <div class="wb-audience-head">
        <p class="wb-muted">${esc(latest.file)} · pack ${esc((latest.packHashes?.[latest.packHashes.length - 1] ?? "?").slice(0, 12))} ${conclusion}</p>
      </div>
      <div class="wb-audience-grid">
        <div>
          <h4>${t("Round scores", "各轮评分")}</h4>
          ${audienceScoreCurveSvg(latest.rounds)}
        </div>
        <div>
          <h4>${t("Rehearsals", "排练记录")}</h4>
          <table class="wb-audience-table"><thead><tr><th>${t("Round", "轮次")}</th><th>${t("Findings", "问题")}</th><th>${t("Resolved / retained", "解决／保留")}</th><th>${t("Improvement", "改进")}</th><th>${t("Status", "状态")}</th></tr></thead><tbody>${audienceRoundRows(latest.rounds)}</tbody></table>
          <p class="wb-muted">${t("Convergence: ", "收敛情况：")}${esc(audienceOutcome(latest.convergence?.outcome))} — ${esc(latest.convergence?.rationale ?? "")}</p>
        </div>
      </div>
      <h4>${t("Open findings: ", "待处理问题：")}${latest.residual?.length ?? 0}</h4>
      ${(latest.residual?.length ?? 0) > 0
        ? t("<table class=\"wb-audience-table\"><thead><tr><th>ID</th><th>Severity</th><th>Dimension</th><th>Scene</th><th>Feedback</th></tr></thead><tbody>{0}</tbody></table>", "<table class=\"wb-audience-table\"><thead><tr><th>编号</th><th>严重程度</th><th>维度</th><th>画面</th><th>意见</th></tr></thead><tbody>{0}</tbody></table>", audienceFindingsRows(latest.residual))
        : t("<p class=\"wb-empty\">All findings resolved.</p>", "<p class=\"wb-empty\">全部问题已解决。</p>")}
      <details class="wb-audience-history"><summary>排练历史（${sessions.length}次）</summary>
        <ul>${sessions.map((session) => t("<li>{0} — {1} rounds · {2}{3}</li>", "<li>{0} — {1}轮 · {2}{3}</li>", esc(session.file), session.rounds.length, esc(audienceOutcome(session.convergence?.outcome)), session.conclusion ? t(" · Outcome: {0}", " · 结论：{0}", esc(audienceOutcome(session.conclusion.outcome))) : "")).join("")}</ul>
      </details>`;
  } catch (error) {
    container.innerHTML = `<p class="wb-error">${esc(error.message)}</p>`;
  }
}

if (typeof document !== "undefined") {
  boot().catch((error) => {
    const meta = document.getElementById("wb-meta");
    if (meta) meta.textContent = t("Could not open the video workbench: {0}", "视频工作区暂时无法打开：{0}", error.message);
  });
}
