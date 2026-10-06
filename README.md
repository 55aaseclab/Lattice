# Lattice

Lattice is an AI-native slide system. It owns how slides are created, laid out, validated, rendered, and exported; business projects only decide what to say and which assets to use.

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

## Development

```sh
npm install
npm test
```

The monorepo builds and tests independently of any business repository.

## Packages

- **@55aaseclab/lattice-runtime** — 960×540 (or configurable) canvas, grid/area/row/column/span/gap/margin/padding primitives, nested grids, layout IR, the `simple-light` theme, HTML/CSS rendering with Reveal.js integration, layout/asset validation, and grid overlay debugging.
- **@55aaseclab/lattice-cli** — `lattice init`, `lattice dev`, `lattice validate`, `lattice build`, `lattice export`.

## Versioning

- patch: bug fixes, no deck schema changes.
- minor: new capabilities, backwards compatible.
- major: deck schema or layout IR migrations required.

Runtime and CLI share the same version. Decks declare a `runtime` range in their manifest and the runtime checks compatibility when loading.
