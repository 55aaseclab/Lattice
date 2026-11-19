// Test-only piper narration engine (selected with LATTICE_PIPER_ENGINE=stub):
// deterministic, model-free synthesis mirroring the silent kokoro stub, so
// the piper dispatch path (declaration, engine field write-back, duration
// gate, stitching, provenance) can be tested without the piper binary.
// Output length is a pure function of the text length, so fixtures can
// assert both the fitting and the over-run paths exactly.

export const PIPER_STUB_SAMPLE_RATE = 24000;

export function createPiperStubNarrationEngine({ voice = "zh_CN-huayan-medium", speed = 1 } = {}) {
  return {
    engine: "piper",
    engineVersion: "test-only",
    model: voice,
    voice,
    speed,
    sampleRate: PIPER_STUB_SAMPLE_RATE,
    async generate(text, { speed: speedOverride } = {}) {
      // Same length formula as the silent kokoro engine (text length / 50 /
      // speed), so fixtures can reuse the fitting math across engines.
      const seconds = Math.max(0.05, text.length / 50) / (speedOverride ?? speed);
      const samples = Math.round(seconds * PIPER_STUB_SAMPLE_RATE);
      return { samples: new Float32Array(samples), sampleRate: PIPER_STUB_SAMPLE_RATE };
    },
  };
}
