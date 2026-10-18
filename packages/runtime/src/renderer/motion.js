/*
 * Frame Mode turns one authored slide into a sequence of source-relative
 * states. The slide markup remains the only content source: local storage
 * contains just DOM paths and visibility/focus rules, never cloned slide HTML.
 */

const STORAGE_VERSION = 1;
const DEFAULT_LENS = "audience";
const LENSES = ["audience", "delta", "onion", "structure"];
const NAVIGATION_KEYS = new Set(["ArrowLeft", "ArrowRight", "PageUp", "PageDown", " "]);

export function renderFrameMode(container, deckDefinition) {
  const sourceMarkup = deckDefinition.buildSlides();
  const url = new URL(window.location.href);
  const initialSource = clampInt(url.searchParams.get("source"), 0, sourceMarkup.length - 1);
  const initialLens = LENSES.includes(url.searchParams.get("lens")) ? url.searchParams.get("lens") : DEFAULT_LENS;
  const storageKey = `lattice-frame-mode:${deckDefinition.id}:v${STORAGE_VERSION}`;
  const state = loadStore(storageKey);
  const session = {
    deckDefinition,
    sourceMarkup,
    sourceIndex: initialSource,
    frameIndex: Math.max(0, Number.parseInt(url.searchParams.get("frame"), 10) || 0),
    lens: initialLens,
    selected: new Set(),
    playing: false,
    playTimer: null,
    dragSource: null,
    lasso: null,
    store: state,
  };

  container.innerHTML = frameModeShell(deckDefinition);

  const elements = {
    container,
    title: container.querySelector("#motion-source-title"),
    caption: container.querySelector("#motion-source-caption"),
    status: container.querySelector("#motion-analysis-status"),
    stage: container.querySelector("#motion-stage"),
    rail: container.querySelector("#motion-frame-rail"),
    currentLabel: container.querySelector("#motion-current-label"),
    previous: container.querySelector("#motion-previous"),
    next: container.querySelector("#motion-next"),
    play: container.querySelector("#motion-play"),
    frameName: container.querySelector("#motion-frame-name"),
    add: container.querySelector("#motion-add"),
    duplicate: container.querySelector("#motion-duplicate"),
    merge: container.querySelector("#motion-merge"),
    remove: container.querySelector("#motion-delete"),
    regenerate: container.querySelector("#motion-regenerate"),
    revealHere: container.querySelector("#motion-reveal-here"),
    revealNext: container.querySelector("#motion-reveal-next"),
    focus: container.querySelector("#motion-focus"),
    clearFocus: container.querySelector("#motion-clear-focus"),
    split: container.querySelector("#motion-split"),
    selection: container.querySelector("#motion-selection"),
    lensButtons: Array.from(container.querySelectorAll("[data-motion-lens]")),
  };

  function sourceKey(index = session.sourceIndex) {
    return `slide-${index}`;
  }

  function ensureModel() {
    const key = sourceKey();
    const fingerprint = hashString(normalizeMarkup(sourceMarkup[session.sourceIndex]));
    const stored = session.store.slides[key];
    if (stored?.fingerprint === fingerprint && validateModel(stored)) {
      session.frameIndex = clampInt(session.frameIndex, 0, stored.frames.length - 1);
      return stored;
    }

    const model = autoAnalyseSlide(sourceMarkup[session.sourceIndex], session.sourceIndex, fingerprint);
    session.store.slides[key] = model;
    saveStore(storageKey, session.store);
    session.frameIndex = clampInt(session.frameIndex, 0, model.frames.length - 1);
    return model;
  }

  function currentModel() {
    return ensureModel();
  }

  function currentFrame() {
    const model = currentModel();
    return model.frames[session.frameIndex];
  }

  function save() {
    saveStore(storageKey, session.store);
  }

  function updateUrl() {
    const nextUrl = new URL(window.location.href);
    nextUrl.searchParams.set("motion", "1");
    nextUrl.searchParams.set("source", String(session.sourceIndex));
    nextUrl.searchParams.set("frame", String(session.frameIndex));
    nextUrl.searchParams.set("lens", session.lens);
    window.history.replaceState({}, "", nextUrl);
  }

  function render() {
    const model = currentModel();
    const frame = currentFrame();
    const sourceSection = parseSlide(sourceMarkup[session.sourceIndex]);
    const sourceSlide = sourceSection.querySelector("section");
    const canvas = sourceSection.querySelector(".slide-canvas");
    const slideNumber = sourceSlide?.dataset.slideNumber || String(session.sourceIndex + 1);
    const titleText = cleanText(sourceSection.querySelector(".title")?.textContent) || `Slide ${slideNumber}`;

    elements.title.textContent = `Slide ${slideNumber}`;
    elements.caption.textContent = titleText;
    elements.status.textContent = `${model.units.length} visual groups · ${model.frames.length} frames · source-relative`;
    elements.currentLabel.textContent = `Frame ${session.frameIndex + 1} / ${model.frames.length}`;
    elements.frameName.value = frame.label;
    elements.previous.disabled = session.sourceIndex === 0 && session.frameIndex === 0;
    elements.next.disabled = session.sourceIndex === sourceMarkup.length - 1 && session.frameIndex === model.frames.length - 1;
    elements.merge.disabled = model.frames.length < 2;
    elements.remove.disabled = model.frames.length < 2;
    elements.play.textContent = session.playing ? "Pause" : "Play";
    elements.lensButtons.forEach((button) => {
      const active = button.dataset.motionLens === session.lens;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    elements.selection.textContent = selectionSummary(model, session.selected);
    elements.revealHere.disabled = session.selected.size === 0;
    elements.revealNext.disabled = session.selected.size === 0;
    elements.focus.disabled = session.selected.size === 0;
    elements.clearFocus.disabled = !frame.focus?.length;
    elements.split.disabled = session.selected.size !== 1;

    renderStage(elements.stage, sourceMarkup[session.sourceIndex], model, session.frameIndex, session.lens, session.selected);
    renderRail(elements.rail, sourceMarkup[session.sourceIndex], model, session.frameIndex);
    updateUrl();

    // Page numbers are populated by Reveal in normal deck mode. The Frame
    // viewer renders the source section directly, so keep those numbers alive.
    elements.stage.querySelectorAll(".slide-page-number").forEach((pageNumber) => {
      pageNumber.textContent = slideNumber;
    });
    if (!canvas) console.warn("[lattice] Frame Mode could not locate a slide canvas.");
  }

  function move(step) {
    const model = currentModel();
    const nextFrame = session.frameIndex + step;
    if (nextFrame >= 0 && nextFrame < model.frames.length) {
      session.frameIndex = nextFrame;
    } else if (nextFrame >= model.frames.length && session.sourceIndex < sourceMarkup.length - 1) {
      session.sourceIndex += 1;
      session.frameIndex = 0;
    } else if (nextFrame < 0 && session.sourceIndex > 0) {
      session.sourceIndex -= 1;
      session.frameIndex = currentModel().frames.length - 1;
    } else {
      stopPlaying();
      return;
    }
    session.selected.clear();
    render();
  }

  function mutateFrames(callback) {
    const model = currentModel();
    callback(model.frames, model);
    model.frames = model.frames.map(normalizeFrame);
    session.frameIndex = clampInt(session.frameIndex, 0, model.frames.length - 1);
    save();
    render();
  }

  function insertFrame({ duplicate = false } = {}) {
    mutateFrames((frames) => {
      const current = frames[session.frameIndex];
      const inserted = cloneFrame(current, duplicate ? `${current.label} copy` : "New frame");
      if (!duplicate) inserted.focus = [];
      frames.splice(session.frameIndex + 1, 0, inserted);
      session.frameIndex += 1;
    });
  }

  function mergeWithNeighbor() {
    mutateFrames((frames) => {
      const targetIndex = session.frameIndex < frames.length - 1 ? session.frameIndex + 1 : session.frameIndex - 1;
      const firstIndex = Math.min(session.frameIndex, targetIndex);
      const secondIndex = Math.max(session.frameIndex, targetIndex);
      const merged = {
        id: createId("frame"),
        label: `${frames[firstIndex].label} + ${frames[secondIndex].label}`.replace(/ \+ Full view$/, ""),
        visible: unique([...frames[firstIndex].visible, ...frames[secondIndex].visible]),
        focus: unique([...frames[firstIndex].focus, ...frames[secondIndex].focus]),
      };
      frames.splice(firstIndex, 2, merged);
      session.frameIndex = firstIndex;
    });
  }

  function removeFrame() {
    mutateFrames((frames) => {
      if (frames.length <= 1) return;
      frames.splice(session.frameIndex, 1);
      session.frameIndex = Math.min(session.frameIndex, frames.length - 1);
    });
  }

  function revealSelection({ next = false } = {}) {
    if (!session.selected.size) return;
    mutateFrames((frames) => {
      let destination = session.frameIndex + (next ? 1 : 0);
      if (destination >= frames.length) {
        frames.push(cloneFrame(frames[frames.length - 1], "New reveal"));
      }
      for (let index = destination; index < frames.length; index += 1) {
        frames[index].visible = unique([...frames[index].visible, ...session.selected]);
      }
      if (next) session.frameIndex = destination;
    });
  }

  function focusSelection() {
    if (!session.selected.size) return;
    mutateFrames((frames) => {
      frames[session.frameIndex].focus = [...session.selected];
    });
  }

  function clearFocus() {
    mutateFrames((frames) => {
      frames[session.frameIndex].focus = [];
    });
  }

  function regenerate() {
    const key = sourceKey();
    const fingerprint = hashString(normalizeMarkup(sourceMarkup[session.sourceIndex]));
    session.store.slides[key] = autoAnalyseSlide(sourceMarkup[session.sourceIndex], session.sourceIndex, fingerprint);
    session.frameIndex = 0;
    session.selected.clear();
    save();
    render();
  }

  function splitSelectedUnit() {
    if (session.selected.size !== 1) return;
    const selectedId = [...session.selected][0];
    const model = currentModel();
    const selected = model.units.find(({ id }) => id === selectedId);
    if (!selected) return;
    const source = parseSlide(sourceMarkup[session.sourceIndex]);
    const canvas = source.querySelector(".slide-canvas");
    const selectedNode = nodeFromPath(canvas, selected.path);
    const children = substantialChildren(selectedNode);
    if (children.length < 2) return;

    const selectedIndex = model.units.findIndex(({ id }) => id === selectedId);
    const units = children.map((child, index) => ({
      id: createId(`unit-${index + 1}`),
      path: pathFrom(canvas, child),
      label: inferLabel(child, index + 1),
      role: selected.role === "title" ? "title" : "body",
    }));
    model.units.splice(selectedIndex, 1, ...units);
    model.frames.forEach((frame) => {
      const visible = frame.visible.includes(selectedId);
      const focused = frame.focus.includes(selectedId);
      frame.visible = frame.visible.filter((id) => id !== selectedId);
      frame.focus = frame.focus.filter((id) => id !== selectedId);
      if (visible) frame.visible.push(...units.map(({ id }) => id));
      if (focused) frame.focus.push(...units.map(({ id }) => id));
    });
    session.selected = new Set(units.map(({ id }) => id));
    save();
    render();
  }

  function setLens(lens) {
    session.lens = lens;
    render();
  }

  function stopPlaying() {
    session.playing = false;
    if (session.playTimer) window.clearInterval(session.playTimer);
    session.playTimer = null;
  }

  function togglePlaying() {
    if (session.playing) {
      stopPlaying();
      render();
      return;
    }
    session.playing = true;
    session.playTimer = window.setInterval(() => move(1), 1250);
    render();
  }

  elements.previous.addEventListener("click", () => move(-1));
  elements.next.addEventListener("click", () => move(1));
  elements.play.addEventListener("click", togglePlaying);
  elements.add.addEventListener("click", () => insertFrame());
  elements.duplicate.addEventListener("click", () => insertFrame({ duplicate: true }));
  elements.merge.addEventListener("click", mergeWithNeighbor);
  elements.remove.addEventListener("click", removeFrame);
  elements.regenerate.addEventListener("click", regenerate);
  elements.revealHere.addEventListener("click", () => revealSelection());
  elements.revealNext.addEventListener("click", () => revealSelection({ next: true }));
  elements.focus.addEventListener("click", focusSelection);
  elements.clearFocus.addEventListener("click", clearFocus);
  elements.split.addEventListener("click", splitSelectedUnit);
  elements.lensButtons.forEach((button) => button.addEventListener("click", () => setLens(button.dataset.motionLens)));
  elements.frameName.addEventListener("change", () => {
    const label = cleanText(elements.frameName.value) || `Frame ${session.frameIndex + 1}`;
    mutateFrames((frames) => { frames[session.frameIndex].label = label; });
  });

  elements.rail.addEventListener("click", (event) => {
    const card = event.target.closest("[data-frame-index]");
    if (!card) return;
    session.frameIndex = Number.parseInt(card.dataset.frameIndex, 10);
    session.selected.clear();
    render();
  });
  elements.rail.addEventListener("dragstart", (event) => {
    const card = event.target.closest("[data-frame-index]");
    if (!card) return;
    session.dragSource = Number.parseInt(card.dataset.frameIndex, 10);
    event.dataTransfer.effectAllowed = "move";
  });
  elements.rail.addEventListener("dragover", (event) => {
    if (event.target.closest("[data-frame-index]")) event.preventDefault();
  });
  elements.rail.addEventListener("drop", (event) => {
    const card = event.target.closest("[data-frame-index]");
    if (!card || session.dragSource === null) return;
    event.preventDefault();
    const destination = Number.parseInt(card.dataset.frameIndex, 10);
    if (destination === session.dragSource) return;
    mutateFrames((frames) => {
      const [moved] = frames.splice(session.dragSource, 1);
      frames.splice(destination, 0, moved);
      session.frameIndex = destination;
    });
    session.dragSource = null;
  });

  bindCanvasSelection(elements.stage, session, currentModel, render);
  window.addEventListener("keydown", (event) => {
    const target = event.target;
    if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) return;
    if (!NAVIGATION_KEYS.has(event.key)) return;
    if (event.key === "ArrowRight" || event.key === "PageDown" || event.key === " ") move(1);
    else move(-1);
    event.preventDefault();
  });

  window.addEventListener("beforeunload", stopPlaying, { once: true });
  render();
}

function frameModeShell(deckDefinition) {
  return `
    <div class="app-shell motion-shell">
      <header class="app-menu motion-menu">
        <div class="app-menu-brand">
          <h1 class="app-menu-title">${escapeHtml(deckDefinition.title)}</h1>
          <p class="app-menu-subtitle">Frame Mode · source-relative animation editor</p>
        </div>
        <div class="app-menu-actions">
          <a class="app-menu-link" href="/">All Decks</a>
          <a class="app-menu-link" href="/?deck=${encodeURIComponent(deckDefinition.id)}">Exit Motion</a>
        </div>
      </header>
      <main class="motion-workbench">
        <section class="motion-stage-section" aria-label="Current animation frame">
          <div class="motion-stage-heading">
            <div>
              <p class="motion-kicker" id="motion-source-title">Slide</p>
              <h2 id="motion-source-caption">Source slide</h2>
            </div>
            <p class="motion-analysis-status" id="motion-analysis-status"></p>
          </div>
          <div class="motion-stage" id="motion-stage"></div>
        </section>
        <section class="motion-workbench-panel" aria-label="Frame controls">
          <div class="motion-toolbar-row motion-primary-controls">
            <div class="motion-frame-readout" id="motion-current-label">Frame</div>
            <button class="motion-button motion-button-strong" id="motion-previous" type="button">Previous</button>
            <button class="motion-button motion-button-strong" id="motion-play" type="button">Play</button>
            <button class="motion-button motion-button-strong" id="motion-next" type="button">Next</button>
            <label class="motion-frame-name">Name <input id="motion-frame-name" aria-label="Frame name" /></label>
            <div class="motion-lens-group" aria-label="Frame inspection lens">
              <button class="motion-lens-button" data-motion-lens="audience" type="button">Audience</button>
              <button class="motion-lens-button" data-motion-lens="delta" type="button">Delta</button>
              <button class="motion-lens-button" data-motion-lens="onion" type="button">Onion</button>
              <button class="motion-lens-button" data-motion-lens="structure" type="button">Structure</button>
            </div>
          </div>
          <div class="motion-frame-rail" id="motion-frame-rail" aria-label="Animation frame rail"></div>
          <div class="motion-toolbar-row motion-edit-controls">
            <div class="motion-selection" id="motion-selection">Nothing selected</div>
            <button class="motion-button" id="motion-reveal-here" type="button">Reveal here</button>
            <button class="motion-button" id="motion-reveal-next" type="button">Reveal next</button>
            <button class="motion-button" id="motion-focus" type="button">Focus frame</button>
            <button class="motion-button" id="motion-clear-focus" type="button">Clear focus</button>
            <button class="motion-button" id="motion-split" type="button">Split group</button>
            <span class="motion-controls-divider" aria-hidden="true"></span>
            <button class="motion-button" id="motion-add" type="button">+ Frame</button>
            <button class="motion-button" id="motion-duplicate" type="button">Duplicate</button>
            <button class="motion-button" id="motion-merge" type="button">Merge</button>
            <button class="motion-button" id="motion-delete" type="button">Delete</button>
            <button class="motion-button motion-button-quiet" id="motion-regenerate" type="button">Regenerate</button>
          </div>
          <p class="motion-help">Click or shift-click groups on the canvas; drag empty space to lasso. Drag frame cards to reorder. Every frame is a view of one source slide.</p>
        </section>
      </main>
    </div>`;
}

function autoAnalyseSlide(markup, sourceIndex, fingerprint) {
  const section = parseSlide(markup);
  const canvas = section.querySelector(".slide-canvas");
  if (!canvas) return fallbackModel(sourceIndex, fingerprint);
  const titleNode = canvas.querySelector(".title");
  const title = titleNode ? [{ id: createId("unit-title"), path: pathFrom(canvas, titleNode), label: "Opening", role: "title" }] : [];
  const explicitUnits = collectExplicitMotionUnits(canvas, titleNode);
  if (explicitUnits.length) {
    const units = dedupeNestedUnits([...title, ...explicitUnits]);
    const opening = units.find(({ role }) => role === "title");
    const groups = [];
    const groupMap = new Map();
    units.filter(({ id }) => id !== opening?.id).forEach((unit) => {
      const groupId = unit.motionGroup || unit.id;
      if (!groupMap.has(groupId)) {
        const group = { id: groupId, label: unit.motionLabel || unit.label, units: [] };
        groupMap.set(groupId, group);
        groups.push(group);
      }
      groupMap.get(groupId).units.push(unit);
    });
    const frames = [];
    let visible = opening ? [opening.id] : [];
    if (opening) frames.push({ id: createId("frame"), label: opening.label, visible: [...visible], focus: [opening.id] });
    groups.forEach((group) => {
      const ids = group.units.map(({ id }) => id);
      visible = unique([...visible, ...ids]);
      frames.push({ id: createId("frame"), label: group.label, visible: [...visible], focus: ids });
    });
    const usableUnits = units.length ? units : [{ id: createId("unit-slide"), path: [], label: "Full slide", role: "body" }];
    if (!frames.length) frames.push({ id: createId("frame"), label: "Full view", visible: usableUnits.map(({ id }) => id), focus: [] });
    return { version: STORAGE_VERSION, sourceIndex, fingerprint, units: usableUnits, frames };
  }
  const bodyRoots = directBodyRoots(canvas, titleNode);
  const bodyUnits = bodyRoots.flatMap((root, rootIndex) => {
    const partition = findVisualPartition(root);
    const nodes = partition?.children?.length ? partition.children : [root];
    return nodes.map((node, index) => ({
      id: createId(`unit-${rootIndex + 1}-${index + 1}`),
      path: pathFrom(canvas, node),
      label: inferLabel(node, index + 1),
      role: "body",
    }));
  });
  const units = dedupeNestedUnits([...title, ...bodyUnits]);
  const usableUnits = units.length ? units : [{ id: createId("unit-slide"), path: [], label: "Full slide", role: "body" }];
  const opening = usableUnits.find(({ role }) => role === "title");
  const revealUnits = usableUnits.filter(({ id }) => id !== opening?.id);
  const frames = [];
  let visible = opening ? [opening.id] : [];
  if (opening) frames.push({ id: createId("frame"), label: opening.label, visible: [...visible], focus: [opening.id] });
  revealUnits.forEach((unit) => {
    visible = unique([...visible, unit.id]);
    frames.push({ id: createId("frame"), label: unit.label, visible: [...visible], focus: [unit.id] });
  });
  if (!frames.length) frames.push({ id: createId("frame"), label: "Full view", visible: usableUnits.map(({ id }) => id), focus: [] });
  const finalVisible = frames.at(-1).visible;
  const allIds = usableUnits.map(({ id }) => id);
  if (finalVisible.length !== allIds.length) {
    frames.push({ id: createId("frame"), label: "Full view", visible: allIds, focus: [] });
  }
  return { version: STORAGE_VERSION, sourceIndex, fingerprint, units: usableUnits, frames };
}

function collectExplicitMotionUnits(canvas, titleNode) {
  return Array.from(canvas.querySelectorAll("[data-motion-group]"))
    .filter((node) => node !== titleNode && !node.closest(".title") && !node.matches(".slide-page-number, .slide-note-source"))
    .map((node, index) => ({
      id: createId(`unit-explicit-${index + 1}`),
      path: pathFrom(canvas, node),
      label: node.dataset.motionLabel || inferLabel(node, index + 1),
      role: "body",
      motionGroup: node.dataset.motionGroup,
      motionLabel: node.dataset.motionLabel || prettifyClassName(node.dataset.motionGroup || ""),
    }));
}

function fallbackModel(sourceIndex, fingerprint) {
  const unitId = createId("unit-slide");
  return {
    version: STORAGE_VERSION,
    sourceIndex,
    fingerprint,
    units: [{ id: unitId, path: [], label: "Full slide", role: "body" }],
    frames: [{ id: createId("frame"), label: "Full view", visible: [unitId], focus: [] }],
  };
}

function directBodyRoots(canvas, titleNode) {
  const grid = Array.from(canvas.children).find((node) => node.classList?.contains("sl-grid"));
  const siblings = grid ? Array.from(grid.children) : Array.from(canvas.children);
  const roots = siblings.filter((node) => {
    if (!isMeaningfulElement(node) || node === titleNode || node.matches(".title, .slide-page-number, .slide-note-source")) return false;
    return !node.querySelector?.(".title") || !node.classList.contains("title");
  });
  return roots.length ? roots : [canvas];
}

function findVisualPartition(root) {
  const queue = [{ node: root, depth: 0 }];
  const candidates = [];
  while (queue.length) {
    const { node, depth } = queue.shift();
    if (depth > 4) continue;
    const children = substantialChildren(node);
    if (children.length >= 2 && children.length <= 7 && hasSpatialVariety(children)) {
      const ownText = directText(node);
      const score = children.length * 16 - depth * 5 - (ownText.length > 90 ? 12 : 0);
      candidates.push({ node, children, depth, score });
    }
    substantialChildren(node).forEach((child) => queue.push({ node: child, depth: depth + 1 }));
  }
  candidates.sort((left, right) => right.score - left.score || left.depth - right.depth);
  return candidates[0] || null;
}

function substantialChildren(node) {
  if (!node?.children) return [];
  return Array.from(node.children).filter((child) => {
    if (!isMeaningfulElement(child)) return false;
    if (child.matches(".slide-note-source, .slide-page-number, .sl-grid-overlay, script, style, defs, marker")) return false;
    const text = cleanText(child.textContent);
    const semanticGraphic = child.matches("svg, figure, img, table, canvas") || child.querySelector("svg, img, figure, table, canvas");
    return text.length > 0 || semanticGraphic || child.children.length > 0;
  });
}

function isMeaningfulElement(node) {
  return node?.nodeType === Node.ELEMENT_NODE && !["ASIDE", "SCRIPT", "STYLE", "TEMPLATE", "DEFS", "MARKER"].includes(node.tagName);
}

function hasSpatialVariety(children) {
  if (children.length < 2) return false;
  // Parsed source markup has no measurements. Class/semantic variation makes
  // the same decision stable before and after a visible canvas is mounted.
  const classes = new Set(children.map((child) => child.className?.baseVal || child.className || child.tagName));
  return classes.size > 1 || children.some((child) => /row|column|card|stage|perspective|category|item|step|frame/i.test(child.className || ""));
}

function dedupeNestedUnits(units) {
  const seen = new Set();
  return units.filter((unit) => {
    const signature = unit.path.join(".");
    if (seen.has(signature)) return false;
    seen.add(signature);
    return true;
  });
}

function inferLabel(node, fallbackIndex) {
  const aria = cleanText(node.getAttribute?.("aria-label"));
  if (aria) return truncate(aria, 38);
  const heading = node.querySelector?.("h1, h2, h3, h4, h5, h6");
  const headingText = cleanText(heading?.textContent);
  if (headingText) return truncate(headingText, 38);
  const direct = directText(node);
  if (direct) return truncate(direct, 38);
  const text = cleanText(node.textContent);
  if (text) return truncate(text, 38);
  const className = typeof node.className === "string" ? node.className : "";
  const namedClass = className.split(/\s+/).find((name) => !/^(ph|body|padded|sl-grid|sl-grid-cell|positioning-context)$/i.test(name));
  if (namedClass) return truncate(prettifyClassName(namedClass), 38);
  return `Visual group ${fallbackIndex}`;
}

function directText(node) {
  return cleanText(Array.from(node.childNodes)
    .filter((child) => child.nodeType === Node.TEXT_NODE || child.nodeType === Node.ELEMENT_NODE && /^(P|H[1-6]|SPAN|STRONG)$/i.test(child.tagName))
    .map((child) => child.textContent)
    .join(" "));
}

function renderStage(stage, markup, model, frameIndex, lens, selected) {
  const previous = model.frames[frameIndex - 1];
  const current = model.frames[frameIndex];
  const next = model.frames[frameIndex + 1];
  const layers = [];
  if (lens === "onion" && previous) layers.push(createCanvasLayer(markup, model, previous, "motion-layer motion-layer-previous motion-ghost"));
  if (lens === "onion" && next) layers.push(createCanvasLayer(markup, model, next, "motion-layer motion-layer-next motion-ghost"));
  const currentLayer = createCanvasLayer(markup, model, current, "motion-layer motion-layer-current", selected, lens);
  layers.push(currentLayer);
  stage.className = `motion-stage motion-stage-${lens}`;
  stage.innerHTML = `<div class="motion-stage-viewport"><div class="motion-stage-canvas">${layers.join("")}</div><div class="motion-lasso" aria-hidden="true"></div></div>`;
  const viewport = stage.querySelector(".motion-stage-viewport");
  const canvasStack = stage.querySelector(".motion-stage-canvas");
  const scale = Math.min(viewport.clientWidth / 960, viewport.clientHeight / 540);
  const safeScale = Math.max(0.01, scale);
  canvasStack.style.width = `${960 * safeScale}px`;
  canvasStack.style.height = `${540 * safeScale}px`;
  canvasStack.style.setProperty("--motion-scale", String(safeScale));
}

function createCanvasLayer(markup, model, frame, layerClass, selected = new Set(), lens = "audience") {
  const section = parseSlide(markup);
  const sourceSlide = section.querySelector("section");
  const canvas = section.querySelector(".slide-canvas");
  if (!canvas) return "";
  applyFrameState(canvas, model, frame, { selected, lens });
  section.querySelectorAll(".slide-page-number").forEach((pageNumber) => {
    pageNumber.textContent = sourceSlide?.dataset.slideNumber || "";
  });
  return `<div class="${layerClass}">${sourceSlide?.outerHTML || ""}</div>`;
}

function applyFrameState(canvas, model, frame, { selected = new Set(), lens = "audience" } = {}) {
  const visible = new Set(frame.visible);
  const previousFrame = null;
  model.units.forEach((unit, index) => {
    const node = nodeFromPath(canvas, unit.path);
    if (!node) return;
    node.dataset.motionUnit = unit.id;
    node.dataset.motionLabel = unit.label;
    node.classList.add("motion-unit");
    node.classList.toggle("motion-hidden", lens !== "structure" && !visible.has(unit.id));
    node.classList.toggle("motion-focus", frame.focus.includes(unit.id));
    node.classList.toggle("motion-selected", selected.has(unit.id));
    node.classList.toggle("motion-structure-unit", lens === "structure");
    node.style.setProperty("--motion-unit-index", String(index + 1));
  });
  if (lens === "delta") {
    const frameIndex = model.frames.findIndex(({ id }) => id === frame.id);
    const priorVisible = new Set(model.frames[Math.max(0, frameIndex - 1)]?.visible || []);
    model.units.forEach((unit) => {
      const node = nodeFromPath(canvas, unit.path);
      if (!node || !visible.has(unit.id)) return;
      node.classList.toggle("motion-new", !priorVisible.has(unit.id));
      node.classList.toggle("motion-dim", priorVisible.has(unit.id) && !frame.focus.includes(unit.id));
    });
  }
  void previousFrame;
}

function renderRail(rail, markup, model, currentIndex) {
  rail.innerHTML = model.frames.map((frame, index) => {
    const thumbnail = createCanvasLayer(markup, model, frame, "motion-thumb-canvas", new Set(), "audience");
    return `
      <button class="motion-frame-card${index === currentIndex ? " is-current" : ""}" type="button" draggable="true" data-frame-index="${index}" aria-label="Select frame ${index + 1}: ${escapeHtml(frame.label)}">
        <span class="motion-frame-card-number">${String(index + 1).padStart(2, "0")}</span>
        <span class="motion-frame-thumb">${thumbnail}</span>
        <span class="motion-frame-card-label">${escapeHtml(frame.label)}</span>
      </button>${index < model.frames.length - 1 ? '<span class="motion-frame-arrow" aria-hidden="true">→</span>' : ""}`;
  }).join("");
}

function bindCanvasSelection(stage, session, getModel, rerender) {
  let start = null;
  function primaryCanvas() {
    return stage.querySelector(".motion-layer-current .slide-canvas");
  }
  stage.addEventListener("pointerdown", (event) => {
    const unit = event.target.closest("[data-motion-unit]");
    if (unit) {
      const id = unit.dataset.motionUnit;
      if (event.shiftKey) {
        if (session.selected.has(id)) session.selected.delete(id);
        else session.selected.add(id);
      } else {
        session.selected = new Set([id]);
      }
      rerender();
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const canvas = primaryCanvas();
    if (!canvas) return;
    const bounds = canvas.getBoundingClientRect();
    start = { x: event.clientX, y: event.clientY, bounds, append: event.shiftKey };
    stage.setPointerCapture?.(event.pointerId);
    const lasso = stage.querySelector(".motion-lasso");
    lasso.classList.add("is-visible");
    lasso.style.left = `${event.clientX - bounds.left}px`;
    lasso.style.top = `${event.clientY - bounds.top}px`;
    lasso.style.width = "0px";
    lasso.style.height = "0px";
  });
  // Programmatic activation is useful for accessibility and for a canvas
  // element whose pointerdown is consumed by an embedded SVG or text node.
  stage.addEventListener("click", (event) => {
    const unit = event.target.closest("[data-motion-unit]");
    if (!unit || start) return;
    const id = unit.dataset.motionUnit;
    if (event.shiftKey) {
      if (session.selected.has(id)) session.selected.delete(id);
      else session.selected.add(id);
    } else {
      session.selected = new Set([id]);
    }
    rerender();
    event.preventDefault();
  });
  stage.addEventListener("pointermove", (event) => {
    if (!start) return;
    const lasso = stage.querySelector(".motion-lasso");
    const left = Math.min(start.x, event.clientX) - start.bounds.left;
    const top = Math.min(start.y, event.clientY) - start.bounds.top;
    lasso.style.left = `${left}px`;
    lasso.style.top = `${top}px`;
    lasso.style.width = `${Math.abs(event.clientX - start.x)}px`;
    lasso.style.height = `${Math.abs(event.clientY - start.y)}px`;
  });
  stage.addEventListener("pointerup", (event) => {
    if (!start) return;
    const left = Math.min(start.x, event.clientX);
    const right = Math.max(start.x, event.clientX);
    const top = Math.min(start.y, event.clientY);
    const bottom = Math.max(start.y, event.clientY);
    const lasso = stage.querySelector(".motion-lasso");
    lasso.classList.remove("is-visible");
    if (right - left > 5 && bottom - top > 5) {
      const found = Array.from(primaryCanvas()?.querySelectorAll("[data-motion-unit]") || [])
        .filter((node) => {
          const box = node.getBoundingClientRect();
          return box.right >= left && box.left <= right && box.bottom >= top && box.top <= bottom;
        })
        .map((node) => node.dataset.motionUnit);
      session.selected = new Set(start.append ? [...session.selected, ...found] : found);
      rerender();
    }
    start = null;
  });
}

function cloneFrame(frame, label) {
  return { id: createId("frame"), label, visible: [...frame.visible], focus: [...frame.focus] };
}

function normalizeFrame(frame) {
  return { ...frame, label: cleanText(frame.label) || "Untitled frame", visible: unique(frame.visible || []), focus: unique(frame.focus || []) };
}

function validateModel(model) {
  return Array.isArray(model.units) && model.units.length && Array.isArray(model.frames) && model.frames.length;
}

function loadStore(key) {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key));
    if (parsed?.version === STORAGE_VERSION && parsed.slides) return parsed;
  } catch (error) {
    console.warn("[lattice] could not read Frame Mode state", error);
  }
  return { version: STORAGE_VERSION, slides: {} };
}

function saveStore(key, value) {
  window.localStorage.setItem(key, JSON.stringify(value));
}

function parseSlide(markup) {
  const template = document.createElement("template");
  template.innerHTML = markup.trim();
  // buildSlides() returns the section itself. Returning a synthetic wrapper
  // lets every caller consistently query `.slide-canvas` and retains the
  // original section when it is serialized into a layer or thumbnail.
  const wrapper = document.createElement("div");
  const section = template.content.firstElementChild;
  if (section) wrapper.append(section);
  return wrapper;
}

function pathFrom(root, node) {
  if (root === node) return [];
  const path = [];
  let cursor = node;
  while (cursor && cursor !== root) {
    const parent = cursor.parentElement;
    if (!parent) return [];
    path.unshift(Array.from(parent.children).indexOf(cursor));
    cursor = parent;
  }
  return path;
}

function nodeFromPath(root, path) {
  return path.reduce((node, index) => node?.children?.[index] || null, root);
}

function selectionSummary(model, selection) {
  if (!selection.size) return "Nothing selected";
  const labels = model.units.filter(({ id }) => selection.has(id)).map(({ label }) => label);
  return labels.length === 1 ? `Selected: ${labels[0]}` : `${labels.length} groups selected`;
}

function normalizeMarkup(markup) {
  return markup.replace(/\s+/g, " ").replace(/data-slide-number="\d+"/g, "").trim();
}

function hashString(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function truncate(value, length) {
  return value.length > length ? `${value.slice(0, Math.max(0, length - 1)).trimEnd()}…` : value;
}

function prettifyClassName(value) {
  return value.replace(/[-_]/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function unique(values) {
  return [...new Set(values)];
}

function createId(prefix) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}`;
}

function clampInt(value, min, max) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : min;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}
