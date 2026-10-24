# Lattice (archived)

> [!CAUTION]
> **Development stopped on 24 October 2026.** This repository is preserved as
> historical source. No further product development, package releases, or
> compatibility work is planned.

## Why development stopped

Lattice reached a working `v0.2.0` and demonstrated a coherent grid, theme,
validation, browser inspection, screenshot regression, static export, PDF, and
editable-PPTX toolchain. The reason for stopping is not that those pieces could
not be implemented. It is that an independent slide engine was not shown to be
a necessary product.

The proposed next milestones would have created a stable layout and animation
IR, a clock and Player runtime, deterministic Chromium frame capture, and an
FFmpeg media pipeline. Remotion already provides the important underlying
model: React compositions can be previewed in `@remotion/player`, addressed by
frame, and rendered to stills or media. A thin project-specific React layer can
add deck navigation, source metadata, notes, captions, or an editable-PPTX
exporter without owning another general-purpose runtime.

Continuing Lattice would therefore have duplicated a mature engine before we
had evidence of a distinct user problem or advantage that justified the extra
schema, compiler, runtime, test matrix, and release surface. The original plan
started from "an engine already exists" rather than validated demand. That is
the central failure recorded by this archive.

Remotion's core packages use a source-available commercial license, not MIT,
so any replacement must verify that its license fits the intended use. If it
does not, the right next step is to evaluate a permissive alternative or reduce
scope; the licensing concern alone is not evidence that Lattice should be
resumed.

## Archive status

- `v0.2.0` remains the last published release.
- Commit `c835ad2` preserves the final rendered-inspection and screenshot-
  regression work before archival.
- At archival, the runtime suite passed 87/87 tests and the CLI suite passed
  47/47 tests.
- npm publishing automation has been removed and both workspaces are marked
  private to prevent accidental releases.
- The examples, package documentation, skill, and changelog remain for
  inspection and migration only. They are not an active roadmap.

Useful pieces may still be extracted, especially the theme tokens, browser
validation fixtures, screenshot tests, and DOM-to-editable-PPTX exporter. New
work should begin from a concrete deck and the smallest proven layer above an
existing renderer, not by reviving the platform plan.

## Historical architecture

Lattice was an AI-native slide system. It owned how slides were created, laid
out, validated, rendered, and exported; business projects decided what to say
and which assets to use.

```text
slides business project
        ↓ package import
@55aaseclab/lattice-cli + @55aaseclab/lattice-runtime
        ↓
Reveal.js + HTML/CSS
```

Forbidden reverse dependency:

```text
@55aaseclab/lattice-runtime  ✕  business deck content or deck-owned assets
```

## Structure

```text
lattice/
├── packages/
│   ├── runtime/     @55aaseclab/lattice-runtime — grid, layout IR, primitives, themes, renderer, validator, deck loading
│   └── cli/         @55aaseclab/lattice-cli — init, dev, validate, build, export
├── examples/
│   └── demo-deck/   minimal standard deck package example
└── skills/
    └── lattice/     AI workflow skill for native slide work
```

## Local inspection

```sh
npm install
npm test
```

The archived monorepo builds and tests independently of any business
repository. These commands are retained to inspect or migrate the preserved
implementation.

## Packages

- **@55aaseclab/lattice-runtime** — 960×540 (or configurable) canvas, grid/area/row/column/span/gap/margin/padding primitives, nested grids, layout IR, the `simple-light` theme, HTML/CSS rendering with Reveal.js integration, layout/asset validation, and grid overlay debugging.
- **@55aaseclab/lattice-cli** — `lattice init`, `lattice dev`, `lattice validate`, `lattice build`, `lattice export`.

## Historical versioning

- patch: bug fixes, no deck schema changes.
- minor: new capabilities, backwards compatible.
- major: deck schema or layout IR migrations required.

Runtime and CLI shared the same version. Decks declare a `runtime` range in
their manifest and the runtime checks compatibility when loading. No new
versions are planned.

See [CHANGELOG.md](./CHANGELOG.md) for release notes and migration requirements.
