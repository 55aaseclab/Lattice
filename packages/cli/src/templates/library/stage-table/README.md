# stage-table template

Overview-slide pattern derived from a real, frozen research-talk deck: a
Theme `title-only` layout whose body is a grid of stage cells, each carrying
three text parts (kicker / title / summary).

Only the layout skeleton is inherited. The source deck's overview copy is
frozen business content and is deliberately absent — every string this
template emits is a generic placeholder.

## What it scaffolds

A two-slide `lattice.deck.v2` deck:

| File | Purpose |
|---|---|
| `manifest.json` | v2 manifest (canvas from the Theme, fps 30, `main` route) |
| `content.js` | Canonical content: `stages` array with `kicker`/`title`/`summary` cells |
| `slides.js` | Builds the stage grid over `simpleLightLayouts.titleOnly` |
| `styles.css` | Deck-local grid/cell presentation (classes and styles are presentation-only for the Content Lock) |
| `slides.v2.js` | Deterministic integer-frame wrapper |
| `notes.js` | Presenter notes keyed by slide id |

## Usage

```sh
lattice template scaffold stage-table --deck roadmap --stages 4
lattice validate --deck roadmap
```

The `--stages` var controls how many stage cells are scaffolded (1–8,
default 3). Cell copy lives in `content.js` and can be revised with
`lattice edit` before the deck is frozen with `lattice lock update`.
