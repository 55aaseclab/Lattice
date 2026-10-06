# My Slides

A Lattice business slide project. Lattice handles how to create, lay out, validate, render, and export slides; this project only decides what to say and which assets to use.

## Usage

```sh
npm install
npm run dev                    # dev server with the deck launcher
npm run dev -- --deck demo     # open the demo deck directly
npm run dev -- --deck demo --grid=1   # inspect the deck with its grid overlay
npm run validate               # validate manifests, placements, and assets
npm run build                  # build the portal to dist/
npm run export -- --deck demo  # export a self-contained static deck
```

## Structure

```text
.
├── lattice.config.js   Lattice configuration (paths, theme, dev server)
├── index.html          web portal entry
├── src/main.js         portal routing and launcher
├── decks/
│   ├── registry.js     node-safe deck registry
│   └── demo/           deck package: manifest, content, layout, notes, slides
└── public/decks/demo/assets/   deck assets served at /decks/demo/assets/...
```

## Adding a deck

1. Copy `decks/demo` to `decks/<your-deck-id>` and update its `manifest.json` id.
2. Edit `content.js` (what to say), `layout.js` (grid intent), `notes.js` (speaker notes), and `slides.js` (composition).
3. Put images under `public/decks/<your-deck-id>/assets/` and reference them as `/decks/<your-deck-id>/assets/...`.
4. Register the deck in `decks/registry.js`.
5. Run `npm run validate` and inspect the deck with the grid overlay.
