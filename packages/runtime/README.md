# @55aaseclab/lattice-runtime

The Lattice slide runtime. It defines how slides are created, laid out, validated, rendered, and exported. It does not contain business content, CLI argument parsing, or PPTX import/conversion.

```text
slides business project
        ↓ package import
@55aaseclab/lattice-cli + @55aaseclab/lattice-runtime
        ↓
Reveal.js + HTML/CSS
```

## Layers

```text
canvas
  ↓
grid
  ↓
area / placement
  ↓
layout primitive
  ↓
theme
  ↓
deck content
```

- `src/grid`: 960×540 (or configurable) canvas, columns/rows, tracks, gap, margin, padding, named areas, spans, nested grids, deterministic placement-to-pixel math, and the debug overlay renderer.
- `src/layout`: layout IR (`layoutGrids`, `blueprintGrid`), semantic slot assembler with injectable theme classes.
- `src/primitives`: `createPrimitives` factory — textbox, group, positioned, grid, gridCell with `fit` and nested-grid support.
- `src/renderer`: HTML/CSS renderers, deck app and presenter views, interactive chart initializers, slide editor, and the static single-deck bootstrap.
- `src/validator`: out-of-bounds, overlap, illegal placement, and missing-asset checks.
- `src/deck`: standard deck package schema (`lattice.deck.v1`), runtime compatibility checks, and deck package loading.
- `themes/simple-light`: typography, colors, borders, default spacing tokens, and semantic slot visuals built on the grid.

## Usage

Business code must import through the package exports:

```js
import { createDeck, createGrid, defineGrid } from "@55aaseclab/lattice-runtime";
import { simpleLightLayouts } from "@55aaseclab/lattice-runtime/themes/simple-light";
import { renderDeckApp, renderPresenterApp, bootStaticDeck } from "@55aaseclab/lattice-runtime/renderer";
```

Incorrect:

```js
import { defineGrid } from "../third_party/lattice/packages/runtime/src/grid/internal.js";
```

## Standard deck package

```text
decks/<deck-id>/
├── manifest.json
├── content.js
├── layout.js
├── notes.js
└── assets/
```

See `examples/demo-deck` for a minimal example. The runtime loads the manifest, checks `schema` and `runtime` compatibility, and imports the declared entries.

## Development

```sh
npm install
npm test
```
