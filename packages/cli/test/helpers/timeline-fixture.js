// Shared M7 timeline fixture: a real lattice.deck.v2 project written into a
// gitignored tmp directory at test time. The deck declares a
// lattice.timeline.v1 (segment durations, stop frames, animation presets,
// audio track) whose slides carry data-lattice-reveal markers, so every M7
// surface — plan compile, hosts, edit loop, workbench, presentation — can be
// exercised end to end without touching any frozen business deck.

import { mkdirSync, writeFileSync, copyFileSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export const TIMELINE_DECK_ID = "timeline-demo";

export const TIMELINE_MANIFEST = {
  schema: "lattice.deck.v2",
  id: TIMELINE_DECK_ID,
  title: "Timeline Demo Deck",
  owner: "lattice",
  presenter: "Lattice",
  runtime: "^0.2.0",
  theme: "simple-light",
  canvas: { width: 960, height: 540 },
  fps: 30,
  entry: {
    slides: "./slides.v2.js",
    content: "./content.js",
    notes: "./notes.js",
  },
  publication: { audience: "private" },
  routes: { main: ["intro", "reveal", "outro"] },
  assets: "./assets/",
  timeline: {
    schema: "lattice.timeline.v1",
    rhythm: { first: 10, dwell: 30 },
    defaults: { animation: { preset: "fade", durationFrames: 10, stagger: 0 } },
    slides: {
      intro: {
        durationFrames: 90,
        stops: { open: { frame: 0 }, point: { frame: 40 } },
        animation: { preset: "rise", direction: "up", durationFrames: 12, stagger: 3, distancePx: 24 },
      },
      reveal: {
        durationFrames: 100,
        stops: { base: { frame: 0 }, "step-1": { frame: 40 }, "step-2": { frame: 70 } },
        animation: { preset: "fade", durationFrames: 10, stagger: 0 },
      },
    },
    audioTracks: [
      { id: "bgm", src: "./assets/audio/tone.wav", startFrame: 0, volume: 0.8 },
    ],
  },
};

const canvas = (id, inner) =>
  `<section class="slide-canvas" data-lattice-id="${id}" ` +
  `style="position:relative;width:960px;height:540px;background:#ffffff;overflow:hidden">` +
  `${inner}</section>`;

const box = (stopId, label, left, top, color) =>
  `<div data-lattice-reveal="${stopId}" style="position:absolute;left:${left}px;top:${top}px;` +
  `width:240px;height:120px;background:${color};font-family:Arial,sans-serif;font-size:22px;` +
  `color:#ffffff;display:flex;align-items:center;justify-content:center">${label}</div>`;

export function writeTimelineDeck(projectRoot, { manifestOverrides = {} } = {}) {
  const deckDir = path.join(projectRoot, "decks", TIMELINE_DECK_ID);
  mkdirSync(path.join(deckDir, "assets", "audio"), { recursive: true });

  const manifest = { ...structuredClone(TIMELINE_MANIFEST), ...manifestOverrides };
  manifest.timeline = { ...structuredClone(TIMELINE_MANIFEST.timeline), ...(manifestOverrides.timeline ?? {}) };
  writeFileSync(path.join(deckDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  writeFileSync(
    path.join(deckDir, "slides.v2.js"),
    `export const slideDefinitions = [
  {
    id: "intro",
    html: ${JSON.stringify(canvas("intro", `<h1 style="position:absolute;left:80px;top:80px;margin:0;font-family:Arial,sans-serif;font-size:40px;color:#111111">Intro</h1>${box("point", "The point", 120, 240, "#2f6b55")}`))},
    durationFrames: 90,
    stops: [{ id: "open", frame: 0 }, { id: "point", frame: 1 }],
  },
  {
    id: "reveal",
    html: ${JSON.stringify(canvas("reveal", `<h2 style="position:absolute;left:80px;top:60px;margin:0;font-family:Arial,sans-serif;font-size:30px;color:#111111">Reveal</h2>${box("step-1", "Step 1", 100, 200, "#2f6b55")}${box("step-2", "Step 2", 420, 200, "#c46b35")}`))},
    durationFrames: 100,
    stops: [{ id: "base", frame: 0 }, { id: "step-1", frame: 1 }, { id: "step-2", frame: 2 }],
  },
  {
    id: "outro",
    html: ${JSON.stringify(canvas("outro", `<h2 style="position:absolute;left:80px;top:80px;margin:0;font-family:Arial,sans-serif;font-size:34px;color:#111111">Outro</h2>`))},
    durationFrames: 30,
    stops: [{ id: "static", frame: 0 }],
  },
];
`,
    "utf8",
  );

  writeFileSync(
    path.join(deckDir, "content.js"),
    `export default {
  intro: { id: "intro", title: "Intro", headline: "Intro" },
  reveal: { id: "reveal", title: "Reveal", steps: ["Step 1", "Step 2"] },
  outro: { id: "outro", title: "Outro" },
};
`,
    "utf8",
  );

  writeFileSync(path.join(deckDir, "notes.js"), `export default { intro: "", reveal: "", outro: "" };\n`, "utf8");

  writeAudioFixture(path.join(deckDir, "assets", "audio", "tone.wav"));
  return deckDir;
}

export function writeProjectConfig(projectRoot) {
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(
    path.join(projectRoot, "lattice.config.js"),
    `export default {
  title: "M7 Timeline Fixtures",
  decksDir: "decks",
  outDir: "dist",
  registry: "./decks/registry.js",
  theme: "simple-light",
  dev: { port: 0, host: "127.0.0.1" },
};
`,
    "utf8",
  );
}

export function writeDeckRegistry(projectRoot) {
  const decksDir = path.join(projectRoot, "decks");
  mkdirSync(decksDir, { recursive: true });
  writeFileSync(
    path.join(decksDir, "registry.js"),
    `import { slideDefinitions } from "./${TIMELINE_DECK_ID}/slides.v2.js";

export const deckRegistry = {
  "${TIMELINE_DECK_ID}": {
    id: "${TIMELINE_DECK_ID}",
    title: "Timeline Demo Deck",
    owner: "lattice",
    presenter: "Lattice",
    description: "M7 unified timeline fixture deck",
    buildSlides: () =>
      slideDefinitions.map((slide) => (typeof slide.html === "function" ? slide.html() : slide.html)),
  },
};

export const deckList = Object.values(deckRegistry);
`,
    "utf8",
  );
}

/** Minimal deterministic PCM WAV (2 s, 440 Hz sine at moderate amplitude). */
export function writeAudioFixture(filePath, { seconds = 2, sampleRate = 22050, frequency = 440 } = {}) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  const sampleCount = seconds * sampleRate;
  const dataSize = sampleCount * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < sampleCount; index += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * frequency * index) / sampleRate) * 12000);
    buffer.writeInt16LE(value, 44 + index * 2);
  }
  writeFileSync(filePath, buffer);
}

/** Deterministic tree hash (deck sources), same scheme as plan provenance. */
export function hashTree(rootDir) {
  const files = [];
  const walk = (dir, relPrefix) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = relPrefix === "" ? entry.name : `${relPrefix}/${entry.name}`;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full, rel);
      else if (entry.isFile()) files.push({ rel, full });
    }
  };
  walk(rootDir, "");
  files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  const hash = createHash("sha256");
  for (const { rel, full } of files) {
    hash.update(rel);
    hash.update("\0");
    hash.update(readFileSync(full));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function copyFixture(from, to) {
  mkdirSync(path.dirname(to), { recursive: true });
  copyFileSync(from, to);
}
