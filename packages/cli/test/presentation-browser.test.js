import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "vite";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { launchHeadlessBrowser, resolveChromiumExecutable } from "../src/commands/browser.js";

// M2 A14–A19 — real-Chromium integration for the mounted lattice.deck.v2
// presentation: boot + page/step navigation with no video backend, jump/play
// exactness, keyboard boundaries + focus guard, URL restore with explicit
// invalid-address errors, branch return, notes isolation, live region,
// reduced motion, touch, and fullscreen.

const fixtureDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "presentation-project");

// Each server gets its own dep-optimizer cache: sharing one cache across the
// suite's sequential servers lets Vite's mid-run re-optimization reload pages
// under test (flaky history assertions).
let serverSequence = 0;

async function withPresentationPage(run, { query = "", presenter = false, deckId = "present-demo" } = {}) {
  const server = await createServer({
    root: fixtureDir,
    cacheDir: path.join(tmpdir(), `lattice-vite-present-${createHash("sha256").update(fixtureDir).digest("hex").slice(0, 16)}-${(serverSequence += 1)}`),
    server: { middlewareMode: false },
  });
  await server.listen();
  const address = server.resolvedUrls?.local?.[0];
  try {
    const executable = resolveChromiumExecutable();
    if (!executable) {
      assert.fail("no headless Chromium found for the presentation integration suite; install Chrome/Chromium or run `npx playwright install chromium`");
    }
    const browser = await launchHeadlessBrowser(executable);
    try {
      const context = await browser.newContext({ hasTouch: true });
      const page = await context.newPage();
      const pageErrors = [];
      page.on("pageerror", (error) => pageErrors.push(String(error)));
      await page.goto(`${address.replace(/\/$/, "")}/?deck=${deckId}&present=1${query ? `&${query}` : ""}${presenter ? "&presenter=1" : ""}`, { waitUntil: "domcontentloaded" });
      await page.waitForFunction(() => window.__latticePresentation !== undefined, undefined, { timeout: 20000 });
      await run(page, pageErrors);
      assert.deepEqual(pageErrors, [], "the presentation page must run without page errors");
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
  }
}

async function readyHook(page) {
  await page.waitForFunction(() => window.__latticePresentation?.ready() === true, undefined, { timeout: 10000 });
  return page.evaluate(() => window.__latticePresentation.address());
}

function expectAddress(address, { routeId = "main", slideId, stopId }) {
  assert.equal(address.routeId, routeId, "routeId");
  assert.equal(address.slideId, slideId, "slideId");
  assert.equal(address.stopId, stopId, "stopId");
}

// ---- A14: presentation boots and completes page/step navigation with no
// video backend installed or initialized. ----

test("A14: presentation boots through the shared runtime and completes page/step navigation", async () => {
  await withPresentationPage(async (page) => {
    const initial = await readyHook(page);
    expectAddress(initial, { slideId: "intro", stopId: "open" });
    const bootState = await page.evaluate(() => window.__latticePresentation.normalizedState());
    assert.equal(bootState.attributes.frame, "0");
    assert.equal(bootState.attributes.slideId, "intro");
    assert.equal(bootState.attributes.stop, "open");

    // Step across a slide boundary and back through the HUD-free API.
    await page.evaluate(() => window.__latticePresentation.next());
    expectAddress(await page.evaluate(() => window.__latticePresentation.address()), { slideId: "timeline", stopId: "start" });
    await page.evaluate(() => window.__latticePresentation.next());
    expectAddress(await page.evaluate(() => window.__latticePresentation.address()), { slideId: "timeline", stopId: "reveal" });

    // HUD buttons navigate and carry accessible names.
    assert.ok(await page.evaluate(() => window.__latticePresentation.focusInteractive('[data-lattice-nav="next"]')));
    assert.equal(await page.getAttribute('[data-lattice-nav="next"]', "aria-label"), "Next step");
    assert.equal(await page.getAttribute('[data-lattice-nav="previous"]', "aria-label"), "Previous step");
    await page.click('[data-lattice-nav="next"]');
    await page.waitForFunction(
      () => window.__latticePresentation.address().stopId === "complete" && !window.__latticePresentation.isPlaying(),
      undefined,
      { timeout: 10000 },
    );
    expectAddress(await page.evaluate(() => window.__latticePresentation.address()), { slideId: "timeline", stopId: "complete" });

    await page.click('[data-lattice-nav="previous"]');
    await page.waitForFunction(() => window.__latticePresentation.address().stopId === "reveal", undefined, { timeout: 10000 });
    expectAddress(await page.evaluate(() => window.__latticePresentation.address()), { slideId: "timeline", stopId: "reveal" });
  });
});

// ---- A15: jump stops seek exactly; play stops advance from the current stop
// to the target and pause exactly on it, never one frame beyond. ----

test("A15: jump stop seeks exactly to the target frame with no intermediate playback", async () => {
  await withPresentationPage(async (page) => {
    await readyHook(page);
    // intro#open is a jump stop: next lands exactly on timeline#start frame 0,
    // then timeline#start (jump) lands exactly on reveal frame 10.
    await page.evaluate(() => window.__latticePresentation.next());
    await page.evaluate(() => window.__latticePresentation.next());
    const state = await page.evaluate(() => ({ ...window.__latticePresentation.normalizedState(), trace: window.__latticePresentation.playTrace() }));
    assert.equal(state.attributes.stop, "reveal");
    assert.equal(state.attributes.frame, "10", "jump lands exactly on the stop frame");
    assert.equal(state.variables.localFrame, "10");
    assert.deepEqual(state.trace, [], "a jump step performs no frame playback");
    assert.equal(await page.evaluate(() => window.__latticePresentation.isPlaying()), false);
  });
});

test("A15: play stop advances through every frame and pauses exactly on the target", async () => {
  await withPresentationPage(async (page) => {
    await readyHook(page);
    await page.evaluate(() => window.__latticePresentation.jumpTo({ slideId: "timeline", stopId: "reveal" }));
    // reveal (navigation "play") -> complete: frames 11..20 then the exact target.
    await page.evaluate(() => window.__latticePresentation.next());
    const state = await page.evaluate(() => ({ ...window.__latticePresentation.normalizedState(), trace: window.__latticePresentation.playTrace() }));
    const expected = Array.from({ length: 10 }, (_, index) => 11 + index);
    assert.deepEqual(state.trace, expected, "play visits exactly (fromFrame, toFrame]");
    assert.equal(state.attributes.frame, "20", "pauses exactly on the target stop frame, never one frame beyond");
    assert.equal(state.attributes.stop, "complete");
    assert.equal(state.variables.localFrame, "20");
    assert.equal(await page.evaluate(() => window.__latticePresentation.isPlaying()), false);
  });
});

test("A15: arbitrary navigation history converges to the identical normalized state", async () => {
  await withPresentationPage(async (page) => {
    await readyHook(page);
    const fresh = await page.evaluate(async () => {
      const hook = window.__latticePresentation;
      await hook.jumpTo({ slideId: "timeline", stopId: "complete" });
      return hook.normalizedState();
    });
    // Walk a different history: end, backwards two steps, forward one, then jump.
    const walked = await page.evaluate(async () => {
      const hook = window.__latticePresentation;
      await hook.last();
      await hook.previous();
      await hook.previous();
      await hook.next();
      await hook.jumpTo({ slideId: "timeline", stopId: "complete" });
      return hook.normalizedState();
    });
    assert.deepEqual(walked, fresh);
  });
});

// ---- A16: first/last boundaries, Home/End, Arrow/Page/Space and
// interactive-control focus protection. ----

test("A16: boundaries hold at the first and last step of the route", async () => {
  await withPresentationPage(async (page) => {
    await readyHook(page);
    await page.evaluate(() => window.__latticePresentation.last());
    const lastAddress = await page.evaluate(() => window.__latticePresentation.address());
    expectAddress(lastAddress, { slideId: "summary", stopId: "static" });
    await page.evaluate(() => window.__latticePresentation.next());
    assert.deepEqual(await page.evaluate(() => window.__latticePresentation.address()), lastAddress, "next at the end keeps the address");
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(() => window.__latticePresentation.address()), lastAddress, "ArrowRight at the end keeps the address");

    await page.evaluate(() => window.__latticePresentation.first());
    const firstAddress = await page.evaluate(() => window.__latticePresentation.address());
    expectAddress(firstAddress, { slideId: "intro", stopId: "open" });
    await page.evaluate(() => window.__latticePresentation.previous());
    assert.deepEqual(await page.evaluate(() => window.__latticePresentation.address()), firstAddress, "prev at the start keeps the address");
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(() => window.__latticePresentation.address()), firstAddress, "ArrowLeft at the start keeps the address");
  });
});

test("A16: Home/End keys seek to route boundaries", async () => {
  await withPresentationPage(async (page) => {
    await readyHook(page);
    await page.evaluate(() => window.__latticePresentation.next());
    await page.keyboard.press("End");
    await page.waitForFunction(() => window.__latticePresentation.address().slideId === "summary", undefined, { timeout: 5000 });
    await page.keyboard.press("Home");
    await page.waitForFunction(() => window.__latticePresentation.address().slideId === "intro", undefined, { timeout: 5000 });
    expectAddress(await page.evaluate(() => window.__latticePresentation.address()), { slideId: "intro", stopId: "open" });
  });
});

test("A16: navigation keys work from the document and are guarded by focused interactive controls", async () => {
  await withPresentationPage(async (page) => {
    await readyHook(page);
    // Document-level navigation.
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => window.__latticePresentation.address().slideId === "timeline", undefined, { timeout: 5000 });
    await page.keyboard.press("PageUp");
    await page.waitForFunction(() => window.__latticePresentation.address().slideId === "intro", undefined, { timeout: 5000 });

    // Focus guard: a focused HUD control keeps its keys and never navigates.
    await page.focus('[data-lattice-nav="next"]');
    const before = await page.evaluate(() => window.__latticePresentation.address());
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(150);
    assert.deepEqual(await page.evaluate(() => window.__latticePresentation.address()), before, "ArrowRight on a focused control must not navigate");
    await page.keyboard.press("Space");
    await page.waitForFunction(() => window.__latticePresentation.address().slideId === "timeline", undefined, { timeout: 5000 });

    // Slide-embedded interactive control: arrows guarded, Space stays local.
    await page.evaluate(() => window.__latticePresentation.jumpTo({ slideId: "intro", stopId: "open" }));
    const clickCounter = await page.evaluate(() => {
      window.__latticeFixtureClicks = 0;
      document.querySelector("[data-lattice-fixture-button]").addEventListener("click", () => {
        window.__latticeFixtureClicks += 1;
      });
      return true;
    });
    assert.equal(clickCounter, true);
    await page.focus("[data-lattice-fixture-button]");
    const guarded = await page.evaluate(() => window.__latticePresentation.address());
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(150);
    assert.deepEqual(await page.evaluate(() => window.__latticePresentation.address()), guarded, "focused slide control blocks deck navigation");
    await page.keyboard.press("Space");
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => window.__latticeFixtureClicks), 1, "Space activates the focused control itself");
    assert.deepEqual(await page.evaluate(() => window.__latticePresentation.address()), guarded, "Space on a focused control must not navigate the deck");

    // Blur restores deck navigation.
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press("ArrowRight");
    await page.waitForFunction(() => window.__latticePresentation.address().slideId === "timeline", undefined, { timeout: 5000 });

    // Positive document-level PageDown and Space navigation (unfocused target).
    await page.keyboard.press("PageDown");
    await page.waitForFunction(() => window.__latticePresentation.address().stopId === "reveal", undefined, { timeout: 5000 });
    await page.keyboard.press("Space");
    await page.waitForFunction(
      () => window.__latticePresentation.address().stopId === "complete" && !window.__latticePresentation.isPlaying(),
      undefined,
      { timeout: 5000 },
    );
  });
});

// ---- A17: URL restores deck/route/slide/step; unknown addresses fail
// explicitly; refresh/back/forward stay stable. ----

test("A17: full address restores exactly from the URL and keeps IDs (never indices)", async () => {
  await withPresentationPage(async (page) => {
    await readyHook(page);
    const state = await page.evaluate(() => ({ ...window.__latticePresentation.normalizedState() }));
    assert.equal(state.attributes.stop, "open");
    const url = await page.evaluate(() => window.__latticePresentation.url());
    assert.ok(url.includes("deck=present-demo"), "URL carries the deck id");
    assert.ok(url.includes("slide="), "URL carries the slide id");
    assert.ok(url.includes("stop="), "URL carries the stop id");
  });

  await withPresentationPage(async (page) => {
    const state = await readyHook(page).then(() => page.evaluate(() => window.__latticePresentation.normalizedState()));
    assert.equal(state.attributes.slideId, "timeline");
    assert.equal(state.attributes.stop, "complete");
    assert.equal(state.attributes.frame, "20", "restores the exact frame of the addressed step");
  }, { query: "route=main&slide=timeline&stop=complete" });
});

test("A17: refresh, back and forward keep the stable address", async () => {
  await withPresentationPage(async (page) => {
    await readyHook(page);
    await page.evaluate(() => window.__latticePresentation.next());
    await page.evaluate(() => window.__latticePresentation.jumpTo({ slideId: "timeline", stopId: "reveal" }));
    const before = await page.evaluate(() => window.__latticePresentation.normalizedState());
    const urlBefore = page.url();

    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__latticePresentation?.ready() === true, undefined, { timeout: 10000 });
    assert.equal(page.url(), urlBefore, "refresh keeps the URL");
    assert.deepEqual(await page.evaluate(() => window.__latticePresentation.normalizedState()), before, "refresh restores the exact state");

    await page.goBack();
    await page.waitForFunction(() => window.__latticePresentation.address().stopId === "start", undefined, { timeout: 5000 });
    assert.equal((await page.evaluate(() => window.__latticePresentation.normalizedState())).attributes.stop, "start", "back restores the parent address");

    await page.goForward();
    await page.waitForFunction(() => window.__latticePresentation.address().stopId === "reveal", undefined, { timeout: 5000 });
    assert.deepEqual(await page.evaluate(() => window.__latticePresentation.normalizedState()), before, "forward restores the exact state");
  });
});

for (const invalid of [
  { label: "unknown slide", query: "slide=ghost", code: "unknown-slide" },
  { label: "unknown stop", query: "slide=timeline&stop=ghost", code: "unknown-stop" },
  { label: "unknown route", query: "route=ghost", code: "unknown-route" },
  { label: "slide outside route", query: "route=appendix&slide=timeline&stop=complete", code: "slide-not-in-route" },
  { label: "index-like ids are unknown ids", query: "slide=0&stop=1", code: "unknown-slide" },
]) {
  test(`A17: ${invalid.label} fails explicitly with no fallback content`, async () => {
    await withPresentationPage(
      async (page) => {
        await page.waitForSelector("[data-lattice-presentation-error]", { timeout: 10000 });
        const error = await page.evaluate(() => window.__latticePresentation.error());
        assert.equal(error.ok, false);
        assert.equal(error.errors[0].code, invalid.code, JSON.stringify(error.errors));
        const mounted = await page.evaluate(() => ({
          canvas: document.querySelector("[data-lattice-frame]") !== null,
          slideCanvas: document.querySelector(".slide-canvas") !== null,
        }));
        assert.equal(mounted.canvas, false, "no slide runtime state may be mounted for an invalid address");
        assert.equal(mounted.slideCanvas, false, "no slide content may be mounted for an invalid address");
      },
      { query: invalid.query },
    );
  });
}

test("A17: unknown deck fails explicitly and never falls back to other content", async () => {
  await withPresentationPage(
    async (page) => {
      await page.waitForSelector('[data-lattice-presentation-error="invalid-address"]', { timeout: 10000 });
      const heading = await page.textContent("[data-lattice-presentation-error] h1");
      assert.match(heading, /Unknown deck "ghost-deck"/);
      assert.equal(await page.evaluate(() => document.querySelector(".slide-canvas") !== null), false);
    },
    { deckId: "ghost-deck" },
  );
});

// ---- A18: branch entry/return restores the exact parent slide/step; notes
// are isolated from the audience DOM. ----

test("A18: branch entry records the parent step and return restores it exactly", async () => {
  await withPresentationPage(async (page) => {
    await readyHook(page);
    await page.evaluate(() => window.__latticePresentation.jumpTo({ slideId: "timeline", stopId: "reveal" }));
    const parent = await page.evaluate(() => window.__latticePresentation.normalizedState());

    await page.evaluate(() => window.__latticePresentation.enterBranch("appendix"));
    let address = await page.evaluate(() => window.__latticePresentation.address());
    expectAddress(address, { routeId: "appendix", slideId: "summary", stopId: "static" });
    assert.deepEqual(address.branchOrigin, { routeId: "main", slideId: "timeline", stopId: "reveal" });
    assert.ok(page.url().includes("route=appendix"), "branch URL uses the stable route id");
    assert.ok(page.url().includes("origin-slide=timeline"), "branch URL records the parent slide");
    const returnLabel = await page.getAttribute("[data-lattice-branch-return]", "aria-label");
    assert.ok(/return to parent route/i.test(returnLabel ?? ""));
    assert.equal(await page.evaluate(() => document.querySelector("[data-lattice-branch-return]").hidden), false);

    // Walk inside the branch, then return via the UI control.
    await page.evaluate(() => window.__latticePresentation.next());
    address = await page.evaluate(() => window.__latticePresentation.address());
    expectAddress(address, { routeId: "appendix", slideId: "intro", stopId: "open" });
    await page.click("[data-lattice-branch-return]");
    await page.waitForFunction(() => window.__latticePresentation.address().routeId === "main", undefined, { timeout: 5000 });
    const restored = await page.evaluate(() => window.__latticePresentation.normalizedState());
    assert.deepEqual(restored, parent, "branch return restores the exact parent slide/step state");
    expectAddress(await page.evaluate(() => window.__latticePresentation.address()), { slideId: "timeline", stopId: "reveal" });
    assert.equal(await page.evaluate(() => document.querySelector("[data-lattice-branch-return]").hidden), true, "return button hides outside branches");
  });
});

test("A18: branch return stays exact across refresh inside a branch", async () => {
  await withPresentationPage(async (page) => {
    await readyHook(page);
    await page.evaluate(() => window.__latticePresentation.jumpTo({ slideId: "timeline", stopId: "complete" }));
    await page.evaluate(() => window.__latticePresentation.enterBranch("appendix"));
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => window.__latticePresentation?.ready() === true, undefined, { timeout: 10000 });
    const address = await page.evaluate(() => window.__latticePresentation.address());
    expectAddress(address, { routeId: "appendix", slideId: "summary", stopId: "static" });
    assert.deepEqual(address.branchOrigin, { routeId: "main", slideId: "timeline", stopId: "complete" }, "refresh keeps the exact origin");
    await page.click("[data-lattice-branch-return]");
    await page.waitForFunction(() => window.__latticePresentation.address().stopId === "complete", undefined, { timeout: 5000 });
    expectAddress(await page.evaluate(() => window.__latticePresentation.address()), { slideId: "timeline", stopId: "complete" });
  });
});

test("A18: audience DOM carries no presenter notes; presenter view shows them exactly once", async () => {
  await withPresentationPage(async (page) => {
    await readyHook(page);
    await page.evaluate(() => window.__latticePresentation.jumpTo({ slideId: "timeline", stopId: "reveal" }));
    const audience = await page.evaluate(() => ({
      notesInAudienceDom: window.__latticePresentation.notesInAudienceDom(),
      anyNoteSource: document.querySelectorAll(".slide-note-source").length,
      notesPanel: document.querySelectorAll("[data-lattice-notes]").length,
      presenterAttr: document.querySelector("[data-lattice-presentation]").getAttribute("data-lattice-presenter"),
    }));
    assert.equal(audience.notesInAudienceDom, 0, "notes must be absent from the audience presentation DOM");
    assert.equal(audience.anyNoteSource, 0, "the mounted slide must not contain the embedded note source");
    assert.equal(audience.notesPanel, 0);
    assert.equal(audience.presenterAttr, "false");
  });

  await withPresentationPage(
    async (page) => {
      await readyHook(page);
      await page.evaluate(() => window.__latticePresentation.jumpTo({ slideId: "timeline", stopId: "reveal" }));
      const presenter = await page.evaluate(() => ({
        notesText: window.__latticePresentation.presenterNotesText(),
        anyNoteSource: document.querySelectorAll(".slide-note-source").length,
        notesPanel: document.querySelectorAll("[data-lattice-notes]").length,
      }));
      assert.equal(presenter.notesPanel, 1, "presenter mode renders exactly one notes panel");
      assert.match(presenter.notesText, /Presenter note for the timeline slide\./);
      assert.equal(presenter.anyNoteSource, 0, "the mounted stage still never contains the note source");
    },
    { presenter: true },
  );
});

// ---- A19: keyboard, ARIA/live region, reduced motion, touch, fullscreen. ----

test("A19: live region and position readout update with ARIA on every step", async () => {
  await withPresentationPage(async (page) => {
    await readyHook(page);
    assert.equal(await page.getAttribute("[data-lattice-live]", "aria-live"), "polite");
    assert.equal(await page.getAttribute("[data-lattice-live]", "aria-atomic"), "true");
    const before = await page.evaluate(() => window.__latticePresentation.liveRegionText());
    assert.match(before, /Slide 1 of 3: intro\. Step 1 of 1: open\./);
    assert.equal(await page.evaluate(() => window.__latticePresentation.positionText()), "1 / 3 · step 1 / 1");
    await page.evaluate(() => window.__latticePresentation.jumpTo({ slideId: "timeline", stopId: "complete" }));
    const after = await page.evaluate(() => window.__latticePresentation.liveRegionText());
    assert.match(after, /Slide 2 of 3: timeline\. Step 3 of 3: complete\./);
    assert.equal(await page.evaluate(() => window.__latticePresentation.positionText()), "2 / 3 · step 3 / 3");
    assert.ok(await page.getAttribute("[data-lattice-presentation]", "aria-label"));
    assert.equal(await page.getAttribute('[data-lattice-nav="next"]', "aria-label"), "Next step");
  });
});

test("A19: reduced motion skips intermediate frames and still pauses exactly on the target", async () => {
  await withPresentationPage(async (page) => {
    await readyHook(page);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.evaluate(() => window.__latticePresentation.jumpTo({ slideId: "timeline", stopId: "reveal" }));
    await page.evaluate(() => window.__latticePresentation.next());
    const state = await page.evaluate(() => ({ ...window.__latticePresentation.normalizedState(), trace: window.__latticePresentation.playTrace() }));
    assert.deepEqual(state.trace, [20], "reduced motion plays no intermediate frames");
    assert.equal(state.attributes.frame, "20", "still pauses exactly on the target stop frame");
    assert.equal(state.attributes.stop, "complete");
  });
});

test("A19: touch swipes navigate forward and backward", async () => {
  await withPresentationPage(async (page) => {
    await readyHook(page);
    const session = await page.context().newCDPSession(page);
    const swipe = async (fromX, toX) => {
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: fromX, y: 300 }] });
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: (fromX + toX) / 2, y: 300 }] });
      await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: toX, y: 300 }] });
      await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    };
    await swipe(800, 640); // swipe left -> next step
    await page.waitForFunction(() => window.__latticePresentation.address().slideId === "timeline", undefined, { timeout: 5000 });
    await swipe(640, 800); // swipe right -> previous step
    await page.waitForFunction(() => window.__latticePresentation.address().slideId === "intro", undefined, { timeout: 5000 });
  });
});

test("A19: fullscreen toggles on the presentation stage with correct button state", async () => {
  await withPresentationPage(async (page) => {
    await readyHook(page);
    await page.click("[data-lattice-fullscreen]");
    await page.waitForTimeout(300);
    const active = await page.evaluate(() => ({
      fullscreenElement: document.fullscreenElement ? document.fullscreenElement.matches("[data-lattice-presentation]") : false,
      pressed: document.querySelector("button[data-lattice-fullscreen]").getAttribute("aria-pressed"),
      rootAttr: document.querySelector("[data-lattice-presentation]").getAttribute("data-lattice-fullscreen-active"),
      error: window.__latticePresentation.fullscreenError(),
    }));
    if (active.fullscreenElement) {
      assert.equal(active.pressed, "true");
      assert.equal(active.rootAttr, "true");
      await page.click("[data-lattice-fullscreen]");
      await page.waitForTimeout(300);
      const exited = await page.evaluate(() => document.querySelector("button[data-lattice-fullscreen]").getAttribute("aria-pressed"));
      assert.equal(exited, "false", "second toggle exits fullscreen");
    } else {
      // Headless engines without fullscreen support must fail gracefully.
      assert.notEqual(active.error, null, "unsupported fullscreen must be recorded, not silently ignored");
      assert.equal(active.pressed, "false");
    }
  });
});

// ---- M8: presenter role view — one-click audience projection. ----
//
// The presenter flips the running presentation into the audience role view:
// the deck canvas projects fullscreen while the presenter state machine keeps
// running (keyboard navigation, live region, URL). Returning is one action:
// Esc, a click/tap on the projected stage, or the toggle. Non-presenter
// pages never render the control, so the audience role view is unchanged.

test("M8: only the presenter page renders the audience projection control", async () => {
  await withPresentationPage(async (page) => {
    await readyHook(page);
    const audience = await page.evaluate(() => ({
      button: document.querySelector("[data-lattice-audience-button]") !== null,
      attr: document.querySelector("[data-lattice-presentation]").getAttribute("data-lattice-audience-projection"),
    }));
    assert.equal(audience.button, false, "the audience page must not render the projection control");
    assert.equal(audience.attr, "false");
  });

  await withPresentationPage(
    async (page) => {
      await readyHook(page);
      const presenter = await page.evaluate(() => {
        const button = document.querySelector("[data-lattice-audience-button]");
        return {
          button: button !== null,
          label: button?.getAttribute("aria-label"),
          pressed: button?.getAttribute("aria-pressed"),
          attr: document.querySelector("[data-lattice-presentation]").getAttribute("data-lattice-audience-projection"),
        };
      });
      assert.equal(presenter.button, true, "presenter mode renders the projection control");
      assert.equal(presenter.label, "Project audience view");
      assert.equal(presenter.pressed, "false");
      assert.equal(presenter.attr, "false");
    },
    { presenter: true },
  );
});

test("M8: projection hides presenter chrome while the deck keeps running; one click returns", async () => {
  await withPresentationPage(
    async (page) => {
      await readyHook(page);
      await page.click("[data-lattice-audience-button]");
      await page.waitForFunction(() => window.__latticePresentation.audienceProjectionActive() === true, undefined, { timeout: 5000 });
      const projected = await page.evaluate(() => {
        const hud = document.querySelector("[data-lattice-hud]");
        const notes = document.querySelector("[data-lattice-notes]");
        return {
          hudDisplay: getComputedStyle(hud).display,
          notesDisplay: notes ? getComputedStyle(notes).display : null,
          pressed: document.querySelector("[data-lattice-audience-button]").getAttribute("aria-pressed"),
          live: window.__latticePresentation.liveRegionText(),
          address: window.__latticePresentation.address(),
          fullscreenError: window.__latticePresentation.fullscreenError(),
        };
      });
      assert.equal(projected.hudDisplay, "none", "the HUD steps out of the audience projection");
      assert.equal(projected.notesDisplay, "none", "notes step out of the audience projection");
      assert.equal(projected.pressed, "true");
      assert.match(projected.live, /Audience projection on/);
      // Fullscreen may be unavailable on some headless engines; the
      // projection degrades to the viewport-filling root either way.
      const fullscreenOk = await page.evaluate(() => document.fullscreenElement?.matches("[data-lattice-presentation]") ?? false);
      if (!fullscreenOk) assert.notEqual(projected.fullscreenError, null, "unsupported fullscreen must be recorded, not silently ignored");

      // The state machine keeps running during the projection.
      await page.keyboard.press("ArrowRight");
      await page.waitForFunction(() => window.__latticePresentation.address().slideId === "timeline", undefined, { timeout: 5000 });
      assert.equal(await page.evaluate(() => window.__latticePresentation.audienceProjectionActive()), true, "navigation does not end the projection");

      // One click on the projected stage returns to the presenter view with
      // the exact address preserved.
      await page.click("[data-lattice-stage]");
      await page.waitForFunction(() => window.__latticePresentation.audienceProjectionActive() === false, undefined, { timeout: 5000 });
      const restored = await page.evaluate(() => ({
        address: window.__latticePresentation.address(),
        hudDisplay: getComputedStyle(document.querySelector("[data-lattice-hud]")).display,
        notesDisplay: getComputedStyle(document.querySelector("[data-lattice-notes]")).display,
        notesText: window.__latticePresentation.presenterNotesText(),
        pressed: document.querySelector("[data-lattice-audience-button]").getAttribute("aria-pressed"),
        live: window.__latticePresentation.liveRegionText(),
      }));
      assert.equal(restored.address.slideId, "timeline");
      assert.equal(restored.hudDisplay, "flex", "the HUD returns with the presenter view");
      assert.equal(restored.notesDisplay, "block", "notes return with the presenter view");
      assert.match(restored.notesText, /Presenter note for the timeline slide\./);
      assert.equal(restored.pressed, "false");
      assert.match(restored.live, /Returned to presenter view/);
    },
    { presenter: true },
  );
});

test("M8: Escape ends the projection and the toggle re-enters it", async () => {
  await withPresentationPage(
    async (page) => {
      await readyHook(page);
      await page.click("[data-lattice-audience-button]");
      await page.waitForFunction(() => window.__latticePresentation.audienceProjectionActive() === true, undefined, { timeout: 5000 });
      const fullscreenSupported = await page.evaluate(() => document.fullscreenElement?.matches("[data-lattice-presentation]") ?? false);

      // Esc is the one-key return in both modes: natively consumed by the
      // fullscreen exit when true fullscreen is active, handled by the
      // presentation key handler in the viewport-filling fallback.
      await page.keyboard.press("Escape");
      await page.waitForFunction(() => window.__latticePresentation.audienceProjectionActive() === false, undefined, { timeout: 5000 });
      assert.equal(
        await page.evaluate(() => document.querySelector("[data-lattice-presentation]").getAttribute("data-lattice-audience-projection")),
        "false",
      );
      if (fullscreenSupported) {
        assert.equal(await page.evaluate(() => document.fullscreenElement === null), true, "Esc also left true fullscreen");
      }

      // The toggle itself is the second one-click path back in and out.
      await page.evaluate(() => window.__latticePresentation.toggleAudienceProjection());
      await page.waitForFunction(() => window.__latticePresentation.audienceProjectionActive() === true, undefined, { timeout: 5000 });
      await page.evaluate(() => window.__latticePresentation.exitAudienceProjection());
      await page.waitForFunction(() => window.__latticePresentation.audienceProjectionActive() === false, undefined, { timeout: 5000 });
      const final = await page.evaluate(() => ({
        fullscreenElement: document.fullscreenElement ? document.fullscreenElement.matches("[data-lattice-presentation]") : false,
        address: window.__latticePresentation.address(),
        notesDisplay: getComputedStyle(document.querySelector("[data-lattice-notes]")).display,
      }));
      assert.equal(final.fullscreenElement, false, "exiting the projection also exits fullscreen");
      assert.equal(final.address.slideId, "intro", "the presentation state is untouched by the role-view flips");
      assert.equal(final.notesDisplay, "block");
    },
    { presenter: true },
  );
});

test("M8: a stage click outside the projection stays inert (M2 semantics unchanged)", async () => {
  await withPresentationPage(async (page) => {
    await readyHook(page);
    const before = await page.evaluate(() => window.__latticePresentation.address());
    await page.click("[data-lattice-stage]");
    await page.waitForTimeout(150);
    const after = await page.evaluate(() => ({
      address: window.__latticePresentation.address(),
      projection: window.__latticePresentation.audienceProjectionActive(),
    }));
    assert.deepEqual(after.address, before, "stage clicks must not navigate");
    assert.equal(after.projection, false, "stage clicks must not toggle the projection");
  });
});
