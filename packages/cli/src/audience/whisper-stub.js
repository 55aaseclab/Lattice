// Test-only deterministic stub transcription engine (LATTICE_ASR_ENGINE=stub).
// Never used in production runs — the real engine lives in whisper.js.

export function createStubTranscriptionEngine({ language = "en" } = {}) {
  return {
    engine: "stub",
    engineVersion: "0",
    model: "stub-transcript",
    dtype: "none",
    language,
    async transcribe({ samples, sampleRate }) {
      const seconds = samples.length / sampleRate;
      return {
        text: "Stub transcript of the narration audio.",
        chunks: [{ timestamp: [0, Math.round(seconds * 100) / 100], text: " Stub transcript of the narration audio." }],
      };
    },
  };
}
