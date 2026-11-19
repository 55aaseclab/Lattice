# simple-light template

Formal starter deck for the shared `simple-light` runtime Theme
(`@55aaseclab/lattice-runtime/themes/simple-light`). It turns the Theme into a
reusable deck product: metadata (`template.json`), a deterministic scaffold
entry (`template.js`), and this description.

## What it scaffolds

A three-slide `lattice.deck.v2` deck (title slide, body slide, main point)
with placeholder copy you are expected to replace. The deck consumes the
Theme through the runtime package subpath — the Theme directory itself is
never modified, and no business copy, data, notes, or assets are included in
the template.

| File | Purpose |
|---|---|
| `manifest.json` | v2 manifest: canvas from the Theme, fps 30, `main` route over the three stable slide ids, private publication |
| `content.js` | Canonical slide content (the file `lattice edit` targets); each slide declares its `layout`, content fields, and stop ids |
| `slides.js` | Derived rendering: maps `content.slides` through a layout renderer table built on the Theme's `simpleLightLayouts` |
| `slides.v2.js` | Derived v2 wrapper: ids and stop ids come from `content.slides`; integer-frame placeholders (1 frame per slide) until a timeline assigns real frames |
| `notes.js` | Presenter notes keyed by slide id |

The scaffolded deck is **structurally editable**: slide order, ids, layouts,
and stop ids all live in `content.js`, so
`lattice edit --structure add|remove|reorder` propagates through the deck
without touching the derived modules.

## Usage

```sh
lattice template scaffold simple-light --deck my-deck --title "My Deck"
```

After scaffolding, run the machine-checkable loop:

```sh
lattice validate --deck my-deck
lattice lock update --deck my-deck   # freeze content once it is final
lattice lock verify --deck my-deck
```
