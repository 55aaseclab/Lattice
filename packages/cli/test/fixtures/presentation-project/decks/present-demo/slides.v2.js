// Fixture slide definitions for the M2 presentation integration suite.
// Multi-stop timing with both navigation modes, notes embedded as
// .slide-note-source asides (exactly like the migrated business decks), and a
// slide-level interactive control for the keyboard focus-guard test.

const base = (id, inner) =>
  `<section class="slide-canvas" data-lattice-id="${id}">${inner}</section>`;

const stopMarker = (stopId, label) =>
  `<div class="fixture-stop" data-lattice-stop-id="${stopId}">${label}</div>`;

export const slideDefinitions = [
  {
    id: "intro",
    html: base(
      "intro",
      `<h1>Presentation fixture intro</h1>` +
        stopMarker("open", "intro opening") +
        `<button type="button" class="fixture-button" data-lattice-fixture-button>Slide button</button>` +
        `<aside class="slide-note-source" hidden>Presenter note for the intro slide. The audience must never see this.</aside>`,
    ),
    durationFrames: 10,
    stops: [{ id: "open", frame: 0 }],
  },
  {
    id: "timeline",
    html: base(
      "timeline",
      `<h1>Presentation fixture timeline</h1>` +
        stopMarker("start", "timeline start") +
        stopMarker("reveal", "timeline reveal") +
        stopMarker("complete", "timeline complete") +
        `<aside class="slide-note-source" hidden>Presenter note for the timeline slide.</aside>`,
    ),
    durationFrames: 30,
    stops: [
      { id: "start", frame: 0 },
      { id: "reveal", frame: 10, navigation: "play" },
      { id: "complete", frame: 20 },
    ],
  },
  {
    id: "summary",
    html: base(
      "summary",
      `<h1>Presentation fixture summary</h1>` + stopMarker("static", "summary static"),
    ),
    durationFrames: 5,
    stops: [{ id: "static", frame: 0 }],
  },
];
