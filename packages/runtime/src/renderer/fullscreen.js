import { SLIDE_CANVAS } from "../grid/index.js";

export function installFullscreenFit({
  reveal = document.querySelector(".reveal"),
  width = SLIDE_CANVAS.width,
  height = SLIDE_CANVAS.height,
} = {}) {
  const slides = reveal?.querySelector(".slides");
  if (!reveal || !slides) return { fit: () => {}, destroy: () => {} };

  const fit = () => {
    if (document.fullscreenElement !== reveal) return;
    const scale = Math.min(reveal.clientWidth / width, reveal.clientHeight / height);
    const matrix = new DOMMatrixReadOnly(getComputedStyle(slides).transform);
    if (Math.abs(matrix.a - scale) < 0.0001) return;
    slides.style.width = `${width}px`;
    slides.style.height = `${height}px`;
    slides.style.left = "50%";
    slides.style.top = "50%";
    slides.style.right = "auto";
    slides.style.bottom = "auto";
    slides.style.zoom = "";
    slides.style.transform = `translate(-50%, -50%) scale(${scale})`;
  };
  const schedule = () => {
    [0, 60, 180].forEach((delay) => window.setTimeout(() => {
      if (!document.fullscreenElement) return;
      window.dispatchEvent(new Event("resize"));
      fit();
    }, delay));
  };
  const onFullscreen = () => {
    if (document.fullscreenElement === reveal) schedule();
    else requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  };
  const onResize = () => {
    if (document.fullscreenElement === reveal) requestAnimationFrame(fit);
  };
  let queued = false;
  const observer = new MutationObserver(() => {
    if (queued || document.fullscreenElement !== reveal) return;
    queued = true;
    requestAnimationFrame(() => {
      queued = false;
      fit();
    });
  });
  observer.observe(slides, { attributes: true, attributeFilter: ["style"] });
  document.addEventListener("fullscreenchange", onFullscreen);
  window.addEventListener("resize", onResize);
  return {
    fit: schedule,
    destroy() {
      observer.disconnect();
      document.removeEventListener("fullscreenchange", onFullscreen);
      window.removeEventListener("resize", onResize);
    },
  };
}
