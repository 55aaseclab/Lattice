# @lattice/cli

Command-line interface for Lattice native slide projects. The CLI only orchestrates: it loads the config and decks, then calls `@lattice/runtime` for validation and rendering.

```text
CLI command
    ↓
load config / load deck
    ↓
call @lattice/runtime
    ↓
dev / validate / build / export
```

## Install

```sh
npm install @lattice/cli
```

Or run it ad hoc:

```sh
npx @lattice/cli init my-slides
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
└── public/decks/demo/assets/
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

Validate deck manifests, entry files, content bindings, grid placements, overlaps, assets, themes, and runtime compatibility.

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

The output can be hosted by any static server, copied into an Astro `public/`, or published to a GitHub Pages subpath — all asset URLs are relative to the deck directory.

### `lattice preview`

Preview the built `dist/` output.
