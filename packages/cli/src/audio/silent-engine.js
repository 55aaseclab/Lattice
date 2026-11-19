// Test-only narration engine (selected with LATTICE_TTS_ENGINE=silent):
// deterministic, model-free synthesis so the narrate workflow's contract —
// duration gate, stitching, timeline write-back, provenance — can be tested
// without the 310MB kokoro model. Output length is a pure function of the
// text length, so fixtures can assert both the fitting and the over-run
// paths exactly.

export const SILENT_ENGINE_SAMPLE_RATE = 24000;

export function createSilentNarrationEngine({ voice = "af_heart", speed = 1 } = {}) {
  return {
    engine: "silent",
    engineVersion: "test-only",
    model: "silent",
    voice,
    speed,
    sampleRate: SILENT_ENGINE_SAMPLE_RATE,
    async generate(text, { speed: speedOverride } = {}) {
      // V2.0.21: the per-call speed overrides the engine default, exactly
      // like the real kokoro engine — the silent engine's length formula
      // (text.length / 50 / speed seconds) lets fixtures assert the
      // per-segment speed application deterministically.
      const seconds = Math.max(0.05, text.length / 50) / (speedOverride ?? speed);
      const samples = Math.round(seconds * SILENT_ENGINE_SAMPLE_RATE);
      return { samples: new Float32Array(samples), sampleRate: SILENT_ENGINE_SAMPLE_RATE };
    },
  };
}
