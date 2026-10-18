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
- `src/primitives`: `createPrimitives` factory — textbox, group, table, image, positioned, grid, and gridCell with `fit` and nested-grid support.
- `src/renderer`: portal, deck/presenter views, Frame Mode, theme controller, fullscreen fitting, PDF/PPTX export, interactive chart initializers, slide editor, and the static single-deck bootstrap.
- `src/validator` and `src/inspect`: stable `type/slide/area/element/message` issues for structural checks plus browser-rendered overflow, density, and contrast checks.
- `src/deck`: standard deck package schema (`lattice.deck.v1`), runtime compatibility checks, and deck package loading.
- `themes/simple-light`: typography, colors, borders, default spacing tokens, and semantic slot visuals built on the grid.

## Usage

Business code must import through the package exports:

```js
import { createDeck, createGrid, defineGrid } from "@55aaseclab/lattice-runtime";
import {
  defaultPalette,
  palettes,
  simpleLightLayouts,
} from "@55aaseclab/lattice-runtime/themes/simple-light";
import { bootDeckPortal, bootStaticDeck } from "@55aaseclab/lattice-runtime/renderer";
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

Deck manifests declare non-empty `owner` and `presenter` strings. Image and grid-cell fit modes use the shared `slide-fit-contain`, `slide-fit-cover`, and `slide-fit-stretch` theme classes, so the grid continues to own placement while the primitive only controls how its content fills that area.

```js
const table = blocks.table({
  head: ["Case", "Passed"],
  rows: [["Bounds", "Yes"]],
  caption: "Validation results",
});

const image = blocks.image({
  src: "/decks/demo/assets/result.png",
  alt: "Validation chart",
  fit: "contain",
  ratio: "16 / 9",
});
```

Table cells accept plain values or `{ value, colspan, rowspan, scope }` objects. Primitive content is treated as authored HTML, consistent with the existing textbox and layout APIs; callers must escape untrusted data before passing it in.

Use `bootDeckPortal({ deckRegistry, deckList, themes: palettes, defaultTheme: defaultPalette })` for the normal launcher/deck/presenter/Frame Mode surface. Supplying palettes enables the theme controller for every selected deck; themes compose semantic tokens and primitive presentation while the grid remains the only positioning system. Static exports consume the same `palettes` / `defaultPalette` contract. Add `?inspect=1` to a rendered deck URL to run browser-only overflow, density, and contrast checks. The result is stored on `window.__latticeInspection` and dispatched as a `lattice:inspection` event.

## Development

```sh
npm install
npm test
```
