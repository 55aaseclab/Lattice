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
| `content.js` | Canonical slide content (the file `lattice edit` targets) |
| `slides.js` | Builds HTML via the Theme's `simpleLightLayouts` |
| `slides.v2.js` | Deterministic integer-frame wrapper (`1` frame, one `static` stop per slide) |
| `notes.js` | Presenter notes keyed by slide id |

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
