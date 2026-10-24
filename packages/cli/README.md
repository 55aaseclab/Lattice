# @55aaseclab/lattice-cli

Command-line interface for Lattice native slide projects. The CLI only orchestrates: it loads the config and decks, then calls `@55aaseclab/lattice-runtime` for validation and rendering.

```text
CLI command
    ↓
load config / load deck
    ↓
call @55aaseclab/lattice-runtime
    ↓
dev / validate / build / export
```

## Install

```sh
npm install @55aaseclab/lattice-cli
```

Or run it ad hoc:

```sh
npx @55aaseclab/lattice-cli init my-slides
```

## Commands

### `lattice init <dir>`

Initialize a business slide project:

```sh
lattice init my-slides
lattice init my-slides --theme simple-light
lattice init my-slides --example image-text
lattice init my-slides --no-install
```

The generated project starts immediately and contains a minimal demo deck:

```text
my-slides/
├── package.json
├── lattice.config.js
├── index.html
├── src/main.js
├── decks/
│   ├── registry.js
│   └── demo/
│       ├── manifest.json
│       ├── content.js
│       ├── layout.js
│       ├── notes.js
│       └── slides.js
        ├── assets/
        └── references/
```

### `lattice dev`

Start the Vite dev server for the current project:

```sh
lattice dev
lattice dev --port 4666
lattice dev --deck demo
lattice dev --deck demo --grid
```

### `lattice validate`

Validate deck manifests, entry files, content bindings, grid placements, overlaps, assets, themes, and runtime compatibility. Browser-only overflow, density, and contrast checks run from a rendered deck with `?inspect=1` and publish a `lattice:inspection` report.

### `lattice inspect --rendered`

Launch headless Chromium, render each deck with `?inspect=1`, and wait for the explicit app-ready signal (`window.__latticeInspection`) — which the runtime publishes only after `document.fonts.ready` and every image has finished loading and decoding (`HTMLImageElement.decode()`, with a `complete`/`naturalWidth` fallback for environments without `decode`) — before collecting overflow/contrast/density findings:

```sh
lattice inspect --rendered                      # every deck in decks/
lattice inspect --rendered --deck demo
lattice inspect --rendered --out lattice-inspection.json
lattice inspect --rendered --base-url http://localhost:4666   # reuse a running server
lattice inspect --rendered --browser /path/to/chromium --timeout 15000
lattice inspect --deck demo                     # compatibility alias
```

`--rendered` is the canonical spelling (PRD 3.1.4); bare `lattice inspect` is a documented compatibility alias, and unknown options fail with exit code 2.

The JSON report (schema `lattice.inspection.v1`) is written to stdout and, with `--out`, to a file. Findings carry `type`/`slide`/`area`/`element`/`message` plus browser console and page errors, ready-timeout (`ready-timeout`), failed image decode (`missing-asset`), and per-deck navigation failures (`navigation-failed`). Exit codes: `0` clean, `1` blocking findings, `2` infrastructure failure (e.g. no Chromium found).

Before measuring, the command prewarms each deck's real module graph using a dedicated Vite dependency cache (`node_modules/.vite-lattice-inspect`), so cold starts or concurrent dev/validate servers re-optimizing the shared cache ("Outdated Optimize Dep" HTTP 504 races) cannot surface as false ready-timeouts. The prewarm pass is best-effort and only retries on observed optimized-dep 504s; the measurement pass is single-shot and keeps strict blocking semantics.

Blocking finding classes: rendered inspection errors (overflow/contrast/density), `ready-timeout`, `missing-asset`, `navigation-failed`, and uncaught page errors (`page-error` — a deck that publishes a clean report and then throws still fails). Ordinary `console.error` noise is recorded in `consoleErrors` as diagnostics only and never blocks. Chromium is resolved from `--browser`, `LATTICE_CHROMIUM`, the local Playwright browser cache, or a system Chrome/Chromium install.

### `lattice screenshot`

Capture canonical per-slide screenshots through the same headless Vite + Chromium path as `lattice inspect --rendered`, and compare them against explicitly managed baselines:

```sh
lattice screenshot                                  # compare every deck against baselines
lattice screenshot --deck demo
lattice screenshot --update-baseline                # explicitly create/update canonical baselines
lattice screenshot --baseline-dir baselines --out evidence --report report.json
lattice screenshot --max-diff-ratio 0.001           # tolerance as a pixel fraction (default 0)
```

Every slide is captured at a fixed viewport (1280x720, DPR 1) after the same app-ready/fonts/images readiness contract as rendered inspection; slide files derive from the stable slide address (never timing or port). The versioned JSON report (`lattice.screenshots.v1`) goes to stdout and, with `--report`, to a file; per-slide entries carry `baseline`/`actual`/`diff` paths and diff metrics. Finding classes: `visual-regression` (pixel diff above `--max-diff-ratio`, with `diffRatio`/`diffPixels` and retained actual/diff artifact paths, compared with pixelmatch), `missing-baseline`, and `capture-failed`. Exit codes: `0` clean, `1` visual-regression or missing-baseline findings, `2` infrastructure or CLI failure (including `capture-failed`, which wins over exit 1 when both occur). Baselines are written only in `--update-baseline` mode — comparison never rewrites them; same-environment repeat runs must diff 0.

### `lattice build`

Build the business project portal to `dist/` with a relative base.

### `lattice export --deck <id>`

Package a single deck as a self-contained static directory:

```sh
lattice export --deck demo --out dist/demo
```

Output:

```text
dist/demo/
├── index.html
├── manifest.json
├── content.json
├── layout.json
├── notes.json
└── assets/
```

The output can be hosted by any static server, copied into an Astro `public/`, or published to a GitHub Pages subpath — all asset URLs are relative to the deck directory. The selected theme package's palettes and default palette are bundled into the static deck, using the same Theme menu and `?theme=<palette-id>` selection as the portal.

### `lattice preview`

Preview the built `dist/` output.
