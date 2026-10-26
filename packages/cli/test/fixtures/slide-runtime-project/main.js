// Browser-only fixture for slide-runtime-browser.test.js. Under the plain
// Node test discovery this file evaluates but does nothing (no document).
async function main() {
  const { createSlideRuntime, waitForSlideResources } = await import("@55aaseclab/lattice-runtime/slide-runtime");

  const slide = {
    id: "browser-seek-fixture",
    html:
      '<section class="slide-canvas" data-lattice-id="fixture-root">' +
      '<h1 data-lattice-id="title">Deterministic seek fixture</h1>' +
      '<div data-lattice-stop-id="first">First</div>' +
      '<div data-lattice-stop-id="second">Second</div>' +
      '<div data-lattice-stop-id="third">Third</div>' +
      "</section>",
    durationFrames: 24,
    stops: [
      { id: "first", frame: 0 },
      { id: "second", frame: 8, navigation: "play" },
      { id: "third", frame: 16 },
    ],
  };

  const container = document.getElementById("stage");
  const runtime = createSlideRuntime({ slide, container });
  await runtime.ready();

  function snapshot() {
    const names = [
      "data-lattice-frame",
      "data-lattice-stop",
      "data-lattice-stop-index",
      "data-lattice-revealed-stops",
    ];
    const variables = [
      "--lattice-local-frame",
      "--lattice-duration-frames",
      "--lattice-stop-index",
      "--lattice-stop-frame",
      "--lattice-stop-span",
      "--lattice-stop-frame-offset",
    ];
    const attributes = {};
    for (const name of names) {
      const value = container.getAttribute(name);
      if (value !== null) attributes[name] = value;
    }
    const vars = {};
    for (const name of variables) {
      const value = container.style.getPropertyValue(name);
      if (value) vars[name] = value;
    }
    return { attributes, variables: vars };
  }

  window.__latticeSeekFixture = {
    async seek(frame) {
      await runtime.seek(frame);
      await runtime.painted(frame);
      return snapshot();
    },
    async destroy() {
      runtime.destroy();
      return container.innerHTML;
    },
  };

  // A10 — default resource readiness barrier in a real browser: declared
  // images/SVG images/audio must gate ready() until verifiably loaded, and a
  // broken image must reject ready() instead of silently passing. Data URLs
  // keep this offline; the broken image points at a URL the fixture server
  // cannot serve. SVG images and media load strictly asynchronously, so they
  // genuinely gate ready(); raster data-URL images may already be complete.
  const RESOURCE_PNG =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

  function tinyWavDataUrl() {
    const sampleRate = 8000;
    const samples = 64;
    const dataSize = samples; // 8-bit mono PCM
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    const writeString = (offset, text) => {
      for (let index = 0; index < text.length; index += 1) view.setUint8(offset + index, text.charCodeAt(index));
    };
    writeString(0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeString(8, "WAVE");
    writeString(12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, 1, true); // mono
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate, true);
    view.setUint16(32, 1, true);
    view.setUint16(34, 8, true);
    writeString(36, "data");
    view.setUint32(40, dataSize, true);
    for (let index = 0; index < samples; index += 1) view.setUint8(44 + index, 128);
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return `data:audio/wav;base64,${btoa(binary)}`;
  }

  const RESOURCE_WAV = tinyWavDataUrl();

  function makeResourceSlide(id, innerHtml) {
    return {
      id,
      html: `<section class="slide-canvas">${innerHtml}</section>`,
      durationFrames: 1,
      stops: [{ id: "static", frame: 0 }],
    };
  }

  window.__latticeResourceFixture = {
    async readyWithLoadedResources() {
      const stage = document.getElementById("resource-stage");
      stage.innerHTML = "";
      const slideDef = makeResourceSlide(
        "resource-fixture",
        `<img src="${RESOURCE_PNG}" alt="dot">` +
        `<svg viewBox="0 0 1 1" width="1" height="1"><image href="${RESOURCE_PNG}"></image></svg>` +
        `<audio src="${RESOURCE_WAV}"></audio>`,
      );
      const resourceRuntime = createSlideRuntime({ slide: slideDef, container: stage });
      await resourceRuntime.ready();
      return {
        latticeId: stage.getAttribute("data-lattice-id"),
        images: [...stage.querySelectorAll("img, image")].map((element) => ({
          tag: element.tagName.toLowerCase(),
          complete: element.complete === true ? true : null,
        })),
        audioReadyState: stage.querySelector("audio")?.readyState ?? null,
      };
    },
    async readyWithBrokenImage() {
      const stage = document.getElementById("broken-stage");
      stage.innerHTML = "";
      const slideDef = makeResourceSlide("broken-fixture", `<img src="/missing-resource.png" alt="broken">`);
      const brokenRuntime = createSlideRuntime({ slide: slideDef, container: stage });
      try {
        await brokenRuntime.ready();
        return { ok: true };
      } catch (error) {
        return { ok: false, error: String(error.message ?? error) };
      } finally {
        brokenRuntime.destroy();
      }
    },
    // The default barrier's own summary for the same fresh mount, using only
    // strictly-async resources (svg image + audio) so the tracked count is
    // deterministic: proves both waiters gated the wait and settled loaded.
    async resourceBarrierSummary() {
      const stage = document.getElementById("resource-stage");
      stage.innerHTML =
        `<section class="slide-canvas">` +
        `<svg viewBox="0 0 1 1" width="1" height="1"><image href="${RESOURCE_PNG}"></image></svg>` +
        `<audio src="${RESOURCE_WAV}"></audio>` +
        `</section>`;
      return waitForSlideResources({ container: stage });
    },
  };
}

if (typeof document !== "undefined" && typeof window !== "undefined") {
  await main();
}
