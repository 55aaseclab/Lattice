// Narration WAV assembly (M10): per-slide TTS segments are placed on the
// timeline's frame grid — each segment starts exactly at its slide's segment
// boundary (silence padding to the frame edge) and must fit inside its
// segment. The stitched artifact is one canonical PCM WAV (mono, 16-bit,
// engine sample rate), so the mix consumes a single deck asset whose bytes
// are a pure function of the generated segments.

export const WAV_SAMPLE_FORMAT_PCM16 = 1;

export function pcm16FromFloat32(samples) {
  const pcm = new Int16Array(samples.length);
  for (let index = 0; index < samples.length; index += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[index]));
    pcm[index] = Math.round(clamped * 32767);
  }
  return pcm;
}

export function encodePcm16Wav(pcm, sampleRate, { channels = 1 } = {}) {
  const dataSize = pcm.length * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(WAV_SAMPLE_FORMAT_PCM16, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * 2, 28);
  buffer.writeUInt16LE(channels * 2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  for (let index = 0; index < pcm.length; index += 1) {
    buffer.writeInt16LE(pcm[index], 44 + index * 2);
  }
  return buffer;
}

/**
 * Stitch per-segment narration onto the frame grid.
 *
 * @param {object} options
 * @param {Array<{ slideId: string, samples: Float32Array }>} options.segments
 *   TTS output per slide, in timeline (route) order.
 * @param {Array<{ slideId: string, durationFrames: number }>} options.plan
 *   Segment plan in the same order (durationFrames from the resolved timeline).
 * @param {number} options.fps
 * @param {number} options.totalFrames
 * @param {number} options.sampleRate
 * @returns {{ buffer: Buffer, sampleRate: number, durationSeconds: number,
 *             segments: Array<{ slideId: string, startSample: number, sampleCount: number, startFrame: number, durationFrames: number, fitFrames: number }> }}
 *   The canonical WAV bytes plus per-segment placement. Every segment starts
 *   on its segment's first frame; trailing silence fills to totalFrames.
 */
export function stitchNarrationWav({ segments, plan, fps, totalFrames, sampleRate }) {
  if (segments.length !== plan.length) {
    throw new Error(`narration segments (${segments.length}) and timeline segments (${plan.length}) must align`);
  }
  const totalSamples = Math.round((totalFrames / fps) * sampleRate);
  const timeline = new Float32Array(totalSamples);
  const placements = [];
  let writeCursor = 0;
  for (let index = 0; index < plan.length; index += 1) {
    const { slideId, durationFrames } = plan[index];
    const segment = segments[index];
    if (segment.slideId !== slideId) {
      throw new Error(`narration segment ${index} is ${JSON.stringify(segment.slideId)} but the timeline segment is ${JSON.stringify(slideId)}`);
    }
    const startSample = Math.round((writeCursor / fps) * sampleRate);
    const sampleCount = segment.samples.length;
    if (startSample + sampleCount > totalSamples) {
      throw new Error(`narration for "${slideId}" overruns the timeline: ${startSample + sampleCount} > ${totalSamples} samples`);
    }
    timeline.set(segment.samples, startSample);
    placements.push({
      slideId,
      startSample,
      sampleCount,
      startFrame: writeCursor,
      durationFrames,
      fitFrames: roundFrameLength(sampleCount, sampleRate, fps),
    });
    writeCursor += durationFrames;
  }
  return {
    buffer: encodePcm16Wav(pcm16FromFloat32(timeline), sampleRate),
    sampleRate,
    durationSeconds: totalSamples / sampleRate,
    segments: placements,
  };
}

/** Segment audio length expressed in frames (fractional, for the fit report). */
export function roundFrameLength(sampleCount, sampleRate, fps) {
  return Math.round((sampleCount / sampleRate) * fps * 100) / 100;
}
