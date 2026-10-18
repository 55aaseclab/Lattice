export function createPdfExportUrl({
  location = window.location,
  deckId,
  deckParam = "deck",
} = {}) {
  const url = new URL(location.href);
  if (deckId) url.searchParams.set(deckParam, deckId);
  url.searchParams.set("export", "pdf-renderer");
  url.searchParams.set("print-pdf", "1");
  ["motion", "presenter", "edit", "grid", "source", "frame", "lens"].forEach((key) => {
    url.searchParams.delete(key);
  });
  return `${url.pathname}${url.search}`;
}

export function exportDeckAsPdf(exportLocation, {
  root = document,
  targetWindow = window,
} = {}) {
  root.querySelector("#pdf-export-frame")?.remove();
  const exportToken = targetWindow.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  const frameUrl = new URL(exportLocation, targetWindow.location.origin);
  frameUrl.searchParams.set("export-token", exportToken);
  const frame = root.createElement("iframe");
  frame.id = "pdf-export-frame";
  frame.title = "PDF export renderer";
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;

  let printRequested = false;
  const cleanup = () => {
    targetWindow.removeEventListener("message", onRendererMessage);
    targetWindow.setTimeout(() => frame.remove(), 0);
  };
  const onRendererMessage = (event) => {
    if (event.origin !== targetWindow.location.origin || event.source !== frame.contentWindow) return;
    const message = event.data;
    if (message?.type !== "lattice:pdf-ready" || message.token !== exportToken || printRequested) return;
    printRequested = true;
    frame.contentWindow?.addEventListener("afterprint", cleanup, { once: true });
    targetWindow.setTimeout(() => {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    }, 80);
  };
  targetWindow.addEventListener("message", onRendererMessage);
  frame.src = `${frameUrl.pathname}${frameUrl.search}`;
  root.body.append(frame);
  return { frame, cleanup };
}

export function installPdfExportRenderer({
  reveal = document.querySelector(".reveal"),
  location = window.location,
  targetWindow = window,
} = {}) {
  if (!reveal) return false;
  const token = new URL(location.href).searchParams.get("export-token");
  reveal.addEventListener("pdf-ready", () => {
    document.documentElement.dataset.pdfExportReady = "true";
    if (targetWindow.parent !== targetWindow && token) {
      targetWindow.parent.postMessage({ type: "lattice:pdf-ready", token }, targetWindow.location.origin);
    } else {
      targetWindow.setTimeout(() => targetWindow.print(), 80);
    }
  }, { once: true });
  return true;
}
