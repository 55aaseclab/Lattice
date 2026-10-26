import assert from "node:assert/strict";
import { test } from "node:test";
import {
  computeContentFingerprint,
  computeDeckSemanticPayload,
  verifyContentLock,
  createContentLockRecord,
  formatContentLockDiff,
  contentIdentityContinuityDiffs,
  publicationContinuityDiff,
  resolveContentIdentityManifest,
  CONTENT_LOCK_VERSION,
} from "../src/content-lock/index.js";

const sampleManifest = {
  schema: "lattice.deck.v1",
  id: "test-deck",
  title: "Test Deck",
  owner: "test-owner",
  presenter: "Test Presenter",
  runtime: "^0.2.0",
  theme: "simple-light",
  publication: {
    audience: "public",
    presenter: "Dr. Test",
    organization: "Test Lab",
    date: "2026-01-01",
    rights: "CC-BY-4.0",
  },
};

const sampleNotes = {
  intro: "Presenter: Start with the introduction slide.",
  body: "Presenter: Discuss the main content.",
  final: "Presenter: Conclude the presentation.",
};

const sampleSlideOutputs = [
  `<section class="slide-canvas layout-title-slide" data-layout="Title slide" data-sizes="Title 42pt, Subtitle 20pt" aria-label="Introduction title slide">
    <h1>Hello World</h1>
    <p>A test deck</p>
    <span>Test Presenter</span>
  </section>`,
  `<section class="slide-canvas layout-title-only" data-layout="Title only" data-sizes="Title 28pt" aria-label="Main content slide">
    <h2>Main Content</h2>
    <ul>
      <li>Item A</li>
      <li>Item B</li>
      <li>Item C</li>
    </ul>
    <aside class="slide-note-source" hidden>Presenter: Discuss the main content.</aside>
  </section>`,
];

const sampleContent = {
  slides: [
    { id: "intro", title: "Hello World", subtitle: "A test deck", presenter: "Test Presenter", date: "2026-01-01" },
    { id: "body", title: "Main Content", items: ["Item A", "Item B", "Item C"], count: 42, enabled: true },
  ],
};

test("computeContentFingerprint is deterministic for same content", () => {
  const fp1 = computeContentFingerprint(sampleContent, sampleManifest, sampleNotes, sampleSlideOutputs);
  const fp2 = computeContentFingerprint(sampleContent, sampleManifest, sampleNotes, sampleSlideOutputs);
  assert.equal(fp1.compositeHash, fp2.compositeHash);
});

test("computeContentFingerprint returns stable structure", () => {
  const fp = computeContentFingerprint(sampleContent, sampleManifest, sampleNotes, sampleSlideOutputs);
  assert.equal(fp.version, CONTENT_LOCK_VERSION);
  assert.equal(fp.slideCount, 2);
  assert.equal(typeof fp.compositeHash, "string");
  assert.equal(fp.compositeHash.length, 64);
  assert.ok(fp.slideHashes.length === 2);
  assert.ok(fp.contentHash);
  assert.ok(fp.notesHash);
  assert.ok(fp.manifestHash);
});

test("verifyContentLock passes for matching fingerprints", () => {
  const fp = computeContentFingerprint(sampleContent, sampleManifest, sampleNotes, sampleSlideOutputs);
  const result = verifyContentLock(fp, fp);
  assert.equal(result.ok, true);
});

test("verifyContentLock fails for different visible text", () => {
  const slidesA = sampleSlideOutputs;
  const slidesB = sampleSlideOutputs.map((s) => s.replace("Hello World", "Goodbye World"));
  const fp1 = computeContentFingerprint(sampleContent, sampleManifest, sampleNotes, slidesA);
  const fp2 = computeContentFingerprint(sampleContent, sampleManifest, sampleNotes, slidesB);
  const result = verifyContentLock(fp2, fp1);
  assert.equal(result.ok, false);
  assert.ok(result.diffs.includes("slideHashes"));
});

test("verifyContentLock fails for changed alt text", () => {
  const slidesA = [`<section><img alt="A diagram of X" /></section>`];
  const slidesB = [`<section><img alt="A diagram of Y" /></section>`];
  const c = { slides: [{ id: "a" }] };
  const fp1 = computeContentFingerprint(c, sampleManifest, sampleNotes, slidesA);
  const fp2 = computeContentFingerprint(c, sampleManifest, sampleNotes, slidesB);
  assert.notEqual(fp1.compositeHash, fp2.compositeHash,
    "alt text change must affect the lock");
});

test("verifyContentLock fails for changed slide order", () => {
  const fp1 = computeContentFingerprint(sampleContent, sampleManifest, sampleNotes, sampleSlideOutputs);
  const reversed = [...sampleSlideOutputs].reverse();
  const fp2 = computeContentFingerprint(sampleContent, sampleManifest, sampleNotes, reversed);
  const result = verifyContentLock(fp2, fp1);
  assert.equal(result.ok, false);
});

test("verifyContentLock fails for changed notes", () => {
  const notesA = sampleNotes;
  const notesB = { ...sampleNotes, intro: "Different note content" };
  const fp1 = computeContentFingerprint(sampleContent, sampleManifest, notesA, sampleSlideOutputs);
  const fp2 = computeContentFingerprint(sampleContent, sampleManifest, notesB, sampleSlideOutputs);
  const result = verifyContentLock(fp2, fp1);
  assert.equal(result.ok, false);
  assert.ok(result.diffs.includes("notesHash"));
});

test("verifyContentLock fails for changed content data", () => {
  const contentA = sampleContent;
  const contentB = JSON.parse(JSON.stringify(sampleContent));
  contentB.slides[1].count = 99;
  const fp1 = computeContentFingerprint(contentA, sampleManifest, sampleNotes, sampleSlideOutputs);
  const fp2 = computeContentFingerprint(contentB, sampleManifest, sampleNotes, sampleSlideOutputs);
  const result = verifyContentLock(fp2, fp1);
  assert.equal(result.ok, false);
  assert.ok(result.diffs.includes("contentHash"));
});

test("verifyContentLock fails for changed manifest metadata", () => {
  const mfA = sampleManifest;
  const mfB = { ...sampleManifest, title: "Different Title" };
  const fp1 = computeContentFingerprint(sampleContent, mfA, sampleNotes, sampleSlideOutputs);
  const fp2 = computeContentFingerprint(sampleContent, mfB, sampleNotes, sampleSlideOutputs);
  const result = verifyContentLock(fp2, fp1);
  assert.equal(result.ok, false);
  assert.ok(result.diffs.includes("manifestHash"));
});

test("verifyContentLock passes for CSS class-only changes (presentation-only normalization)", () => {
  const slidesWithStyle = sampleSlideOutputs.map((s) =>
    s.replace(/class="([^"]*)"/g, 'class="$1 my-custom-theme extra-class another"')
  );
  const fp1 = computeContentFingerprint(sampleContent, sampleManifest, sampleNotes, sampleSlideOutputs);
  const fp2 = computeContentFingerprint(sampleContent, sampleManifest, sampleNotes, slidesWithStyle);
  assert.equal(fp1.compositeHash, fp2.compositeHash,
    "CSS class changes should not affect the content lock (style-only change)");
});

test("verifyContentLock passes for data-layout-only changes (presentation-only)", () => {
  const slidesWithDataLayout = sampleSlideOutputs.map((s) =>
    s.replace(/data-layout="[^"]*"/g, 'data-layout="Different layout name"')
  );
  const fp1 = computeContentFingerprint(sampleContent, sampleManifest, sampleNotes, sampleSlideOutputs);
  const fp2 = computeContentFingerprint(sampleContent, sampleManifest, sampleNotes, slidesWithDataLayout);
  assert.equal(fp1.compositeHash, fp2.compositeHash,
    "data-layout changes should not affect the content lock (presentation-only)");
});

test("verifyContentLock passes for data-sizes-only changes (presentation-only)", () => {
  const slidesWithDataSizes = sampleSlideOutputs.map((s) =>
    s.replace(/data-sizes="[^"]*"/g, 'data-sizes="Title 100pt, Body 72pt"')
  );
  const fp1 = computeContentFingerprint(sampleContent, sampleManifest, sampleNotes, sampleSlideOutputs);
  const fp2 = computeContentFingerprint(sampleContent, sampleManifest, sampleNotes, slidesWithDataSizes);
  assert.equal(fp1.compositeHash, fp2.compositeHash,
    "data-sizes changes should not affect the content lock (presentation-only)");
});

test("verifyContentLock passes for coordinate/style attribute changes", () => {
  const slidesWithCoords = sampleSlideOutputs.map((s) =>
    s.replace('style="', 'style="x:100;y:200;transform:scale(1.5);')
  );
  const fp1 = computeContentFingerprint(sampleContent, sampleManifest, sampleNotes, sampleSlideOutputs);
  const fp2 = computeContentFingerprint(sampleContent, sampleManifest, sampleNotes, slidesWithCoords);
  assert.equal(fp1.compositeHash, fp2.compositeHash,
    "coordinate/style-only changes should not affect the content lock");
});

test("pure theme/runtime-only changes do not alter the content fingerprint", () => {
  const mfA = sampleManifest;
  const mfB = { ...sampleManifest, theme: "dark-theme", runtime: "^1.0.0" };
  const fp1 = computeContentFingerprint(sampleContent, mfA, sampleNotes, sampleSlideOutputs);
  const fp2 = computeContentFingerprint(sampleContent, mfB, sampleNotes, sampleSlideOutputs);
  assert.equal(fp1.manifestHash, fp2.manifestHash,
    "theme/runtime selection is presentation state and must not enter the semantic manifest hash");
  assert.equal(fp1.compositeHash, fp2.compositeHash,
    "pure theme/runtime-only changes must not alter the content fingerprint");
  const result = verifyContentLock(fp2, fp1);
  assert.equal(result.ok, true,
    "a lock made under a different theme/runtime must still verify when content is unchanged");
});

test("semantic manifest payload excludes theme and runtime", () => {
  const payload = computeDeckSemanticPayload({
    slideOutputs: sampleSlideOutputs,
    content: sampleContent,
    notes: sampleNotes,
    manifest: sampleManifest,
  });
  assert.ok(!("theme" in payload.manifest), "theme must not be part of the semantic manifest payload");
  assert.ok(!("runtime" in payload.manifest), "runtime must not be part of the semantic manifest payload");
});

test("verifyContentLock fails for data-lattice-id change (stable semantic identity)", () => {
  const slidesA = [`<section data-lattice-id="hero-title"><h1>Title</h1></section>`];
  const slidesB = [`<section data-lattice-id="hero-title-renamed"><h1>Title</h1></section>`];
  const c = { slides: [{ id: "a" }] };
  const fp1 = computeContentFingerprint(c, sampleManifest, sampleNotes, slidesA);
  const fp2 = computeContentFingerprint(c, sampleManifest, sampleNotes, slidesB);
  assert.notEqual(fp1.compositeHash, fp2.compositeHash,
    "data-lattice-id change must affect the lock");
});

test("verifyContentLock fails for ordinary stable id attribute change", () => {
  const slidesA = [`<svg><defs><linearGradient id="arrow-gradient"></linearGradient></defs></svg>`];
  const slidesB = [`<svg><defs><linearGradient id="arrow-gradient-v2"></linearGradient></defs></svg>`];
  const c = { slides: [{ id: "a" }] };
  const fp1 = computeContentFingerprint(c, sampleManifest, sampleNotes, slidesA);
  const fp2 = computeContentFingerprint(c, sampleManifest, sampleNotes, slidesB);
  assert.notEqual(fp1.compositeHash, fp2.compositeHash,
    "stable id change must affect the lock");
});

test("verifyContentLock fails for data-slide-number change (reachable semantic attr)", () => {
  const slidesA = [`<section data-slide-number="3"><h1>Title</h1></section>`];
  const slidesB = [`<section data-slide-number="4"><h1>Title</h1></section>`];
  const c = { slides: [{ id: "a" }] };
  const fp1 = computeContentFingerprint(c, sampleManifest, sampleNotes, slidesA);
  const fp2 = computeContentFingerprint(c, sampleManifest, sampleNotes, slidesB);
  assert.notEqual(fp1.compositeHash, fp2.compositeHash,
    "data-slide-number is a reachable semantic attribute and must affect the lock");
});

test("verifyContentLock fails for data-motion-group change", () => {
  const slidesA = [`<div data-motion-group="timeline"><span>2023</span></div>`];
  const slidesB = [`<div data-motion-group="highlights"><span>2023</span></div>`];
  const c = { slides: [{ id: "a" }] };
  const fp1 = computeContentFingerprint(c, sampleManifest, sampleNotes, slidesA);
  const fp2 = computeContentFingerprint(c, sampleManifest, sampleNotes, slidesB);
  assert.notEqual(fp1.compositeHash, fp2.compositeHash,
    "data-motion-group change must affect the lock");
});

test("verifyContentLock still detects visible text changes alongside new identity fields", () => {
  const fp = computeContentFingerprint(sampleContent, sampleManifest, sampleNotes, sampleSlideOutputs);
  for (const sh of fp.slideHashes) {
    assert.ok(typeof sh.n === "string", "n (stable id hash) must exist");
  }
});

test("verifyContentLock fails for publication metadata change", () => {
  const mfA = sampleManifest;
  const mfB = { ...sampleManifest, publication: { ...sampleManifest.publication, audience: "private" } };
  const fp1 = computeContentFingerprint(sampleContent, mfA, sampleNotes, sampleSlideOutputs);
  const fp2 = computeContentFingerprint(sampleContent, mfB, sampleNotes, sampleSlideOutputs);
  assert.notEqual(fp1.compositeHash, fp2.compositeHash,
    "publication metadata change should affect the lock");
});

test("verifyContentLock fails for slide count change", () => {
  const fp1 = computeContentFingerprint(sampleContent, sampleManifest, sampleNotes, sampleSlideOutputs);
  const fewer = [sampleSlideOutputs[0]];
  const fp2 = computeContentFingerprint(sampleContent, sampleManifest, sampleNotes, fewer);
  const result = verifyContentLock(fp2, fp1);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "slide-count-changed");
});

test("verifyContentLock fails for changed element count via text nesting", () => {
  const slidesMore = [
    ...sampleSlideOutputs,
    `<section class="slide-canvas"><h2>Extra Slide</h2></section>`,
  ];
  const fp1 = computeContentFingerprint(sampleContent, sampleManifest, sampleNotes, sampleSlideOutputs);
  const fp2 = computeContentFingerprint(sampleContent, sampleManifest, sampleNotes, slidesMore);
  const result = verifyContentLock(fp2, fp1);
  assert.equal(result.ok, false);
});

test("verifyContentLock fails for changed aria-label", () => {
  const slidesA = sampleSlideOutputs;
  const slidesB = sampleSlideOutputs.map((s) =>
    s.replace('aria-label="Introduction title slide"', 'aria-label="Different label"')
  );
  const fp1 = computeContentFingerprint(sampleContent, sampleManifest, sampleNotes, slidesA);
  const fp2 = computeContentFingerprint(sampleContent, sampleManifest, sampleNotes, slidesB);
  const result = verifyContentLock(fp2, fp1);
  assert.equal(result.ok, false);
});

test("verifyContentLock fails when stored lock is missing", () => {
  const fp = computeContentFingerprint(sampleContent, sampleManifest, sampleNotes, sampleSlideOutputs);
  const result = verifyContentLock(fp, null);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "missing-fingerprint-or-stored-lock");
});

test("content lock record has correct schema and metadata", () => {
  const record = createContentLockRecord(sampleContent, sampleManifest, sampleNotes, sampleSlideOutputs);
  assert.equal(record.schema, "lattice.content-lock.v4");
  assert.equal(record.deckId, "test-deck");
  assert.ok(record.createdAt);
  assert.ok(record.fingerprint);
  assert.equal(record.fingerprint.version, CONTENT_LOCK_VERSION);
});

test("formatContentLockDiff detects content changes", () => {
  const content1 = { slides: [{ id: "a", text: "hello" }] };
  const content2 = { slides: [{ id: "b", text: "world" }] };
  const fp1 = computeContentFingerprint(content1, sampleManifest, sampleNotes, sampleSlideOutputs);
  const fp2 = computeContentFingerprint(content2, sampleManifest, sampleNotes, sampleSlideOutputs);
  const diff = formatContentLockDiff(fp2, fp1);
  assert.ok(diff.changed.length >= 1);
});

test("computeDeckSemanticPayload includes publication metadata", () => {
  const payload = computeDeckSemanticPayload({
    slideOutputs: sampleSlideOutputs,
    content: sampleContent,
    notes: sampleNotes,
    manifest: sampleManifest,
  });
  assert.equal(payload.manifest.publication.audience, "public");
  assert.equal(payload.manifest.publication.presenter, "Dr. Test");
  assert.equal(payload.manifest.publication.organization, "Test Lab");
  assert.equal(payload.manifest.publication.rights, "CC-BY-4.0");
});

test("computeDeckSemanticPayload includes sources/references metadata", () => {
  const manifestWithSources = {
    ...sampleManifest,
    sources: [{ kind: "paper", title: "Reference Paper", url: "https://example.com" }],
    references: [{ id: "ref-1", citation: "Test et al., 2026" }],
  };
  const payload = computeDeckSemanticPayload({
    slideOutputs: sampleSlideOutputs,
    content: sampleContent,
    notes: sampleNotes,
    manifest: manifestWithSources,
  });
  assert.ok(payload.manifest.id);
  assert.ok(payload.manifest.title);
  assert.ok(payload.manifest.sources, "sources must be included in manifest payload");
  assert.equal(payload.manifest.sources[0].title, "Reference Paper");
  assert.ok(payload.manifest.references, "references must be included in manifest payload");
});

test("verifyContentLock fails for DOM reparenting (structural order change)", () => {
  const slidesOriginal = [
    `<section><div><p>Text A</p><p>Text B</p></div></section>`,
  ];
  const slidesReparented = [
    `<section><p>Text A</p><div><p>Text B</p></div></section>`,
  ];
  const c = { slides: [{ id: "a" }] };
  const fp1 = computeContentFingerprint(c, sampleManifest, sampleNotes, slidesOriginal);
  const fp2 = computeContentFingerprint(c, sampleManifest, sampleNotes, slidesReparented);
  assert.notEqual(fp1.compositeHash, fp2.compositeHash,
    "DOM reparenting must change the fingerprint because structural tokens/hierarchy differ");
});

test("verifyContentLock fails for data-semantic-id change", () => {
  const slidesA = [
    `<section data-semantic-id="intro"><h1>Title</h1></section>`,
  ];
  const slidesB = [
    `<section data-semantic-id="body"><h1>Title</h1></section>`,
  ];
  const c = { slides: [{ id: "a" }] };
  const fp1 = computeContentFingerprint(c, sampleManifest, sampleNotes, slidesA);
  const fp2 = computeContentFingerprint(c, sampleManifest, sampleNotes, slidesB);
  assert.notEqual(fp1.compositeHash, fp2.compositeHash,
    "data-semantic-id change must affect the lock");
});

test("computeDeckSemanticPayload with absent notes module treats notes as empty", () => {
  const payload = computeDeckSemanticPayload({
    slideOutputs: sampleSlideOutputs,
    content: sampleContent,
    notes: {},
    manifest: sampleManifest,
  });
  assert.equal(payload.notesHash, undefined);
  assert.deepStrictEqual(payload.notes, {});
});

test("content lock fingerprint slide hashes include structural token and alt text fields", () => {
  const fp = computeContentFingerprint(sampleContent, sampleManifest, sampleNotes, sampleSlideOutputs);
  for (const sh of fp.slideHashes) {
    assert.ok(typeof sh.v === "string", "v (visible text hash) must exist");
    assert.ok(typeof sh.a === "string", "a (aria label hash) must exist");
    assert.ok(typeof sh.t === "string", "t (alt text hash) must exist");
    assert.ok(typeof sh.s === "string", "s (structural token hash) must exist");
    assert.ok(typeof sh.d === "string", "d (semantic data attrs hash) must exist");
    assert.ok(typeof sh.j === "string", "j (embedded JSON payload hash) must exist");
  }
});

// ---- v4: semantic attributes actually used by the frozen decks ----

function fingerprintWithSlides(slides, content = sampleContent) {
  return computeContentFingerprint(content, sampleManifest, sampleNotes, slides);
}

for (const [attr, value] of [
  ["data-annotation-id", "anno-1"],
  ["data-annotation-surface", "chart-main"],
  ["data-interactive-trend-chart", "harness-overview"],
  ["data-trend-aria-label", "Google Trends chart for AI agent"],
  ["data-lattice-deck", "demo"],
]) {
  test(`verifyContentLock fails for ${attr} change (frozen-deck stable identity)`, () => {
    const base = [`<div ${attr}="${value}"><p>Body</p></div>`];
    const mutated = [`<div ${attr}="MUTATED-${attr}"><p>Body</p></div>`];
    const fp1 = fingerprintWithSlides(base);
    const fp2 = fingerprintWithSlides(mutated);
    assert.notEqual(fp1.compositeHash, fp2.compositeHash,
      `${attr} change must affect the lock`);
    const result = verifyContentLock(fp2, fp1);
    assert.equal(result.ok, false);
    assert.ok(result.diffs.includes("slideHashes"));
  });

  test(`verifyContentLock passes when ${attr} is absent on both sides`, () => {
    const fp1 = fingerprintWithSlides([`<div><p>Body</p></div>`]);
    const fp2 = fingerprintWithSlides([`<div><p>Body</p></div>`]);
    assert.equal(fp1.compositeHash, fp2.compositeHash);
  });
}

// ---- v4: embedded JSON payloads in inert application/json scripts ----

const jsonScriptSlide = (series) =>
  `<div data-interactive-trend-chart="harness-overview">
    <script type="application/json" data-trend-series>${series}</script>
    <div class="surface" aria-label="Interactive Google Trends chart"></div>
  </div>`;

test("verifyContentLock fails for embedded JSON payload literal change", () => {
  const fp1 = fingerprintWithSlides([jsonScriptSlide('[{"date":"2025-01-01","value":0}]')]);
  const fp2 = fingerprintWithSlides([jsonScriptSlide('[{"date":"2025-01-01","value":99}]')]);
  assert.notEqual(fp1.compositeHash, fp2.compositeHash,
    "a changed embedded JSON data literal must affect the lock");
});

test("verifyContentLock fails for embedded JSON array order change", () => {
  const fp1 = fingerprintWithSlides([jsonScriptSlide('[{"v":1},{"v":2}]')]);
  const fp2 = fingerprintWithSlides([jsonScriptSlide('[{"v":2},{"v":1}]')]);
  assert.notEqual(fp1.compositeHash, fp2.compositeHash,
    "embedded JSON array order is semantic and must affect the lock");
});

test("verifyContentLock passes for whitespace/key-order-only embedded JSON change", () => {
  const fp1 = fingerprintWithSlides([jsonScriptSlide('[{"date":"2025-01-01","value":0}]')]);
  const fp2 = fingerprintWithSlides([jsonScriptSlide('[ { "value":0, "date":"2025-01-01" } ]')]);
  assert.equal(fp1.compositeHash, fp2.compositeHash,
    "whitespace and key order inside embedded JSON must not affect the lock (deterministic parsed representation)");
});

test("verifyContentLock fails for embedded JSON marker identity change", () => {
  const fp1 = fingerprintWithSlides([jsonScriptSlide('[{"v":1}]')]);
  const renamed = [
    `<div data-interactive-trend-chart="harness-overview">
      <script type="application/json" data-trend-values>[{"v":1}]</script>
    </div>`,
  ];
  const fp2 = fingerprintWithSlides(renamed);
  assert.notEqual(fp1.compositeHash, fp2.compositeHash,
    "marker identity change on an inert JSON script must affect the lock");
});

test("verifyContentLock fails for embedded JSON occurrence order change", () => {
  const slideA = `
    <script type="application/json" data-trend-series>[1,2]</script>
    <script type="application/json" data-trend-ticks>["a"]</script>`;
  const slideB = `
    <script type="application/json" data-trend-ticks>["a"]</script>
    <script type="application/json" data-trend-series>[1,2]</script>`;
  const fp1 = fingerprintWithSlides([slideA]);
  const fp2 = fingerprintWithSlides([slideB]);
  assert.notEqual(fp1.compositeHash, fp2.compositeHash,
    "occurrence order of embedded JSON scripts must affect the lock");
});

test("verifyContentLock ignores executable script bodies (only inert JSON scripts are fingerprinted)", () => {
  const slideA = `<div><script>app.boot("v1");</script><p>Body</p></div>`;
  const slideB = `<div><script>app.boot("v2-totally-different");</script><p>Body</p></div>`;
  const fp1 = fingerprintWithSlides([slideA]);
  const fp2 = fingerprintWithSlides([slideB]);
  assert.equal(fp1.compositeHash, fp2.compositeHash,
    "executable script bodies must not enter the content fingerprint");
});

test("verifyContentLock fails when an inert JSON script is removed", () => {
  const withScript = [jsonScriptSlide('[{"v":1}]')];
  const withoutScript = [`<div data-interactive-trend-chart="harness-overview"></div>`];
  const fp1 = fingerprintWithSlides(withScript);
  const fp2 = fingerprintWithSlides(withoutScript);
  assert.notEqual(fp1.compositeHash, fp2.compositeHash,
    "removing an inert JSON payload script must affect the lock");
});

test("embedded JSON payloads with presentation-only markers are ignored", () => {
  const slideA = `<div><script type="application/json" data-layout='{"cols":12}'>{}</script></div>`;
  const slideB = `<div><script type="application/json" data-layout='{"cols":99}'>{}</script></div>`;
  const fp1 = fingerprintWithSlides([slideA]);
  const fp2 = fingerprintWithSlides([slideB]);
  assert.equal(fp1.compositeHash, fp2.compositeHash,
    "data-layout/data-sizes script markers stay presentation-only");
});

// ---- v4: aria-label matching disambiguation ----

test("data-trend-aria-label is not captured as a standalone aria-label", () => {
  const slide = `<div data-trend-aria-label="Trend label" aria-label="Real label"></div>`;
  const payload = computeDeckSemanticPayload({
    slideOutputs: [slide],
    content: sampleContent,
    notes: sampleNotes,
    manifest: sampleManifest,
  });
  assert.deepEqual(payload.slides[0].ariaLabels, ["Real label"],
    "the aria channel must contain only the standalone aria-label");
  assert.deepEqual(payload.slides[0].semanticDataAttrs["trend-aria-label"], ["Trend label"],
    "data-trend-aria-label must be locked through the semantic data-attr channel");
});

test("both direct aria-label and data-trend-aria-label changes are detected", () => {
  const slideA = `<div data-trend-aria-label="Trend label" aria-label="Real label"></div>`;
  const slideB = `<div data-trend-aria-label="Trend label CHANGED" aria-label="Real label"></div>`;
  const slideC = `<div data-trend-aria-label="Trend label" aria-label="Real label CHANGED"></div>`;
  const fp1 = fingerprintWithSlides([slideA]);
  assert.notEqual(fp1.compositeHash, fingerprintWithSlides([slideB]).compositeHash,
    "data-trend-aria-label change must affect the lock");
  assert.notEqual(fp1.compositeHash, fingerprintWithSlides([slideC]).compositeHash,
    "direct aria-label change must affect the lock");
});

test("aria-labelledby values do not leak into the aria-label channel", () => {
  const slide = `<div aria-labelledby="cap-1"><figcaption id="cap-1">Caption</figcaption></div>`;
  const payload = computeDeckSemanticPayload({
    slideOutputs: [slide],
    content: sampleContent,
    notes: sampleNotes,
    manifest: sampleManifest,
  });
  assert.deepEqual(payload.slides[0].ariaLabels, []);
});

// ---- Frozen content-identity continuity (A07/A13) ----

const identityManifest = () => ({
  schema: "lattice.deck.v1",
  id: "continuity-deck",
  title: "Continuity Deck",
  owner: "qiang",
  presenter: "Qiang Liu",
  runtime: "^0.2.0",
  theme: "simple-light",
  entry: { content: "./content.js", layout: "./layout.js", notes: "./notes.js" },
  assets: "./assets/",
});

const liveV2FromIdentity = (identity, overrides = {}) => ({
  schema: "lattice.deck.v2",
  id: identity.id,
  title: identity.title,
  owner: identity.owner,
  presenter: identity.presenter,
  runtime: identity.runtime,
  theme: identity.theme,
  canvas: { width: 960, height: 540 },
  fps: 30,
  entry: { slides: "./slides.v2.js", ...identity.entry },
  publication: { audience: "private" },
  routes: { main: ["intro", "chart"] },
  assets: identity.assets,
  ...overrides,
});

const migrationReportFor = (identity) => ({
  reportSchema: "lattice.migration-report.v1",
  deckId: identity.id,
  fromSchema: "lattice.deck.v1",
  toSchema: "lattice.deck.v2",
  changedFiles: ["manifest.json"],
  slideIds: ["intro", "chart"],
  contentIdentityManifest: identity,
});

test("resolveContentIdentityManifest verifies against the frozen v1 identity for migrated decks", () => {
  const identity = identityManifest();
  const live = liveV2FromIdentity(identity);
  const resolved = resolveContentIdentityManifest({ liveManifest: live, migrationReport: migrationReportFor(identity), deckId: identity.id });
  assert.equal(resolved.ok, true, JSON.stringify(resolved));
  assert.equal(resolved.identityUsed, true);
  assert.deepEqual(resolved.manifest, identity);
});

test("resolveContentIdentityManifest falls back to the live manifest when no migration report exists", () => {
  const live = liveV2FromIdentity(identityManifest());
  const resolved = resolveContentIdentityManifest({ liveManifest: live, migrationReport: null, deckId: live.id });
  assert.equal(resolved.ok, true);
  assert.equal(resolved.identityUsed, false);
  assert.equal(resolved.manifest, live);
});

test("resolveContentIdentityManifest fails closed on a present-but-invalid migration report", () => {
  const live = liveV2FromIdentity(identityManifest());
  for (const report of [
    {},
    { reportSchema: "lattice.migration-report.v1" },
    { reportSchema: "other", contentIdentityManifest: {} },
    { ...migrationReportFor(identityManifest()), deckId: undefined },
    { ...migrationReportFor(identityManifest()), fromSchema: "lattice.deck.v999" },
    { ...migrationReportFor(identityManifest()), toSchema: "lattice.deck.v999" },
  ]) {
    const resolved = resolveContentIdentityManifest({ liveManifest: live, migrationReport: report, deckId: live.id });
    assert.equal(resolved.ok, false, `report ${JSON.stringify(report)} must not be silently accepted`);
  }
  const wrongDeck = resolveContentIdentityManifest({ liveManifest: live, migrationReport: migrationReportFor(identityManifest()), deckId: "other-deck" });
  assert.equal(wrongDeck.ok, false);
  assert.equal(wrongDeck.reason, "migration-report-deck-mismatch");
});

test("resolveContentIdentityManifest requires the live manifest to be v2 and the identity to be v1", () => {
  const identity = identityManifest();
  const v1Live = resolveContentIdentityManifest({ liveManifest: { ...identity }, migrationReport: migrationReportFor(identity), deckId: identity.id });
  assert.equal(v1Live.ok, false);
  assert.equal(v1Live.reason, "live-manifest-not-v2");

  const badIdentity = migrationReportFor(identity);
  badIdentity.contentIdentityManifest = { ...identity, schema: "lattice.deck.v9" };
  const resolved = resolveContentIdentityManifest({ liveManifest: liveV2FromIdentity(identity), migrationReport: badIdentity, deckId: identity.id });
  assert.equal(resolved.ok, false);
  assert.equal(resolved.reason, "migration-report-identity-not-v1");
});

test("mutations to every pre-existing content-bearing manifest field break continuity (A07)", () => {
  const identity = identityManifest();
  const mutations = {
    id: (live) => ({ ...live, id: "renamed-deck" }),
    title: (live) => ({ ...live, title: "Retitled" }),
    owner: (live) => ({ ...live, owner: "someone-else" }),
    presenter: (live) => ({ ...live, presenter: "Another Presenter" }),
    theme: (live) => ({ ...live, theme: "midnight" }),
    description: (live) => ({ ...live, description: "new copy" }),
    // v1 identity has no sources/references: adding them post-migration is drift.
    sources: (live) => ({ ...live, sources: { note: "added later" } }),
    references: (live) => ({ ...live, references: { note: "added later" } }),
  };
  for (const [field, mutate] of Object.entries(mutations)) {
    const resolved = resolveContentIdentityManifest({
      liveManifest: mutate(liveV2FromIdentity(identity)),
      migrationReport: migrationReportFor(identity),
      deckId: identity.id,
    });
    assert.equal(resolved.ok, false, `mutation of ${field} must break continuity`);
    assert.equal(resolved.reason, "content-identity-continuity-failed");
    assert.ok(resolved.diffs.some((diff) => diff.includes(field)), `diffs must name ${field}: ${JSON.stringify(resolved.diffs)}`);
  }

  // Removing a field the v1 identity had is equally a continuity break.
  const dropped = liveV2FromIdentity(identity);
  delete dropped.owner;
  const removed = resolveContentIdentityManifest({ liveManifest: dropped, migrationReport: migrationReportFor(identity), deckId: identity.id });
  assert.equal(removed.ok, false);
  assert.ok(removed.diffs.includes("owner"));
});

test("publication continuity: no v1 publication maps to exactly { audience: 'private' } (A07)", () => {
  const identity = identityManifest();
  const ok = resolveContentIdentityManifest({ liveManifest: liveV2FromIdentity(identity), migrationReport: migrationReportFor(identity), deckId: identity.id });
  assert.equal(ok.ok, true);

  for (const publication of [
    undefined,
    { audience: "public" },
    { audience: "internal" },
    { audience: "private", rights: "CC-BY-4.0" },
  ]) {
    const resolved = resolveContentIdentityManifest({
      liveManifest: liveV2FromIdentity(identity, { publication }),
      migrationReport: migrationReportFor(identity),
      deckId: identity.id,
    });
    assert.equal(resolved.ok, false, `publication ${JSON.stringify(publication ?? null)} must break the conservative private mapping`);
    assert.ok(resolved.diffs.some((diff) => diff.startsWith("publication")));
  }
});

test("publication continuity: v1 publication metadata must be preserved verbatim (A07)", () => {
  const identity = { ...identityManifest(), publication: { audience: "internal", rights: "internal-only" } };
  const preserved = resolveContentIdentityManifest({
    liveManifest: liveV2FromIdentity(identity, { publication: { audience: "internal", rights: "internal-only" } }),
    migrationReport: migrationReportFor(identity),
    deckId: identity.id,
  });
  assert.equal(preserved.ok, true, JSON.stringify(preserved));

  for (const publication of [
    { audience: "private" },
    { audience: "public" },
    { audience: "internal", rights: "changed" },
  ]) {
    const overwritten = resolveContentIdentityManifest({
      liveManifest: liveV2FromIdentity(identity, { publication }),
      migrationReport: migrationReportFor(identity),
      deckId: identity.id,
    });
    assert.equal(overwritten.ok, false, `overwriting v1 publication with ${JSON.stringify(publication)} must break continuity`);
  }
});

test("contentIdentityContinuityDiffs and publicationContinuityDiff are directly inspectable", () => {
  const identity = identityManifest();
  assert.deepEqual(publicationContinuityDiff(identity, liveV2FromIdentity(identity)), null);
  assert.match(publicationContinuityDiff(identity, liveV2FromIdentity(identity, { publication: { audience: "public" } })), /must be exactly/);
  assert.deepEqual(
    contentIdentityContinuityDiffs(identity, liveV2FromIdentity(identity, { owner: "drifted" })),
    ["owner"],
  );
});
