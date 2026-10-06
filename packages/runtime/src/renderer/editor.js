import { SLIDE_CANVAS.width } from "../grid/index.js";

export function initSlideEditor(rootElement, deckId) {
  const storageKey = `slides-editor-edits:${deckId}`;
  const editableSelector = [
    ".ph",
    ".slide-textbox",
    ".runtime-ppt-text",
  ].join(",");
  let state = JSON.parse(localStorage.getItem(storageKey) || '{"items":{}}');
  let selectedElement = null;
  let interaction = null;

  function saveState() {
    localStorage.setItem(storageKey, JSON.stringify(state, null, 2));
  }

  function getSlideId(slide) {
    return slide?.dataset.slideNumber || String(Array.from(rootElement.querySelectorAll("section")).indexOf(slide));
  }

  function getEditableId(element) {
    if (element.dataset.editorId) return element.dataset.editorId;
    const slide = element.closest("section");
    const slideId = getSlideId(slide);
    const editables = getEditableElements(slide);
    const index = editables.indexOf(element);
    element.dataset.editorId = `${slideId}:existing:${index}`;
    return element.dataset.editorId;
  }

  function getEditableElements(scope = rootElement) {
    return Array.from(scope.querySelectorAll(editableSelector)).filter((element) => {
      if (element.closest(".slide-note-source")) return false;
      if (element.classList.contains("slide-page-number")) return false;
      if (element.classList.contains("slide-footnote")) return false;
      if (element.closest(".slide-editor-handle")) return false;
      if (element.classList.contains("ph") && element.querySelector("img, svg, canvas, .runtime-digital-stack, .interactive-trend-chart")) {
        return false;
      }
      return element.closest("section");
    });
  }

  function getScale(slide) {
    const rect = slide.getBoundingClientRect();
    return rect.width ? rect.width / SLIDE_CANVAS.width : 1;
  }

  function readBox(element) {
    const slide = element.closest("section");
    const slideRect = slide.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    const scale = getScale(slide);
    return {
      x: (rect.left - slideRect.left) / scale,
      y: (rect.top - slideRect.top) / scale,
      w: rect.width / scale,
      h: rect.height / scale,
    };
  }

  function writeBox(element, box) {
    element.style.left = `${Math.round(box.x)}px`;
    element.style.top = `${Math.round(box.y)}px`;
    element.style.width = `${Math.round(box.w)}px`;
    element.style.height = `${Math.round(box.h)}px`;
    element.style.position = "absolute";
  }

  function serializeEditableHtml(element) {
    const clone = element.cloneNode(true);
    clone.querySelectorAll(".slide-editor-handle").forEach((handle) => handle.remove());
    return clone.innerHTML;
  }

  function serializeClassName(element) {
    return Array.from(element.classList)
      .filter((className) => !className.startsWith("slide-editor-"))
      .join(" ");
  }

  function persistElement(element) {
    const id = getEditableId(element);
    const slide = element.closest("section");
    state.items[id] = {
      slide: getSlideId(slide),
      kind: element.dataset.editorCreated === "1" ? "created" : "existing",
      className: element.dataset.editorClassName || serializeClassName(element),
      html: serializeEditableHtml(element),
      box: readBox(element),
    };
    saveState();
  }

  function applySavedState() {
    getEditableElements().forEach((element) => {
      const id = getEditableId(element);
      const saved = state.items[id];
      if (!saved) return;
      element.innerHTML = saved.html;
      writeBox(element, saved.box);
    });

    Object.entries(state.items)
      .filter(([, item]) => item.kind === "created")
      .forEach(([id, item]) => {
        if (rootElement.querySelector(`[data-editor-id="${CSS.escape(id)}"]`)) return;
        const slide = Array.from(rootElement.querySelectorAll("section")).find((candidate) => getSlideId(candidate) === item.slide);
        if (!slide) return;
        const element = document.createElement("div");
        element.className = item.className || "slide-textbox slide-editor-created-textbox";
        element.dataset.editorId = id;
        element.dataset.editorCreated = "1";
        element.dataset.editorClassName = element.className;
        element.innerHTML = item.html || "<p>New text</p>";
        writeBox(element, item.box);
        slide.appendChild(element);
      });
  }

  function selectElement(element) {
    if (selectedElement === element) return;
    selectedElement?.classList.remove("slide-editor-selected");
    selectedElement = element;
    selectedElement.classList.add("slide-editor-selected");
  }

  function prepareElement(element) {
    if (element.dataset.editorReady === "1") return;
    element.dataset.editorReady = "1";
    element.setAttribute("contenteditable", "true");
    element.setAttribute("spellcheck", "false");
    element.classList.add("slide-editor-editable");

    const moveHandle = document.createElement("span");
    moveHandle.className = "slide-editor-handle slide-editor-move";
    moveHandle.textContent = "move";
    moveHandle.setAttribute("contenteditable", "false");
    element.appendChild(moveHandle);

    const resizeHandle = document.createElement("span");
    resizeHandle.className = "slide-editor-handle slide-editor-resize";
    resizeHandle.setAttribute("contenteditable", "false");
    element.appendChild(resizeHandle);

    element.addEventListener("focusin", () => selectElement(element));
    element.addEventListener("input", () => persistElement(element));

    moveHandle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      selectElement(element);
      const box = readBox(element);
      interaction = {
        type: "move",
        element,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        box,
      };
      moveHandle.setPointerCapture(event.pointerId);
    });

    resizeHandle.addEventListener("pointerdown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      selectElement(element);
      const box = readBox(element);
      interaction = {
        type: "resize",
        element,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        box,
      };
      resizeHandle.setPointerCapture(event.pointerId);
    });
  }

  function prepareAll() {
    getEditableElements().forEach(prepareElement);
  }

  rootElement.addEventListener("pointermove", (event) => {
    if (!interaction) return;
    const slide = interaction.element.closest("section");
    const scale = getScale(slide);
    const dx = (event.clientX - interaction.startX) / scale;
    const dy = (event.clientY - interaction.startY) / scale;
    if (interaction.type === "move") {
      writeBox(interaction.element, {
        ...interaction.box,
        x: interaction.box.x + dx,
        y: interaction.box.y + dy,
      });
    } else {
      writeBox(interaction.element, {
        ...interaction.box,
        w: Math.max(48, interaction.box.w + dx),
        h: Math.max(28, interaction.box.h + dy),
      });
    }
  });

  function endInteraction() {
    if (!interaction) return;
    persistElement(interaction.element);
    interaction = null;
  }

  rootElement.addEventListener("pointerup", endInteraction);
  rootElement.addEventListener("pointercancel", endInteraction);

  window.addEventListener("slide-editor:add-text", () => {
    const slide = document.querySelector(".reveal .slides section.present") || rootElement.querySelector("section");
    if (!slide) return;
    const id = `${getSlideId(slide)}:created:${Date.now()}`;
    const element = document.createElement("div");
    element.className = "slide-textbox slide-editor-created-textbox";
    element.dataset.editorId = id;
    element.dataset.editorCreated = "1";
    element.dataset.editorClassName = element.className;
    element.innerHTML = "<p>New text</p>";
    writeBox(element, { x: 80, y: 160, w: 260, h: 82 });
    slide.appendChild(element);
    prepareElement(element);
    selectElement(element);
    persistElement(element);
    element.focus();
  });

  window.addEventListener("slide-editor:export", () => {
    saveState();
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = `${deckId}-slide-edits.json`;
    link.click();
    URL.revokeObjectURL(link.href);
  });

  window.addEventListener("slide-editor:clear", () => {
    if (!confirm("Clear local slide editor changes for this deck?")) return;
    localStorage.removeItem(storageKey);
    window.location.reload();
  });

  applySavedState();
  prepareAll();
}

