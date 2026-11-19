// Workbench preview player: plays a deck's unified timeline through the REAL
// Slide Runtime — the same frame-state surface present-play drives. The MP4
// artifact is the recording of this exact timeline, so the preview and the
// export show identical frames (M7 gate 1).
//
// Issue 007 — the preview audio layer: the deck's audio assets are already
// frame-aligned by construction (the narration stitcher places every segment
// on its timeline boundary; the BGM bed spans the full timeline), so binding
// audio to the runtime frame clock is arithmetic — audio.currentTime =
// frame / fps on every seek, re-addressed on scrub/stop/jump, play/pause
// following the player state, BGM at its declared volume. Ducking stays
// approximate in preview; the mixed render remains the reference. Decks
// without audio assets simply carry no audio elements.
import { createSlideRuntime } from "@55aaseclab/lattice-runtime/slide-runtime";

// Re-anchor audio when the frame clock and the media clock drift further
// apart than this many seconds during continuous playback (hard syncs on
// every paint would stutter the sample).
const AUDIO_RESYNC_THRESHOLD_SECONDS = 0.2;

export function createTimelinePlayer({ stage, descriptor, audioAssets = [] }) {
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

  // Issue 007 audio layer: one HTMLAudioElement per declared track whose
  // asset exists (the descriptor only lists existing files). Volume comes
  // from the track declaration; narration and BGM are frame-aligned by
  // construction, so the clock binding is arithmetic.
  const audioTracks = (Array.isArray(audioAssets) ? audioAssets : []).map((asset) => {
    const element = new Audio();
    element.src = asset.url;
    element.preload = "auto";
    element.volume = Math.max(0, Math.min(1, typeof asset.volume === "number" ? asset.volume : 1));
    return {
      id: asset.id,
      url: asset.url,
      element,
      startFrame: Number.isInteger(asset.startFrame) ? asset.startFrame : 0,
    };
  });

  function audioLocalSeconds(track, targetFrame) {
    return (targetFrame - track.startFrame) / fps;
  }

  /**
   * Re-address every audio element to the frame clock. Hard syncs (scrub,
   * stop select, jump, play start) always set currentTime; while playing a
   * soft drift check avoids restuttering the sample every frame.
   */
  function syncAudioToFrame(targetFrame, { hard = false } = {}) {
    for (const track of audioTracks) {
      const element = track.element;
      const local = audioLocalSeconds(track, targetFrame);
      if (local < 0) {
        if (!element.paused) element.pause();
        continue;
      }
      const drift = Math.abs(element.currentTime - local);
      if (hard || drift > AUDIO_RESYNC_THRESHOLD_SECONDS) {
        try {
          element.currentTime = local;
        } catch {
          // Metadata not loaded yet: the preload will land at the last set
          // position once it does; the next sync re-addresses.
        }
      }
    }
  }

  function playAudio() {
    for (const track of audioTracks) {
      if (audioLocalSeconds(track, frame) < 0) continue;
      // A user-gesture click is what reaches play(); headless tests may relax
      // the autoplay policy, so a rejected promise is never an error.
      track.element.play().catch(() => {});
    }
  }

  function pauseAudio() {
    for (const track of audioTracks) track.element.pause();
  }

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
    // Audio follows the frame clock on every paint: a paused (scrub/stop)
    // paint hard-syncs the position without playing; a playing paint only
    // re-addresses beyond the drift threshold.
    syncAudioToFrame(clamped, { hard: !playing });
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
    get audioTracks() {
      return audioTracks.map((track) => ({ id: track.id, url: track.url, element: track.element, startFrame: track.startFrame }));
    },
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
      // Issue 007: audio starts with the frame clock, re-anchored to the
      // current frame (a mid-timeline resume picks up its segment's audio).
      syncAudioToFrame(frame, { hard: true });
      playAudio();
      if (reduceMotion) {
        // Reduced motion: no continuous playback — jump stop to stop.
        let target = nextStopTick(frame);
        while (playing && !destroyed && frame < totalFrames - 1) {
          await paint(target);
          onFrame?.(frame);
          target = nextStopTick(frame);
        }
        playing = false;
        pauseAudio();
        return;
      }
      await new Promise((resolve) => {
        // Issue 009: the loop is wall-clock paced. Each iteration derives the
        // target frame from elapsed wall time (startFrame + elapsed × fps)
        // and paints straight to it — frames that fell behind are skipped,
        // never queued — so the frame clock tracks wall time within
        // scheduling jitter instead of paying painted()'s double-rAF plus a
        // fixed sleep per frame (the old loop ran ~23 fps against a 30 fps
        // timeline and made the audio layer's drift resync stutter backward).
        // The audio clock is frame arithmetic (currentTime = frame / fps), so
        // once frames keep wall time the resync degrades to a safety net.
        const startFrame = frame;
        const startedAt = performance.now();
        const tick = async () => {
          if (!playing || destroyed || frame >= totalFrames - 1) {
            playing = false;
            pauseAudio();
            resolve();
            return;
          }
          const elapsedSeconds = (performance.now() - startedAt) / 1000;
          const target = Math.min(totalFrames - 1, Math.round(startFrame + elapsedSeconds * fps));
          if (target > frame) {
            await paint(target);
            onFrame?.(frame);
            if (!playing || destroyed) {
              resolve();
              return;
            }
          }
          // Wake on the next frame's wall-clock boundary; a paint that fell
          // behind schedules the next tick immediately (the target then
          // skips the missed frames).
          const nextDue = startedAt + ((frame + 1 - startFrame) / fps) * 1000;
          playTimer = setTimeout(tick, Math.max(0, Math.round(nextDue - performance.now())));
        };
        playTimer = setTimeout(tick, 0);
      });
    },
    pause() {
      playing = false;
      if (playTimer) clearTimeout(playTimer);
      pauseAudio();
    },
    get playing() { return playing; },
    destroy() {
      destroyed = true;
      playing = false;
      if (playTimer) clearTimeout(playTimer);
      pauseAudio();
      runtime?.destroy();
      runtime = null;
      mountedSlideId = null;
    },
  };
}
