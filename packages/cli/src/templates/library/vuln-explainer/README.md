# vuln-explainer template

Genre template for vulnerability-explainer decks ("explain one vulnerability
to a mixed audience"). Scaffolds an eight-page `lattice.deck.v2` deck whose
page archetypes, stop patterns, and depth budgets were distilled from the
delivered explainer decks' structures and their audience-review lessons
(stop-enumeration alignment, divergence disclosure, end-of-life boundary
callouts).

Only the genre structure is inherited. Every string the source decks carry
is frozen business content and is deliberately absent — every string this
template emits is a generic placeholder. The concrete provenance (which
decks the archetypes were distilled from, and which review findings shaped
each rule) is recorded in `skills/slides-vuln-explainer/SKILL.md`.

## The eight page archetypes

| Slide | Layout | Job | Core primitives |
|---|---|---|---|
| hook | `hook` | Make a stranger care in one breath; anchor the CVE id + severity with their source | `markerBadge` |
| concept | `concept` | Name the deck's one analogy; register every term in plain words | `compareTable` |
| mechanism | `mechanism` | The causal chain, revealed step by stop | `markerBadge`, `memoryGrid`, `reveal` |
| evidence | `evidence` | Prove the story with a dated event timeline | `terminalBlock`, `reveal` |
| impact | `impact` | Worst credible case + who is affected | `warningCallout`, `markerBadge` |
| score | `score` | Severity per source; divergence disclosed, never dropped | `compareTable`, `warningCallout` |
| fix-status | `fix-status` | Patch matrix + end-of-life boundary on its own stop | `compareTable`, `warningCallout` |
| takeaways | `takeaways` | Verb-first actions, one stop per item, ordinals aligned with narration | `markerBadge`, `reveal` |

Each scaffolded slide in `content.js` carries a slot-guidance comment: what
the page must cover and its depth budget (item counts, screen-text ceilings,
narration floors). The production guidance ships with the deck, so an
under-filled page is visible where the content is written. The full
per-prototype spec — must-cover checklists, depth budgets, primitive
selection, stop design rules, and the genre red lines — lives in
`skills/slides-vuln-explainer/SKILL.md`.

## Relationship to simple-light

This template is a genre layer on top of the shared `simple-light` Theme,
not a Theme copy. It never re-implements a primitive: code blocks, memory
grids, compare tables, callouts, terminals, badges, and reveal markers all
come from the Theme's `simpleLightTechnical` vocabulary, and pages compose
the Theme's layouts (`titleOnly`, `titleBody`, `mainPoint`). The deck-local
`styles.css` holds only presentation classes for the derived genre shapes
(`ve-*` namespace). Use `simple-light` for a generic deck; use
`vuln-explainer` when the deck explains one vulnerability end to end.

## What it scaffolds

| File | Purpose |
|---|---|
| `manifest.json` | v2 manifest (canvas from the Theme, fps 30, `main` route over the 8 archetypes) |
| `content.js` | Canonical content: one slide per archetype, each with its slot-guidance comment |
| `slides.js` | Derived renderer table: the 8 genre layouts + the plain Theme layouts for structural edits |
| `slides.v2.js` | Deterministic integer-frame wrapper |
| `notes.js` | Narration placeholders in the spoken register (V2.0.19 contract), one per archetype |
| `styles.css` | Deck-local genre presentation (`ve-*`, presentation-only) |

## Usage

```sh
lattice template scaffold vuln-explainer --deck my-vuln-explained
lattice validate --deck my-vuln-explained
```

Fill the placeholders page by page with `lattice edit`, keep every fact
sourced, and rehearse with the audience-review loop
(`lattice audience pack` / `review`) before freezing with
`lattice lock update`.
