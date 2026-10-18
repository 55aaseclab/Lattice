# Changelog

## 0.2.0 — 2026-10-18

Lattice V0.2 completes the first Vibe Sliding engine release: a coding agent can create or edit a business deck through public packages, validate it, present it, and export it without business-owned runtime code.

### Added

- Data-driven `table()` and `image()` primitives, including captions, cell spans, `object-fit`, `aspect-ratio`, and shared `slide-fit-contain`, `slide-fit-cover`, and `slide-fit-stretch` classes.
- Required deck ownership metadata through non-empty `owner` and `presenter` manifest fields.
- Stable validator and rendered-inspector issues with `type`, `slide`, `area`, `element`, and `message` fields for agent-addressable fixes.
- Browser-rendered overflow, density, and theme-contrast inspection, including measurement of Reveal-hidden slides.
- Ten semantic `simple-light` palettes and a reusable theme controller/picker.
- Engine-owned launcher portal, presenter view, fullscreen fitting, and Frame Mode.
- Browser PDF export and editable PPTX export, with slide notes and Office-compatible SVG paint normalization.
- Self-contained static deck exports that retain the theme picker and palette query parameter.

### Changed

- Themes compose named grid areas, semantic tokens, and primitive presentation; the Lattice grid remains the only positioning system.
- The title-slide subtitle area now supports a common two-line subtitle without overflow.
- Runtime and CLI packages now share version `0.2.0`; the CLI depends on runtime `^0.2.0`.

### Migration

- Set both `owner` and `presenter` to non-empty strings in every `lattice.deck.v1` manifest and registry entry.
- Update `@55aaseclab/lattice-runtime` and `@55aaseclab/lattice-cli` to `^0.2.0`.
- Move reusable portal, presenter, Frame Mode, theme, inspection, PDF, and PPTX code to the public runtime APIs.
- M2 deliberately provides no compatibility shims for earlier APIs, theme tokens, storage keys, or incomplete manifests.
