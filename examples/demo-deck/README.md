# Demo Deck

A minimal example of the standard Lattice deck package format:

```text
demo-deck/
├── manifest.json   schema (lattice.deck.v1), id, title, runtime range, theme, entries
├── content.js      business semantic content only
├── layout.js       layout intent and grid placements
├── notes.js        speaker notes
└── assets/         business assets (empty in this example)
```

Use this as the starting point when creating new decks with `lattice init` or by hand. The content here is anonymized and safe to publish.
