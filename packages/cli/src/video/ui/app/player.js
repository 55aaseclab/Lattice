// Workbench preview player: plays a deck's unified timeline through the REAL
// Slide Runtime — the same frame-state surface present-play drives. The MP4
// artifact is the recording of this exact timeline, so the preview and the
// export show identical frames (M7 gate 1).
import { createSlideRuntime } from "@55aaseclab/lattice-runtime/slide-runtime";

export function createTimelinePlayer({ stage, descriptor }) {
  const fps = descriptor.fps ?? 30;
  const route = descriptor.routes?.main ?? descriptor.slides.map((slide) => slide.id);
  const slidesById = new Map(descriptor.slides.map((slide) => [slide.id, slide]));

  const segments = [];
  let cursor = 0;
  for (const slideId of route) {
    const slide = slidesById.get(slideId);
    if (!slide) throw new Error(`route references unknown slide "${slideId}"`);
    segments.push({
      slideId,
      startFrame: cursor,
      durationFrames: slide.durationFrames,
      stops: slide.stops,
      animation: slide.animation ?? null,
    });
    cursor += slide.durationFrames;
  }
  const totalFrames = cursor;

  let runtime = null;
  let mountedSlideId = null;
  let frame = 0;
  let playing = false;
  let playTimer = null;
  let destroyed = false;

  const reduceMotion = typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia("(prefers-reduced-motion: reduce)")?.matches === true;

  function resolveSegmentAt(f) {
    for (let index = segments.length - 1; index >= 0; index -= 1) {
      if (f >= segments[index].startFrame) return segments[index];
    }
    return segments[0];
  }

  async function ensureRuntime(segment) {
    if (runtime && mountedSlideId === segment.slideId) return runtime;
    if (runtime) {
      runtime.destroy();
      runtime = null;
      mountedSlideId = null;
    }
    const slide = slidesById.get(segment.slideId);
    runtime = createSlideRuntime({ slide, container: stage });
    await runtime.ready();
    mountedSlideId = segment.slideId;
    return runtime;
  }

  async function paint(targetFrame) {
    if (destroyed) return;
    const clamped = Math.max(0, Math.min(totalFrames - 1, Math.round(targetFrame)));
    const segment = resolveSegmentAt(clamped);
    await ensureRuntime(segment);
    const localFrame = clamped - segment.startFrame;
    await runtime.seek(localFrame);
    await runtime.painted(localFrame);
    frame = clamped;
  }

  function stopTickFrames() {
    // The stop landing frames across the whole route — the scrubber's
    // detents and the reduced-motion play path.
    const ticks = [];
    for (const segment of segments) {
      for (const stop of segment.stops) {
        ticks.push(segment.startFrame + stop.frame);
      }
    }
    return ticks.sort((a, b) => a - b);
  }

  function nextStopTick(from) {
    const ticks = stopTickFrames();
    return ticks.find((tick) => tick > from) ?? totalFrames - 1;
  }

  return {
    segments,
    totalFrames,
    get stopTicks() { return stopTickFrames(); },
    get frame() { return frame; },
    async seek(target) {
      this.pause();
      await paint(target);
    },
    async seekStop(stopIndex) {
      this.pause();
      const ticks = stopTickFrames();
      await paint(ticks[Math.max(0, Math.min(ticks.length - 1, stopIndex))]);
    },
    async play({ onFrame } = {}) {
      if (playing) return;
      playing = true;
      if (reduceMotion) {
        // Reduced motion: no continuous playback — jump stop to stop.
        let target = nextStopTick(frame);
        while (playing && !destroyed && frame < totalFrames - 1) {
          await paint(target);
          onFrame?.(frame);
          target = nextStopTick(frame);
        }
        playing = false;
        return;
      }
      await new Promise((resolve) => {
        const tick = async () => {
          if (!playing || destroyed || frame >= totalFrames - 1) {
            playing = false;
            resolve();
            return;
          }
          await paint(frame + 1);
          onFrame?.(frame);
          if (!playing || destroyed) {
            resolve();
            return;
          }
          playTimer = setTimeout(tick, Math.max(0, Math.round(1000 / fps)));
        };
        playTimer = setTimeout(tick, 0);
      });
    },
    pause() {
      playing = false;
      if (playTimer) clearTimeout(playTimer);
    },
    get playing() { return playing; },
    destroy() {
      destroyed = true;
      playing = false;
      if (playTimer) clearTimeout(playTimer);
      runtime?.destroy();
      runtime = null;
      mountedSlideId = null;
    },
  };
}
