// Presenter-only fallback notes. The slide html already embeds notes as
// .slide-note-source asides; those win. This map exists so the surface's
// notes-source priority (embedded aside > deck map) is exercised.
export default {
  intro: "Fallback note for intro (unused because the slide embeds a note).",
  summary: "Presenter note for the summary slide from the deck notes map.",
};
