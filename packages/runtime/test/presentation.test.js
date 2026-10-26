import assert from "node:assert/strict";
import { test } from "node:test";
import {
  PRESENTATION_MAIN_ROUTE,
  PRESENTATION_URL_PARAMS,
  createPresentationModel,
  createV2DeckDescriptor,
  currentPresentationStep,
  formatPresentationAddress,
  initialPresentationState,
  parsePresentationAddress,
  playSegmentFrames,
  presentationAddressParams,
  presentationEnterBranch,
  presentationExitBranch,
  presentationFirst,
  presentationJumpToFrame,
  presentationJumpToStop,
  presentationLast,
  presentationNext,
  presentationPrevious,
  presentationStopAtFrame,
  validatePresentationAddress,
} from "../src/presentation/index.js";

// M2 — engine-neutral presentation state machine (A14–A19 machine level).

const deck = () => ({
  id: "machine-demo",
  fps: 30,
  routes: {
    main: ["intro", "body", "outro"],
    details: ["body"],
  },
  slides: [
    {
      id: "intro",
      durationFrames: 10,
      stops: [
        { id: "open", frame: 0 },
        { id: "reveal", frame: 5, navigation: "play" },
      ],
    },
    {
      id: "body",
      durationFrames: 30,
      stops: [
        { id: "first", frame: 0 },
        { id: "second", frame: 10, navigation: "play" },
        { id: "third", frame: 20 },
      ],
    },
    {
      id: "outro",
      durationFrames: 5,
      stops: [{ id: "static", frame: 0 }],
    },
  ],
});

const model = () => createPresentationModel(deck());

// ---- Model creation ----

test("createPresentationModel normalizes routes, slides and stops", () => {
  const m = model();
  assert.equal(m.deckId, "machine-demo");
  assert.equal(m.fps, 30);
  assert.deepEqual([...m.routes.get("main")], ["intro", "body", "outro"]);
  assert.deepEqual([...m.routes.get("details")], ["body"]);
  assert.deepEqual([...m.branchRouteIds], ["details"]);
  const body = m.slides.get("body");
  assert.deepEqual(body.stops.map((stop) => stop.id), ["first", "second", "third"]);
  assert.equal(body.stops[1].navigation, "play");
  assert.equal(body.stops[0].navigation, "jump", "navigation defaults to jump");
});

test("createPresentationModel fails fast on structural problems", () => {
  assert.throws(() => createPresentationModel({ ...deck(), id: "Bad Id" }), /stable slug/);
  assert.throws(() => createPresentationModel({ ...deck(), slides: [] }), /non-empty slides/);
  assert.throws(() => createPresentationModel({ ...deck(), routes: { alt: ["intro"] } }), /"main" route/);
  assert.throws(() => createPresentationModel({ ...deck(), routes: { main: ["ghost"] } }), /unknown slide id/);
  assert.throws(() => createPresentationModel({ ...deck(), routes: { main: ["intro", "intro"] } }), /more than once/);
  assert.throws(
    () => createPresentationModel({
      ...deck(),
      slides: [{ id: "intro", durationFrames: 10, stops: [{ id: "open", frame: 0 }, { id: "again", frame: 0 }] }],
    }),
    /strictly increasing/,
  );
  assert.throws(
    () => createPresentationModel({
      ...deck(),
      slides: [{ id: "intro", durationFrames: 5, stops: [{ id: "open", frame: 9 }] }],
    }),
    /outside \[0, 4\]/,
  );
  assert.throws(
    () => createPresentationModel({
      ...deck(),
      slides: [{ id: "intro", durationFrames: 10, stops: [{ id: "open", frame: 0 }, { id: "open", frame: 4 }] }],
    }),
    /duplicate stop id "open"/,
  );
  assert.throws(
    () => createPresentationModel({
      ...deck(),
      slides: [{ id: "intro", durationFrames: 10, stops: [{ id: "open", frame: 0, navigation: "rewind" }] }],
    }),
    /navigation must be "jump" or "play"/,
  );
  assert.throws(() => createPresentationModel({ ...deck(), fps: 29.97 }), /fps must be a positive integer/);
});

// ---- Step transitions (A14/A15) ----

test("initial state starts the route at its first slide and stop", () => {
  const m = model();
  const state = initialPresentationState(m);
  assert.deepEqual(state, { routeId: "main", slideId: "intro", stopId: "open", branchOrigin: null });
  assert.throws(() => initialPresentationState(m, { routeId: "ghost" }), /does not exist/);
});

test("next within a jump stop emits an exact seek to the target stop frame", () => {
  const m = model();
  let state = initialPresentationState(m);
  const result = presentationNext(m, state);
  assert.equal(result.intent.kind, "seek");
  assert.equal(result.intent.slideId, "intro");
  assert.equal(result.intent.stopId, "reveal");
  assert.equal(result.intent.localFrame, 5, "jump seeks exactly to the stop frame");
  state = result.state;
  assert.equal(state.stopId, "reveal");
});

test("next from a play stop emits a play segment that pauses exactly on the target", () => {
  const m = model();
  let state = initialPresentationState(m);
  state = presentationNext(m, state).state; // intro#open -> intro#reveal (seek)
  const result = presentationNext(m, state); // intro#reveal (play) -> body#first (cross slide)
  assert.equal(result.intent.kind, "seek", "a step crossing a slide boundary is always an exact seek");
  assert.equal(result.intent.localFrame, 0);

  state = result.state; // body#first (jump) -> body#second
  const jumpResult = presentationNext(m, state);
  assert.equal(jumpResult.intent.kind, "seek");
  assert.equal(jumpResult.intent.localFrame, 10);

  state = jumpResult.state; // body#second (play) -> body#third
  const playResult = presentationNext(m, state);
  assert.equal(playResult.intent.kind, "play");
  assert.equal(playResult.intent.fromFrame, 10);
  assert.equal(playResult.intent.toFrame, 20);
  assert.equal(playResult.state.stopId, "third");
  const frames = playSegmentFrames(playResult.intent);
  assert.equal(frames.length, 10);
  assert.equal(frames[0], 11, "play advances from the frame after the current stop");
  assert.equal(frames[frames.length - 1], 20, "the final played frame is exactly the target stop frame");
  assert.equal(Math.max(...frames), playResult.intent.toFrame, "never one frame beyond the target");
});

test("prev always seeks exactly, including the previous slide's last stop", () => {
  const m = model();
  let state = initialPresentationState(m, {});
  state = presentationJumpToStop(m, state, { slideId: "body", stopId: "first" }).state;
  const result = presentationPrevious(m, state);
  assert.equal(result.intent.kind, "seek");
  assert.equal(result.intent.slideId, "intro");
  assert.equal(result.intent.stopId, "reveal", "previous slide's LAST stop");
  assert.equal(result.intent.localFrame, 5);
});

test("first/last (Home/End) seek to route boundaries", () => {
  const m = model();
  let state = presentationJumpToStop(m, initialPresentationState(m), { slideId: "body", stopId: "second" }).state;
  const home = presentationFirst(m, state);
  assert.equal(home.intent.stopId, "open");
  assert.equal(home.intent.slideId, "intro");
  const end = presentationLast(m, state);
  assert.equal(end.intent.slideId, "outro");
  assert.equal(end.intent.stopId, "static");
  assert.equal(end.intent.localFrame, 0);
});

test("boundaries hold: next at the very end and prev at the very start never move", () => {
  const m = model();
  let state = initialPresentationState(m);
  const startResult = presentationPrevious(m, state);
  assert.equal(startResult.intent, null);
  assert.equal(startResult.boundary, "start");
  assert.deepEqual(startResult.state, state);

  for (let i = 0; i < 10; i += 1) state = presentationNext(m, state).state;
  assert.equal(state.slideId, "outro");
  const endResult = presentationNext(m, state);
  assert.equal(endResult.intent, null);
  assert.equal(endResult.boundary, "end");
  assert.deepEqual(endResult.state, state);
});

test("jumpToStop lands exactly and rejects unknown steps explicitly", () => {
  const m = model();
  const state = initialPresentationState(m);
  const result = presentationJumpToStop(m, state, { slideId: "body", stopId: "third" });
  assert.equal(result.intent.kind, "seek");
  assert.equal(result.intent.localFrame, 20);
  assert.deepEqual(result.state, { routeId: "main", slideId: "body", stopId: "third", branchOrigin: null });

  assert.throws(() => presentationJumpToStop(m, state, { slideId: "ghost", stopId: "x" }), /does not exist in deck/);
  assert.throws(() => presentationJumpToStop(m, state, { slideId: "body", stopId: "ghost-stop" }), /has no stop "ghost-stop"/);
  assert.throws(() => presentationJumpToStop(m, state, { slideId: "intro", stopId: "open", routeId: "details" }), /not part of route/);
});

test("frame jumps resolve to the governing stop and land on its frame", () => {
  const m = model();
  const body = m.slides.get("body");
  assert.equal(presentationStopAtFrame(body, 0).id, "first");
  assert.equal(presentationStopAtFrame(body, 9).id, "first");
  assert.equal(presentationStopAtFrame(body, 10).id, "second");
  assert.equal(presentationStopAtFrame(body, 29).id, "third");
  assert.throws(() => presentationStopAtFrame(body, 30), /outside/);
  assert.throws(() => presentationStopAtFrame(body, 2.5), /integer/);

  const state = initialPresentationState(m);
  const result = presentationJumpToFrame(m, state, { slideId: "body", localFrame: 17 });
  assert.equal(result.intent.stopId, "second");
  assert.equal(result.intent.localFrame, 10, "lands on the step's canonical frame, not the raw frame");
});

// ---- History independence ----

test("any walk converges to the identical state for the same address", () => {
  const m = model();
  const fresh = presentationJumpToStop(m, initialPresentationState(m), { slideId: "body", stopId: "third" }).state;

  const forward = initialPresentationState(m);
  let walked = forward;
  for (let i = 0; i < 10; i += 1) walked = presentationNext(m, walked).state ?? walked;

  const backward = presentationJumpToStop(m, initialPresentationState(m), { slideId: "outro", stopId: "static" }).state;
  let backWalked = backward;
  for (let i = 0; i < 10; i += 1) backWalked = presentationPrevious(m, backWalked).state ?? backWalked;

  const viaJump = presentationJumpToStop(m, initialPresentationState(m), { slideId: "body", stopId: "second" }).state;
  const viaPlay = presentationNext(m, viaJump).state;

  for (const candidate of [walked, backWalked, viaPlay]) {
    const landed = presentationJumpToStop(m, candidate, { slideId: "body", stopId: "third" });
    assert.deepEqual(landed.state, fresh, "state after arbitrary history matches fresh state");
    assert.equal(landed.intent.localFrame, 20);
  }
});

// ---- Branches (A18 machine level) ----

test("branch entry records the exact parent step and return restores it", () => {
  const m = model();
  let state = presentationJumpToStop(m, initialPresentationState(m), { slideId: "body", stopId: "second" }).state;
  const parent = state;

  const entered = presentationEnterBranch(m, state, "details");
  assert.equal(entered.intent.kind, "seek");
  assert.equal(entered.state.routeId, "details");
  assert.equal(entered.state.slideId, "body");
  assert.equal(entered.state.stopId, "first");
  assert.deepEqual(entered.state.branchOrigin, { routeId: "main", slideId: "body", stopId: "second" });

  // Navigate within the branch, then return: the exact parent step returns.
  let branchState = presentationNext(m, entered.state).state;
  const returned = presentationExitBranch(m, branchState);
  assert.equal(returned.intent.routeId, parent.routeId);
  assert.equal(returned.intent.slideId, parent.slideId);
  assert.equal(returned.intent.stopId, parent.stopId);
  assert.equal(returned.intent.localFrame, 10);
  assert.equal(returned.state.branchOrigin, null);
});

test("entering a branch from a branch keeps the original origin; exit without origin is a boundary", () => {
  const m = model();
  const state = initialPresentationState(m);
  const firstBranch = presentationEnterBranch(m, state, "details").state;
  const boundary = presentationExitBranch(m, initialPresentationState(m));
  assert.equal(boundary.intent, null);
  assert.equal(boundary.boundary, "no-branch-origin");

  // Only one branch route exists in this deck; enter the same route is a no-op.
  const same = presentationEnterBranch(m, firstBranch, "details");
  assert.equal(same.intent, null);
  assert.equal(same.boundary, "already-on-route");
  assert.deepEqual(firstBranch.branchOrigin, { routeId: "main", slideId: "intro", stopId: "open" });
});

// ---- URL codec (A17) ----

test("URL params round-trip stable route/slide/stop IDs, never indices", () => {
  const m = model();
  const address = { routeId: "details", slideId: "body", stopId: "second", branchOrigin: { routeId: "main", slideId: "intro", stopId: "open" } };
  const params = presentationAddressParams(address);
  assert.deepEqual(params, {
    route: "details",
    slide: "body",
    stop: "second",
    [PRESENTATION_URL_PARAMS.originRoute]: "main",
    [PRESENTATION_URL_PARAMS.originSlide]: "intro",
    [PRESENTATION_URL_PARAMS.originStop]: "open",
  });
  const parsed = parsePresentationAddress(m, new URLSearchParams(params));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.address, address);
});

test("main route omits the route param; absent params resolve to the route start", () => {
  const m = model();
  const params = presentationAddressParams({ routeId: PRESENTATION_MAIN_ROUTE, slideId: "intro", stopId: "open", branchOrigin: null });
  assert.deepEqual(params, { slide: "intro", stop: "open" });
  const parsed = parsePresentationAddress(m, new URLSearchParams(""));
  assert.equal(parsed.ok, true);
  assert.deepEqual(parsed.address, { routeId: "main", slideId: "intro", stopId: "open", branchOrigin: null });
});

test("unknown route/slide/stop fail explicitly with typed errors", () => {
  const m = model();
  const cases = [
    { params: { route: "ghost" }, code: "unknown-route" },
    { params: { slide: "ghost" }, code: "unknown-slide" },
    { params: { slide: "outro", stop: "static" }, code: "slide-not-in-route", pre: { route: "details" } },
    { params: { slide: "intro", stop: "ghost-stop" }, code: "unknown-stop" },
    { params: { stop: "first" }, code: "unknown-stop", note: "stop checked against the route's first slide" },
  ];
  for (const { params, code, pre } of cases) {
    const search = new URLSearchParams({ ...(pre ?? {}), ...params });
    const parsed = parsePresentationAddress(m, search);
    assert.equal(parsed.ok, false, `expected failure for ${search}`);
    assert.equal(parsed.errors[0].code, code, JSON.stringify(parsed.errors));
    assert.ok(parsed.errors[0].message.length > 0);
  }
  // Bare numeric indices are just unknown stable IDs — never accepted.
  const indexParsed = parsePresentationAddress(m, new URLSearchParams({ slide: "0", stop: "1" }));
  assert.equal(indexParsed.ok, false);
  assert.equal(indexParsed.errors[0].code, "unknown-slide");
});

test("branch origin params must resolve explicitly (no fallback)", () => {
  const m = model();
  const good = parsePresentationAddress(m, new URLSearchParams({ route: "details", "origin-route": "main", "origin-slide": "body", "origin-stop": "second" }));
  assert.equal(good.ok, true);
  assert.deepEqual(good.address.branchOrigin, { routeId: "main", slideId: "body", stopId: "second" });

  for (const origin of [
    { "origin-route": "ghost", "origin-slide": "intro", "origin-stop": "open" },
    { "origin-route": "main", "origin-slide": "ghost", "origin-stop": "open" },
    { "origin-route": "main", "origin-slide": "intro", "origin-stop": "ghost" },
  ]) {
    const parsed = parsePresentationAddress(m, new URLSearchParams({ route: "details", ...origin }));
    assert.equal(parsed.ok, false, JSON.stringify(origin));
    assert.match(parsed.errors[0].code, /^unknown-(route|slide|stop)$/);
  }
});

test("validatePresentationAddress verifies full addresses", () => {
  const m = model();
  assert.deepEqual(validatePresentationAddress(m, { routeId: "main", slideId: "body", stopId: "second" }), { ok: true });
  const bad = validatePresentationAddress(m, { routeId: "main", slideId: "body", stopId: "ghost" });
  assert.equal(bad.ok, false);
  assert.equal(bad.errors[0].code, "unknown-stop");
});

test("formatPresentationAddress is stable and human-readable", () => {
  assert.equal(formatPresentationAddress({ routeId: "main", slideId: "body", stopId: "second" }), "main/body#second");
});

// ---- v2 descriptor glue ----

test("createV2DeckDescriptor accepts only explicit lattice.deck.v2 manifests", () => {
  const manifest = {
    schema: "lattice.deck.v2",
    id: "machine-demo",
    title: "Machine Demo",
    fps: 30,
    canvas: { width: 960, height: 540 },
    routes: { main: ["intro", "body", "outro"] },
  };
  const slides = deck().slides;
  const descriptor = createV2DeckDescriptor({ manifest, slides, notes: { intro: "hello" } });
  assert.equal(descriptor.id, "machine-demo");
  assert.equal(descriptor.fps, 30);
  assert.deepEqual(descriptor.canvas, { width: 960, height: 540 });
  assert.equal(descriptor.notes.intro, "hello");

  assert.throws(
    () => createV2DeckDescriptor({ manifest: { ...manifest, schema: "lattice.deck.v1" }, slides }),
    /requires schema "lattice.deck.v2"/,
  );
  assert.throws(
    () => createV2DeckDescriptor({ manifest: { ...manifest, routes: { main: ["ghost"] } }, slides }),
    /route "main" references slide id "ghost"/,
  );
});

test("currentPresentationStep resolves the active stop for a state", () => {
  const m = model();
  const state = presentationJumpToStop(m, initialPresentationState(m), { slideId: "body", stopId: "second" }).state;
  const step = currentPresentationStep(m, state);
  assert.equal(step.slide.id, "body");
  assert.equal(step.stop.id, "second");
  assert.equal(step.stop.frame, 10);
  assert.equal(step.index, 1);
});
