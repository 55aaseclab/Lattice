// Conformance deck slide definitions (lattice.deck.v2).
//
// Design constraints for backend conformance rendering (A26–A29):
// - fully deterministic: no Date.now(), no unseeded randomness, no wall-clock;
// - controlled resources: one deck-owned local SVG asset, no remote requests,
//   system font stacks only (no webfonts);
// - visible state is a pure function of the frame: the progress slide derives
//   its geometry from the canonical runtime frame variables
//   (--lattice-local-frame / --lattice-duration-frames) with plain CSS calc(),
//   so any backend that applies the canonical frame state renders identical
//   pixels for the same integer frame;
// - all positioning is inline so the markup stays independent of theme CSS
//   while still rendering inside the canonical .slide-canvas surface.

const canvasSection = (id, inner) =>
  `<section class="slide-canvas" data-lattice-id="${id}" ` +
  `style="position:relative;width:960px;height:540px;background:#ffffff;overflow:hidden">` +
  `${inner}</section>`;

const fontStack = "font-family:Arial,Helvetica,sans-serif;";

const introHtml = canvasSection(
  "intro",
  `<div style="position:absolute;left:80px;top:180px;width:800px;${fontStack}">` +
    `<h1 style="margin:0;font-size:44px;line-height:1.25;color:#111111">Conformance Deck Intro</h1>` +
    `<p style="margin:16px 0 0;font-size:20px;color:#444444">Lattice Remotion backend fixture</p>` +
    `</div>` +
    `<div style="position:absolute;left:80px;top:420px;width:800px;height:8px;background:#2f6b55"></div>`,
);

const progressHtml = canvasSection(
  "progress",
  `<div style="position:absolute;left:80px;top:110px;width:800px;${fontStack}">` +
    `<h2 style="margin:0;font-size:32px;color:#111111">Frame-driven progress</h2>` +
    `</div>` +
    `<div style="position:absolute;left:80px;top:250px;width:800px;height:40px;background:#eeeeee;border:1px solid #dcdcdc;box-sizing:border-box">` +
    `<div style="width:calc(var(--lattice-local-frame) / var(--lattice-duration-frames) * 100%);height:100%;background:#2f6b55"></div>` +
    `</div>` +
    `<div style="position:absolute;left:80px;top:320px;height:6px;background:#c46b35;width:calc(var(--lattice-local-frame) / var(--lattice-duration-frames) * 800px)"></div>`,
);

const assetHtml = canvasSection(
  "asset",
  `<div style="position:absolute;left:80px;top:90px;width:800px;${fontStack}">` +
    `<h2 style="margin:0;font-size:32px;color:#111111">Bundled asset</h2>` +
    `</div>` +
    `<div style="position:absolute;left:80px;top:170px;width:800px;height:280px;background:#ffffff">` +
    `<img src="./assets/lattice-conformance.svg" alt="lattice conformance grid" width="800" height="280" style="display:block;object-fit:contain">` +
    `</div>` +
    `<div style="position:absolute;left:80px;top:470px;width:800px;${fontStack}">` +
    `<p style="margin:0;font-size:16px;color:#666666">Figure 1 · deterministic conformance grid</p>` +
    `</div>`,
);

export const slideDefinitions = [
  {
    id: "intro",
    html: introHtml,
    durationFrames: 30,
    stops: [{ id: "open", frame: 0 }],
  },
  {
    id: "progress",
    html: progressHtml,
    durationFrames: 45,
    stops: [{ id: "static", frame: 0 }],
  },
  {
    id: "asset",
    html: assetHtml,
    durationFrames: 15,
    stops: [{ id: "static", frame: 0 }],
  },
];
