import { createHash } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../config/index.js";
import { createProjectModuleLoader } from "../deck-v2/project-module-loader.js";
import {
  DECK_SCHEMA_V2,
  buildMigrationReport,
  loadDeckV2,
  migrateDeckV1ToV2,
  serializeMigrationReport,
  validateManifest,
} from "@55aaseclab/lattice-runtime";

const USAGE = `lattice migrate — explicit lattice.deck.v1 → lattice.deck.v2 migration

Usage:
  lattice migrate --deck <id> [--slide <id>]... [--slides-module <path>]
                  [--report-dir <dir>] [--dry-run]

The migration is the only path from v1 to v2: loaders never silently upgrade
v1 sources. For each deck it
  1. validates the v1 manifest (fail-fast),
  2. captures the current registry buildSlides() output and content lock
     state (fail-fast if the content lock does not already verify),
  3. writes the v2 manifest, the generated slides.v2.js entry, and a
     deterministic migration report under .lattice/migration/,
  4. re-validates the migrated deck and re-verifies the content lock against
     the frozen content-identity manifest before reporting success.

Re-running on an already migrated deck is a verified no-op: the complete v2
deck, the deterministic migration evidence (report, routes/slide ids, slide
digests), and any Content Lock must all still verify before exit 0. Missing,
corrupt, or inconsistent artifacts exit 1 with no writes.
Content-affecting failures exit 1; infrastructure failures exit 2.
`;

/**
 * Idempotent re-run on a v2 deck. Exit 0 is only allowed after validating the
 * complete v2 deck AND its deterministic migration evidence:
 *   1. the slide entry loads and validates (loadDeckV2, incl. route closure),
 *   2. routes.main, the slide entry ids, and the report agree,
 *   3. the migration report exists, is valid, and its frozen slide digests
 *      still match the deck's real buildSlides() output,
 *   4. the frozen content identity has full semantic continuity with the live
 *      v2 manifest, and any existing Content Lock still verifies through it.
 * Every failure exits 1 without writing anything.
 */
async function verifyAlreadyMigratedDeck({ deckId, deckDir, manifest, cwd, config, reportDir }) {
  const fail = (reason) => {
    console.error(`[lattice] deck "${deckId}": ${reason}`);
    process.exit(1);
  };

  const loader = await createProjectModuleLoader(cwd);
  const viteImportModule = async (modulePath) => loader.load(modulePath);
  const closeLoader = async () => {
    try {
      await loader.close();
    } catch {
      // Loader teardown must never mask the real failure.
    }
  };

  // 1. The complete v2 deck must load and validate.
  const loaded = await loadDeckV2(deckDir, { importModule: viteImportModule });
  if (!loaded.ok) {
    await closeLoader();
    console.error(`[lattice] deck "${deckId}" is marked ${DECK_SCHEMA_V2} but fails v2 validation; refusing the no-op:`);
    for (const error of loaded.errors) console.error(`  - [${error.type}] ${error.message}`);
    process.exit(1);
  }

  const definitionIds = loaded.slides.map((slide) => slide.id);
  const routeIds = Array.isArray(loaded.routes?.main) ? loaded.routes.main : null;

  // 2. Routes and slide ids must agree, in order.
  if (!routeIds || JSON.stringify(routeIds) !== JSON.stringify(definitionIds)) {
    await closeLoader();
    fail("routes.main does not match the slide entry definitions; the migrated deck is inconsistent (run validation for details)");
  }

  // 3. The deterministic migration report must exist, be valid, and agree.
  const reportPath = path.join(reportDir, `${deckId}.json`);
  let report;
  try {
    report = JSON.parse(await fs.readFile(reportPath, "utf8"));
  } catch (error) {
    await closeLoader();
    fail(`expected migration report ${path.relative(cwd, reportPath)} is missing or unreadable (${error.message}); migration evidence is incomplete, so a re-run cannot be a verified no-op`);
  }
  if (report?.reportSchema !== "lattice.migration-report.v1" || report?.deckId !== deckId || !report.contentIdentityManifest) {
    await closeLoader();
    fail(`migration report ${path.relative(cwd, reportPath)} is not a valid lattice.migration-report.v1 record for this deck`);
  }
  const identityReport = validateManifest(report.contentIdentityManifest, { expectedId: deckId });
  if (!identityReport.ok) {
    await closeLoader();
    fail(
      `migration report ${path.relative(cwd, reportPath)} does not contain a valid frozen lattice.deck.v1 identity: ` +
        identityReport.errors.map((error) => error.message).join("; "),
    );
  }
  if (JSON.stringify(report.slideIds) !== JSON.stringify(definitionIds) || JSON.stringify(report.routes?.main) !== JSON.stringify(routeIds)) {
    await closeLoader();
    fail("migration report slideIds/routes disagree with the live v2 deck; the migration evidence is inconsistent");
  }

  // Real slide outputs come from the deck's own registry through the vite
  // pipeline, exactly like the original migration run.
  let markupSlides;
  let content;
  let notes;
  try {
    const registryModule = config.registry ? await loader.load(path.resolve(cwd, config.registry)) : null;
    const deckEntry = registryModule?.deckRegistry?.[deckId];
    if (!deckEntry || typeof deckEntry.buildSlides !== "function") {
      await closeLoader();
      fail(`registry has no buildSlides for deck "${deckId}"; cannot verify migration evidence against the real slide outputs`);
    }
    markupSlides = deckEntry.buildSlides();
    if (!Array.isArray(markupSlides) || markupSlides.length === 0) {
      await closeLoader();
      fail(`deck "${deckId}": buildSlides() returned no slides`);
    }
    if (manifest.entry?.content) {
      const contentModule = await loader.load(path.resolve(deckDir, manifest.entry.content));
      content = contentModule.default ?? contentModule;
    }
    if (manifest.entry?.notes) {
      const notesModule = await loader.load(path.resolve(deckDir, manifest.entry.notes));
      notes = notesModule.default ?? notesModule;
    }
  } catch (error) {
    await closeLoader();
    console.error(`[lattice] deck "${deckId}": cannot load deck sources for migration evidence: ${error.message}`);
    process.exit(2);
  }

  // The entry must still wrap today's buildSlides() output byte-for-byte and
  // the frozen digests must still match, so content drift since the migration
  // is caught explicitly instead of silently accepted.
  if (markupSlides.length !== loaded.slides.length) {
    await closeLoader();
    fail(`slide entry has ${loaded.slides.length} definitions but buildSlides() produced ${markupSlides.length}; the deck drifted from its migration evidence`);
  }
  const currentDigests = markupSlides.map((html, index) => ({
    index,
    id: definitionIds[index],
    title: extractSlideTitle(html) ?? "",
    sha256: createHash("sha256").update(html, "utf8").digest("hex"),
  }));
  if (JSON.stringify(report.slideDigests ?? null) !== JSON.stringify(currentDigests)) {
    await closeLoader();
    fail("migration report slide digests no longer match buildSlides() output; deck sources changed after migration");
  }
  for (const [index, slide] of loaded.slides.entries()) {
    if (slide.html !== markupSlides[index]) {
      await closeLoader();
      fail(`slide entry html for "${definitionIds[index]}" is not the deck's buildSlides() output; the migrated entry is inconsistent`);
    }
  }

  // Reconstruct the complete deterministic report from the live, validated
  // deck plus the frozen v1 identity. Exact equality catches corrupted or
  // incomplete metadata (fromSchema/toSchema, changedFiles, reasons,
  // defaults, timing, routes, ids, digests, or unexpected extra fields), not
  // just the subset needed to compute the Content Lock.
  const reportRelative = path.relative(cwd, reportPath).split(path.sep).join("/");
  const expectedReport = buildMigrationReport({
    v1Manifest: report.contentIdentityManifest,
    manifestV2: loaded.manifest,
    slideIds: definitionIds,
    changedFiles: ["manifest.json", "slides.v2.js", reportRelative],
    slideDigests: currentDigests,
  });
  if (serializeMigrationReport(report) !== serializeMigrationReport(expectedReport)) {
    await closeLoader();
    fail("migration report is not the complete deterministic record for the live v2 deck; migration evidence is corrupt or inconsistent");
  }

  // 4. Full frozen identity continuity + Content Lock verification.
  const { verifyContentLock, computeContentFingerprint, resolveContentIdentityManifest } = await import("@55aaseclab/lattice-runtime/content-lock");
  const identityResolution = resolveContentIdentityManifest({ liveManifest: loaded.manifest, migrationReport: report, deckId });
  if (!identityResolution.ok) {
    await closeLoader();
    fail(
      `content identity continuity failed (${identityResolution.reason}${identityResolution.diffs?.length ? `: ${identityResolution.diffs.join(", ")}` : ""}); the live v2 manifest drifted from the frozen v1 content identity`,
    );
  }

  const contentLocksDir = path.resolve(cwd, ".lattice/content-locks");
  const lockPath = path.join(contentLocksDir, `${deckId}.json`);
  if (fsSync.existsSync(lockPath)) {
    const stored = JSON.parse(fsSync.readFileSync(lockPath, "utf8"));
    const fingerprint = computeContentFingerprint(content ?? null, identityResolution.manifest, notes ?? {}, markupSlides);
    const verify = verifyContentLock(fingerprint, stored.fingerprint);
    if (!verify.ok) {
      await closeLoader();
      fail(`Content Lock does not verify against the frozen content identity (${verify.reason}${verify.diffs?.length ? `: ${verify.diffs.join(", ")}` : ""})`);
    }
    console.log(`[lattice] Content Lock for "${deckId}": VERIFY OK (frozen content identity)`);
  }
  await closeLoader();

  console.log(`[lattice] deck "${deckId}" is already ${DECK_SCHEMA_V2} — migration evidence verified, no-op, nothing written.`);
  process.exit(0);
}

export async function migrateCommand({ args }) {
  if (!args.deck || args.deck === true) {
    console.error(USAGE);
    process.exit(2);
  }
  const cwd = process.cwd();
  const config = await loadConfig(cwd);
  const deckId = args.deck;
  const deckDir = path.resolve(cwd, config.decksDir, deckId);
  const dryRun = args["dry-run"] === true;
  const reportDir = path.resolve(cwd, typeof args["report-dir"] === "string" ? args["report-dir"] : ".lattice/migration");

  const manifestPath = path.join(deckDir, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  } catch (error) {
    console.error(`[lattice] cannot read ${manifestPath}: ${error.message}`);
    process.exit(2);
  }

  if (manifest.schema === DECK_SCHEMA_V2) {
    await verifyAlreadyMigratedDeck({ deckId, deckDir, manifest, cwd, config, reportDir });
  }

  const v1Report = validateManifest(manifest, { expectedId: deckId });
  if (!v1Report.ok) {
    console.error(`[lattice] deck "${deckId}" v1 manifest is invalid; fix it before migrating:`);
    for (const error of v1Report.errors) console.error(`  - [${error.type}] ${error.message}`);
    process.exit(1);
  }

  const slidesModule = typeof args["slides-module"] === "string"
    ? args["slides-module"]
    : "./slides.js";
  const slidesModulePath = path.resolve(deckDir, slidesModule);
  if (!fsSync.existsSync(slidesModulePath)) {
    console.error(`[lattice] deck "${deckId}" has no slide module at ${slidesModule} (pass --slides-module)`);
    process.exit(1);
  }

  const slideIds = parseSlideIds(args.slide);
  if (slideIds.length === 0) {
    console.error(
      `[lattice] deck "${deckId}": no slide order provided. Pass the stable slide ids in presentation order:\n` +
      `  lattice migrate --deck ${deckId} --slide <id> --slide <id> ...\n` +
      `The ids become manifest.routes.main and the slideDefinitions ids; the migration report records the full mapping for review.`,
    );
    process.exit(1);
  }

  // Real slide outputs + content/notes come from the deck itself through the
  // vite pipeline (CSS-importing slide modules behave like every other
  // Lattice surface). Everything below fails fast on any mismatch.
  const loader = await createProjectModuleLoader(cwd);
  const viteImportModule = async (modulePath) => loader.load(modulePath);
  let markupSlides;
  let content;
  let notes;
  try {
    const registryModule = config.registry ? await loader.load(path.resolve(cwd, config.registry)) : null;
    const deckEntry = registryModule?.deckRegistry?.[deckId];
    if (!deckEntry || typeof deckEntry.buildSlides !== "function") {
      console.error(`[lattice] registry has no buildSlides for deck "${deckId}"; cannot verify slide outputs before migration.`);
      process.exit(1);
    }
    markupSlides = deckEntry.buildSlides();
    if (!Array.isArray(markupSlides) || markupSlides.length === 0) {
      console.error(`[lattice] deck "${deckId}": buildSlides() returned no slides.`);
      process.exit(1);
    }
    const contentModule = await loader.load(path.resolve(deckDir, manifest.entry.content));
    content = contentModule.default ?? contentModule;
    const notesModule = manifest.entry.notes ? await loader.load(path.resolve(deckDir, manifest.entry.notes)) : { default: {} };
    notes = notesModule.default ?? notesModule;
  } catch (error) {
    await loader.close();
    console.error(`[lattice] deck "${deckId}": cannot load deck sources: ${error.message}`);
    process.exit(2);
  }

  if (markupSlides.length !== slideIds.length) {
    console.error(
      `[lattice] deck "${deckId}": slide id count (${slideIds.length}) does not match buildSlides() output count (${markupSlides.length}); refusing to guess the mapping.`,
    );
    process.exit(1);
  }

  const contentLocksDir = path.resolve(cwd, ".lattice/content-locks");
  const lockPath = path.join(contentLocksDir, `${deckId}.json`);
  const hasLock = fsSync.existsSync(lockPath);
  if (hasLock) {
    const { computeContentFingerprint, verifyContentLock } = await import("@55aaseclab/lattice-runtime/content-lock");
    const stored = JSON.parse(fsSync.readFileSync(lockPath, "utf8"));
    const pre = verifyContentLock(computeContentFingerprint(content, manifest, notes, markupSlides), stored.fingerprint);
    if (!pre.ok) {
      console.error(`[lattice] deck "${deckId}": Content Lock does not verify before migration (${pre.reason}); refusing to migrate a deck whose content is already drifting.`);
      process.exit(1);
    }
  }

  const migrated = migrateDeckV1ToV2({ manifest, slideIds });
  if (!migrated.ok) {
    console.error(`[lattice] migration of deck "${deckId}" failed: ${migrated.reason}`);
    for (const error of migrated.errors) console.error(`  - [${error.type}] ${error.message}`);
    process.exit(1);
  }

  const slideDigests = markupSlides.map((html, index) => ({
    index,
    id: slideIds[index],
    title: extractSlideTitle(html) ?? "",
    sha256: createHash("sha256").update(html, "utf8").digest("hex"),
  }));

  const reportRelative = path.join(path.relative(cwd, reportDir), `${deckId}.json`).split(path.sep).join("/");
  const report = buildMigrationReport({
    v1Manifest: manifest,
    manifestV2: migrated.manifestV2,
    slideIds,
    changedFiles: ["manifest.json", "slides.v2.js", reportRelative],
    slideDigests,
  });

  const slidesV2Source = renderSlidesV2Module({ deckId, slideIds, slidesModule });
  const filesToWrite = [
    { path: path.join(deckDir, "manifest.json"), content: `${JSON.stringify(migrated.manifestV2, null, 2)}\n` },
    { path: path.join(deckDir, "slides.v2.js"), content: slidesV2Source },
    { path: path.join(reportDir, `${deckId}.json`), content: `${serializeMigrationReport(report)}\n` },
  ];

  if (dryRun) {
    console.log(`[lattice] dry run for deck "${deckId}" — no files written.`);
    for (const file of filesToWrite) console.log(`  would write ${path.relative(cwd, file.path)}`);
    console.log(serializeMigrationReport(report));
    process.exit(0);
  }

  try {
    await fs.mkdir(reportDir, { recursive: true });
    for (const file of filesToWrite) {
      await fs.writeFile(file.path, file.content, "utf8");
      console.log(`[lattice] wrote ${path.relative(cwd, file.path)}`);
    }
  } catch (error) {
    console.error(`[lattice] cannot write migration output for "${deckId}": ${error.message}`);
    process.exit(2);
  }

  // Post-migration verification: the deck must load as v2 and the content
  // lock must verify against the frozen content-identity manifest.
  const loaded = await loadDeckV2(deckDir, { importModule: viteImportModule });
  if (!loaded.ok) {
    await loader.close();
    console.error(`[lattice] migrated deck "${deckId}" failed v2 validation:`);
    for (const error of loaded.errors) console.error(`  - [${error.type}] ${error.message}`);
    process.exit(1);
  }

  const postMarkupSlides = markupSlides;
  if (hasLock) {
    const { computeContentFingerprint, verifyContentLock, resolveContentIdentityManifest } = await import("@55aaseclab/lattice-runtime/content-lock");
    const stored = JSON.parse(fsSync.readFileSync(lockPath, "utf8"));
    const identityResolution = resolveContentIdentityManifest({ liveManifest: loaded.manifest, migrationReport: report, deckId });
    if (!identityResolution.ok) {
      await loader.close();
      console.error(
        `[lattice] deck "${deckId}": content identity continuity failed after migration (${identityResolution.reason}${identityResolution.diffs?.length ? `: ${identityResolution.diffs.join(", ")}` : ""})`,
      );
      process.exit(1);
    }
    const post = verifyContentLock(computeContentFingerprint(content, identityResolution.manifest, notes, postMarkupSlides), stored.fingerprint);
    if (!post.ok) {
      await loader.close();
      console.error(`[lattice] deck "${deckId}": Content Lock failed after migration (${post.reason}); diffs: ${(post.diffs ?? []).join(", ")}`);
      process.exit(1);
    }
    console.log(`[lattice] Content Lock for "${deckId}": VERIFY OK (frozen content identity)`);
  }
  await loader.close();

  console.log(`[lattice] migrated deck "${deckId}" to ${DECK_SCHEMA_V2}`);
  console.log(`  slides: ${slideIds.length}, route main: ${slideIds.join(", ")}`);
  console.log(`  report: ${path.relative(cwd, path.join(reportDir, `${deckId}.json`))}`);
  console.log(`  review: confirm slides.v2.js ids and the private publication default before presenting.`);
}

function parseSlideIds(values) {
  if (values === undefined) return [];
  const list = Array.isArray(values) ? values : [values];
  return list.map((value) => String(value)).filter((value) => value !== "");
}

function extractSlideTitle(html) {
  const match = String(html).match(/<h[12][^>]*>([^<]{1,120})</);
  return match ? match[1].trim() : null;
}

function renderSlidesV2Module({ deckId, slideIds, slidesModule }) {
  const ids = slideIds.map((id) => JSON.stringify(id)).join(",\n  ");
  return `// Generated by \`lattice migrate\` (lattice.deck.v1 -> lattice.deck.v2).
// Structural timing only: slide content stays in ${slidesModule}; this module
// wraps each buildSlides() output with its stable slide id and integer-frame
// timing for the canonical v2 slide contract. Regenerating this file is
// deterministic; edit the deck's own sources, not this wrapper.
import { buildSlides } from ${JSON.stringify(slidesModule)};

const SLIDE_IDS = [
  ${ids},
];

const STATIC_TIMING = Object.freeze({
  durationFrames: 1,
  stops: Object.freeze([{ id: "static", frame: 0, navigation: "jump" }]),
});

const outputs = buildSlides();
if (outputs.length !== SLIDE_IDS.length) {
  throw new Error(
    \`deck "${deckId}": slide count \${outputs.length} does not match SLIDE_IDS length \${SLIDE_IDS.length}; rerun lattice migrate\`,
  );
}

export const slideDefinitions = outputs.map((html, index) => ({
  id: SLIDE_IDS[index],
  html,
  durationFrames: STATIC_TIMING.durationFrames,
  stops: STATIC_TIMING.stops.map((stop) => ({ ...stop })),
}));
`;
}
