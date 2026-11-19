// Deterministic ambient BGM synthesis (M10): a pure-math ffmpeg pad —
// layered sine partials with slow LFO shimmer, every frequency, phase, and
// rate derived from the seed. Same seed → same bytes (no network, no random,
// no timestamps; bitexact WAV output). Style vocabulary is versioned: v1
// ships "ambient" only.

import { execFile } from "node:child_process";

export const BGM_STYLES = Object.freeze({
  ambient: {
    // Layered low partials (root, fifth, octave, slight detune shimmer) with
    // independent slow amplitude LFOs — a soft environmental bed, never a
    // melody. Amplitudes keep the pad around -24 dBFS RMS so the default
    // track volume (0.2) sits well under narration.
    build: ({ seed, durationSeconds, sampleRate }) => {
      const pentatonic = [110, 130.81, 146.83, 164.81, 196];
      const root = pentatonic[seed % pentatonic.length];
      const fifth = root * 1.5;
      const octave = root * 2;
      const detune = root * 1.0035;
      const lfo = (base, salt) => base + ((seed >> salt) % 7) * 0.011;
      const phase = (salt) => ((seed >> salt) % 628) / 100;
      const l1 = lfo(0.05, 3);
      const l2 = lfo(0.07, 5);
      const l3 = lfo(0.11, 7);
      const l4 = lfo(0.083, 11);
      const p0 = phase(2);
      const p1 = phase(4);
      const p2 = phase(6);
      const p3 = phase(8);
      const p4 = phase(10);
      const p5 = phase(12);
      const p6 = phase(14);
      const p7 = phase(16);
      const left =
        `0.16*sin(2*PI*${root}*t+${p0})*(0.55+0.45*sin(2*PI*${l1}*t+${p1}))` +
        `+0.09*sin(2*PI*${fifth}*t+${p2})*(0.6+0.4*sin(2*PI*${l2}*t+${p3}))` +
        `+0.05*sin(2*PI*${octave}*t+${p4})*(0.7+0.3*sin(2*PI*${l3}*t+${p5}))` +
        `+0.02*sin(2*PI*${octave}*1.01*t+${p6})`;
      const right =
        `0.16*sin(2*PI*${root}*1.0035*t+${p1})*(0.55+0.45*sin(2*PI*${l4}*t+${p0}))` +
        `+0.09*sin(2*PI*${fifth}*1.0035*t+${p3})*(0.6+0.4*sin(2*PI*${l1}*t+${p2}))` +
        `+0.05*sin(2*PI*${octave}*1.0035*t+${p5})*(0.7+0.3*sin(2*PI*${l2}*t+${p4}))` +
        `+0.02*sin(2*PI*${detune}*1.01*t+${p7})`;
      return {
        args: [
          "-y", "-hide_banner",
          "-f", "lavfi",
          "-i", `aevalsrc=exprs='${left}|${right}':s=${sampleRate}:d=${durationSeconds.toFixed(6)}`,
          "-fflags", "+bitexact",
          "-c:a", "pcm_s16le",
        ],
      };
    },
  },
});

export function synthBgmArgs({ style, seed, durationSeconds, sampleRate = 44100 }) {
  const entry = BGM_STYLES[style];
  if (!entry) {
    throw Object.assign(
      new Error(`unknown bgm style ${JSON.stringify(style)} (available: ${Object.keys(BGM_STYLES).join(", ")})`),
      { code: "unknown-bgm-style" },
    );
  }
  return entry.build({ seed, durationSeconds, sampleRate }).args;
}

/** Run ffmpeg with the given argv tail, capturing stderr for diagnostics. */
export function runFfmpeg(argsTail, { timeoutMs = 10 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", argsTail, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(Object.assign(new Error(`ffmpeg failed: ${error.message}${stderr ? `\n${stderr.slice(-4000)}` : ""}`), { code: "ffmpeg-failed" }));
        return;
      }
      resolve({ stdout: stdout ?? "", stderr: stderr ?? "" });
    });
  });
}
