# Lattice

Lattice is an AI-native slide system. It owns how slides are created, laid out, validated, rendered, and exported; business projects only decide what to say and which assets to use.

```text
slides business project
        ↓ package import
@lattice/cli + @lattice/runtime
        ↓
Reveal.js + HTML/CSS
```

Forbidden reverse dependency:

```text
@lattice/runtime  ✕  slides/decks or slides/public
```

## Structure

```text
lattice/
├── packages/
│   ├── runtime/     @lattice/runtime — grid, layout IR, primitives, themes, renderer, validator, deck loading
│   └── cli/         @lattice/cli — init, dev, validate, build, export
├── examples/
│   └── demo-deck/   minimal standard deck package example
└── skills/
    └── slides/      AI workflow skill for native slide work
```

## Development

```sh
npm install
npm test
```

The monorepo builds and tests independently of any business repository.

## Packages

- **@lattice/runtime** — 960×540 (or configurable) canvas, grid/area/row/column/span/gap/margin/padding primitives, nested grids, layout IR, the `simple-light` theme, HTML/CSS rendering with Reveal.js integration, layout/asset validation, and grid overlay debugging.
- **@lattice/cli** — `lattice init`, `lattice dev`, `lattice validate`, `lattice build`, `lattice export`.

## Versioning

- patch: bug fixes, no deck schema changes.
- minor: new capabilities, backwards compatible.
- major: deck schema or layout IR migrations required.

Runtime and CLI share the same version. Decks declare a `runtime` range in their manifest and the runtime checks compatibility when loading.
