// AI audience (v1.1) — versioned persona catalog (design §3, §7).
//
// Personas are the review JUDGES of the audience loop: they observe the
// experience pack and vote findings. The engine ships two built-in,
// versioned personas (novice + expert) with adversarial anchors (a minimum
// finding load with a severity/dimension spread for first reviews) and an
// explicit scoring rubric so two rounds of the same deck are comparable.
// The catalog is machine-readable JSON, `lattice video presets` style:
// agents copy a persona's promptAnchor into the review call — never ad-hoc.
//
// The adjudication FLOW (rounds, convergence, aggregation) is deterministic
// engine code; the persona only ever observes and votes.

export const PERSONAS_SCHEMA = "lattice.audience-personas.v1";

// V2.0.31: "visual" joins the finding dimensions — the pack's VL layer now
// carries a design critique per stop still (canvas-design dimensions), so
// personas can file layout-feel findings with the same evidence discipline
// as every other dimension.
export const REVIEW_DIMENSIONS = Object.freeze(["pacing", "clarity", "accuracy", "structure", "audio", "visual"]);
export const REVIEW_SEVERITIES = Object.freeze(["high", "medium", "low"]);
export const REVIEW_OPERATIONS = Object.freeze(["content-edit", "timeline-edit", "structure-edit", "PRD-draft"]);

const NOVICE_ANCHOR = [
  "You review a technical slide deck STRICTLY as a curious newcomer: you have",
  "no prior knowledge of the topic, you only know what the narration says and",
  "what the slides show. You do NOT read the deck source code and you do NOT",
  "use outside knowledge to fill gaps — if a term is never expanded, that is",
  "a finding, not something you silently repair.",
  "Adversarial anchor (first review round): you MUST produce at least 3",
  "findings across at least 2 different dimensions; hunt specifically for",
  "unexplained jargon, sentences you could not follow, and moments where the",
  "pace lost you. Re-review rounds: first vote every previous finding",
  "resolved/persists by checking the fresh evidence, then report only NEW",
  "findings you actually observed (never padding).",
].join(" ");

const EXPERT_ANCHOR = [
  "You review a technical slide deck as a hostile domain expert (systems/",
  "security senior engineer): you assume the material is wrong until the",
  "narration and slides prove otherwise. Attack technical accuracy, depth,",
  "and structural honesty — overstated claims, missing mechanisms,",
  "enumerations promised by the narration but not walked on the slide, and",
  "density that hides the point.",
  "Adversarial anchor (first review round): you MUST produce at least 3",
  "findings across at least 2 different dimensions, including at least one",
  "accuracy or structure finding with concrete evidence. Re-review rounds:",
  "first vote every previous finding resolved/persists against the fresh",
  "evidence, then report only NEW findings with real evidence (never",
  "padding).",
].join(" ");

export const BUILTIN_PERSONAS = Object.freeze({
  novice: Object.freeze({
    id: "novice",
    name: "Novice viewer (curious newcomer)",
    version: 1,
    lens: ["clarity (jargon first-use, followability)", "pacing (can a newcomer keep up)", "structure (does the story order make sense)"],
    adversarialAnchor: NOVICE_ANCHOR,
    scoringRubric: {
      accuracy: "1-5; a novice cannot verify depth — score on whether nothing felt asserted beyond your trust",
      clarity: "1-5; could you follow every sentence without outside knowledge",
      pacing: "1-5; did any segment rush you or drag",
      structure: "1-5; did the slides reveal what the narration promised, in order",
      audio: "1-5; could you hear and understand every word (transcript evidence)",
    },
    promptAnchor: NOVICE_ANCHOR,
  }),
  expert: Object.freeze({
    id: "expert",
    name: "Domain expert (hostile senior engineer)",
    version: 1,
    lens: ["accuracy (technical truth of every claim)", "depth (mechanisms, not vibes)", "structure (enumeration ↔ reveal alignment, density)"],
    adversarialAnchor: EXPERT_ANCHOR,
    scoringRubric: {
      accuracy: "1-5; every technical claim in the narration and on-slide text checked",
      clarity: "1-5; is the explanation precise, not merely understandable",
      pacing: "1-5; is time spent proportional to idea weight",
      structure: "1-5; does every promised enumeration land as an ordered reveal",
      audio: "1-5; does the spoken audio match the intended script (hex, symbols, abbreviations)",
    },
    promptAnchor: EXPERT_ANCHOR,
  }),
});

export function personaCatalog() {
  return {
    schema: PERSONAS_SCHEMA,
    personas: BUILTIN_PERSONAS,
    note: "Built-in personas (v1 anchors; v1.2 feeds the pack's VL still descriptions into every review prompt — WHAT YOU SEE at each stop; V2.0.31 adds the design-critique layer (WHAT'S VISUALLY WRONG) and the visual finding dimension — while frameAddress anchoring stays structure.json-based). Project-level custom personas land in v1.3 (design §11).",
  };
}

export function isKnownPersona(id) {
  return typeof id === "string" && Object.hasOwn(BUILTIN_PERSONAS, id);
}

export function getPersona(id) {
  return isKnownPersona(id) ? BUILTIN_PERSONAS[id] : null;
}
