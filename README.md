# Lattice

Lattice is a Slide-first creation, presentation, validation, and multi-format
delivery system. It owns Deck, Theme, Template, Presentation, browser
inspection, screenshot regression, static HTML/PDF/PPTX export, and an
engine-neutral integer-frame VideoPlan compiler. Remotion and HyperFrames are
supported as replaceable video backends only; they consume the same VideoPlan
and the same Slide Web Bundle, and do not define Lattice's Slide model or
Presentation.

## Historical archive decision (24 October 2026)

Development was paused after `v0.2.0`. The working grid, theme, validation,
browser inspection, screenshot regression, static export, PDF, and
editable-PPTX toolchain demonstrated that an independent slide platform was
viable. The pause was explicitly:

> Do not build a second video engine. Remotion and HyperFrames already provide
> mature capture/encode pipelines.

The V2.0.0 restart acts on that decision: Lattice returns as a Slide-first
system, and Remotion/HyperFrames become replaceable video backends that consume
Lattice's VideoPlan. The archived `v0.2.0` code, tests, and schema remain as
historical reference; no attempt is made to revive the self-built video engine
roadmap.

## Archive status (preserved history)

- `v0.2.0` was the last published release before archival.
- Commit `c835ad2` preserves the final rendered-inspection and screenshot-
  regression work.
- At archival, the runtime suite passed 87/87 tests and the CLI suite passed
  47/47 tests.
- Both workspaces remain private; npm publishing is not configured.

## Architecture

```text
lattice-slides business projects
        │
        ▼
Lattice public contracts/runtime/player/video-plan
        │
        ├───────────────┐
        ▼               ▼
Remotion adapter   HyperFrames adapter
        │               │
        ▼               ▼
Remotion packages  HyperFrames CLI/packages
```

Forbidden reverse dependencies:

```text
Lattice runtime/core  ✕  lattice-slides business content
Slide source          ✕  @remotion/*
Slide source          ✕  @hyperframes/*
Presentation Player   ✕  video backend
VideoPlan             ✕  backend-specific types or seconds
```

## Structure

```text
lattice/
├── packages/
│   ├── runtime/     @55aaseclab/lattice-runtime — grid, layout IR, primitives,
│   │                themes, renderer, validator, deck loading, content-lock,
│   │                VideoPlan compiler
│   └── cli/         @55aaseclab/lattice-cli — init, dev, validate, build,
│                    export, inspect, screenshot, video plan, video doctor,
│                    video backends
├── examples/
│   └── demo-deck/   minimal standard deck package example
└── skills/
    └── lattice/     AI workflow skill for native slide work
```

## Packages

- **@55aaseclab/lattice-runtime** — 960×540 canvas, grid/area/row/column/span/gap/margin/padding primitives, nested grids, layout IR, the `simple-light` theme, HTML/CSS rendering with Reveal.js integration, layout/asset validation, grid overlay debugging, Content Lock, and engine-neutral VideoPlan compiler.
- **@55aaseclab/lattice-cli** — `lattice init`, `lattice dev`, `lattice validate`, `lattice build`, `lattice export`, `lattice inspect --rendered`, `lattice screenshot`, `lattice video plan`, `lattice video doctor`.

## Local inspection

```sh
npm install
npm test
```

## Versioning

Runtime and CLI share the same version. Decks declare a `runtime` range in
their manifest and the runtime checks compatibility when loading.

See [CHANGELOG.md](./CHANGELOG.md) for release notes and migration requirements.
