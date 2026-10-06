---
name: slides
description: Use when creating or updating native Lattice slides. Build on the grid system, compose with reusable layout primitives and the simple-light theme, keep deck data separate from runtime code, and verify the rendered result.
---

# Lattice Slides Skill

Use this skill for native slide work in Lattice business projects (for example a `slides/` project that depends on `@lattice/runtime` and `@lattice/cli`).

The current scope is intentionally limited to:

- `new slide`
- `update slide`

PPTX import, PPTX conversion, and reference-deck repair are out of scope for now. Do not design the native workflow around those features; they will be handled separately later.

## Core Architecture

Lattice layers:

```text
grid system
    ↓
layout primitives / Layout IR
    ↓
simple-light theme
    ↓
deck content and slide composition
```

Keep these responsibilities separate:

- `@lattice/runtime/grid`: canvas, grid cells, areas, spans, gaps, spacing, nested grids.
- `@lattice/runtime/layout`: semantic slots, layout primitives, placement and relationships.
- `@lattice/runtime/primitives`: text, image, diagram, card, quote, chart, table and other elements.
- `@lattice/runtime/themes/simple-light`: typography, colors, borders, default spacing and visual treatment.
- `decks/<deck>`: business content, layout intent and speaker notes.
- `@lattice/cli`: init, dev, validate, build and export.

The grid system is foundational. A template or theme must compose grid areas; it must not become a second positioning system.

## Phase 1: Precheck

Before editing, identify the requested route:

- `new slide`: create a new native slide or deck content.
- `update slide`: modify an existing native slide in place.

Inspect the relevant files before changing them:

1. The active deck under `decks/`.
2. The grid and layout primitives exposed by `@lattice/runtime`.
3. The active theme under `@lattice/runtime/themes/simple-light/`.
4. The deck's content, layout and notes data.

Do not introduce a new theme or an independent layout engine unless the user explicitly requests it. Import only through package exports (`@lattice/runtime`, `@lattice/runtime/layout`, `@lattice/runtime/themes/simple-light`), never through private package paths.

## Grid-First Placement

All native placement starts with a grid area.

Prefer this kind of placement:

```js
{
  column: 7,
  row: 2,
  columnSpan: 5,
  rowSpan: 4
}
```

Use semantic areas or slots when the template provides them:

```js
{
  slot: "body-right",
  placement: {
    column: 7,
    row: 2,
    columnSpan: 5,
    rowSpan: 4
  }
}
```

Do not start with raw pixel coordinates, arbitrary `left/top`, or deck-specific absolute positioning. Pixels are a renderer concern and may only appear at the final rendering boundary or in a deliberate legacy compatibility path.

Use the grid for both text and graphics:

- text blocks occupy grid areas and define alignment/overflow behavior;
- images define `fit` (`cover`, `contain`, or `stretch`) inside their areas;
- diagrams and charts occupy areas and may contain a nested grid;
- related items use shared rows, columns, spans or alignment constraints.

Use spacing tokens and relationships instead of arbitrary offsets:

```js
{
  gap: "md",
  margin: "lg",
  padding: "sm",
  align: "center"
}
```

The priority order is:

```text
template structure > grid placement > spacing/alignment > micro-adjustment
```

If content does not fit, change the content, span or layout before adding pixel nudges.

## New Slide Workflow

When creating a slide:

1. Identify the message and the smallest useful amount of content.
2. Choose the closest existing semantic template or layout primitive.
3. Define the slide grid and named areas before writing markup.
4. Place text, images and diagrams using grid coordinates or semantic slots.
5. Bind business content from the deck's content data; do not bury reusable content in theme code.
6. Use `simple-light` for visual treatment and default typography.
7. Add only the deck-specific composition needed for this slide.
8. Run `lattice validate` and render the slide.
9. Inspect the rendered pixels, including the visible grid overlay when debugging placement.

Prefer reusable structures such as:

- title + body;
- title + two columns;
- image + text;
- card grid;
- timeline;
- quote;
- metric / big number;
- diagram with labels;
- stacked or nested grid composition.

Keep slide text lean:

- prefer phrases over paragraphs;
- use short labels;
- remove redundant prose;
- split overloaded slides;
- preserve visual hierarchy.

## Update Slide Workflow

When updating an existing slide:

1. Find the slide in its deck and identify its content, layout and notes sources.
2. Preserve the existing template and grid unless the requested change requires a layout change.
3. Classify the change as one of:
   - content update;
   - layout update;
   - primitive update;
   - styling update;
   - notes update.
4. Update the appropriate layer first.
5. Keep existing grid areas and relationships stable where possible.
6. Re-run validation and inspect the rendered slide.

For layout changes, prefer changing:

- grid area;
- row/column span;
- stack direction;
- gap or spacing token;
- alignment;
- nested grid structure.

Do not add a floating absolute element when the change belongs in an existing grid area or layout primitive.

For a genuinely freeform element, create an explicit grid area or overlay primitive and document why it cannot use the normal layout.

## Content and Data Boundaries

Keep deck-specific data separate from runtime and theme code:

```text
decks/<deck-id>/
├── content.js   business content and data
├── layout.js    grid placement and layout intent
└── notes.js     speaker notes
```

Assets belong with the deck package, not in the theme:

```text
public/decks/<deck-id>/assets/
```

Do not put business text, deck-specific images or deck-specific narrative rules into `@lattice/runtime` or its themes. The runtime must not reference business decks or business public assets.

## Validation and Visual Verification

Validation is part of the native workflow, not an optional final step.

At minimum, check:

- grid placement is within the slide or parent area;
- elements do not overlap unless explicitly layered;
- text does not overflow its area;
- images and diagrams have valid assets;
- required content bindings resolve;
- the slide still renders in the active runtime.

Run `lattice validate` to check manifests, entry files, bindings, placements, and assets from the command line. Use the grid overlay during development to inspect:

- canvas edges and safe area;
- columns and rows;
- named regions;
- element bounds;
- alignment and spacing.

The grid overlay is available in the deck view header (**Grid: Off/On**) or via `?deck=<deck-id>&grid=1`.

Do not claim completion after a clean build alone. Render and inspect at least:

- one title-heavy slide;
- one text-heavy slide;
- one image or diagram slide;
- the slide that was changed.

If a change affects a shared grid primitive or theme, inspect representative slides from every affected deck.

## Editing Rules

- Prefer editing the deck's `content.js`, `layout.js` or `notes.js` for deck-specific changes.
- Import Lattice capabilities only through package exports.
- Keep primitives generic and composable.
- Prefer adding a named slot or grid primitive over adding one-off CSS.
- Do not copy business data into the runtime.
- Do not introduce PPTX conversion logic into this workflow.
- Do not use arbitrary absolute pixel placement as the primary layout API.
- Do not reduce font size first to solve overflow; shorten content, change spans or split the slide first.

## Handoff Checklist

Before finishing a native slide task, confirm:

- the request was routed as `new slide` or `update slide`;
- the correct deck data files were updated;
- placement uses the grid or a named semantic slot;
- the simple-light theme remains reusable;
- validation was run;
- the changed slide was visually inspected;
- no PPTX conversion work was introduced;
- any remaining limitation is reported explicitly.
