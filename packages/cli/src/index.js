#!/usr/bin/env node
import { initCommand } from "./commands/init.js";
import { devCommand } from "./commands/dev.js";
import { presentCommand } from "./commands/present.js";
import { buildCommand } from "./commands/build.js";
import { exportCommand } from "./commands/export.js";
import { validateCommand } from "./commands/validate.js";
import { previewCommand } from "./commands/preview.js";
import { inspectCommand } from "./commands/inspect.js";
import { screenshotCommand } from "./commands/screenshot.js";
import { videoCommand } from "./commands/video.js";
import { audioCommand } from "./commands/audio.js";
import { audienceCommand } from "./commands/audience.js";
import { migrateCommand } from "./commands/migrate.js";
import { editCommand } from "./commands/edit.js";
import { lockCommand } from "./commands/lock.js";
import { templateCommand } from "./commands/template.js";
import { deckCommand } from "./commands/deck.js";
import { ACCUMULATING_FLAGS_BY_COMMAND, parseArgs } from "./args.js";

const commands = {
  init: initCommand,
  dev: devCommand,
  present: presentCommand,
  build: buildCommand,
  export: exportCommand,
  validate: validateCommand,
  preview: previewCommand,
  inspect: inspectCommand,
  screenshot: screenshotCommand,
  video: videoCommand,
  audio: audioCommand,
  audience: audienceCommand,
  migrate: migrateCommand,
  edit: editCommand,
  lock: lockCommand,
  template: templateCommand,
  deck: deckCommand,
};

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === "--help" || command === "help") {
    console.log(`lattice — Slide-first creation, presentation, and multi-format delivery system

Usage:
  lattice init <dir> [--theme <name>] [--example <name>] [--local] [--no-install]
  lattice dev [--port <port>] [--host <host>] [--deck <id>] [--grid] [--open] [--no-portal]
  lattice present --deck <id> [--route <name>] [--presenter] [--port <port>] [--host <host>] [--open]
  lattice validate [--deck <id>]
  lattice inspect --rendered [--deck <id>] [--out <file>] [--timeout <ms>] [--lint]
                  [--browser <path>] [--base-url <url>] [--port <port>] [--host <host>]
  lattice screenshot [--deck <id>] [--update-baseline] [--baseline-dir <dir>]
                     [--out <dir>] [--report <file>] [--max-diff-ratio <n>] [--timeout <ms>]
  lattice build [--out <dir>]
  lattice export --deck <id> [--out <dir>] [--skip-build]
  lattice migrate --deck <id> [--slide <id>]... [--slides-module <path>]
                  [--report-dir <dir>] [--dry-run]
  lattice preview [--port <port>] [--host <host>]
  lattice video plan --deck <id> [--route <name>] [--bundle-dir <dir>] [--output <path>]
  lattice video presets
  lattice video doctor --backend remotion|hyperframes
  lattice video still --deck <id> --backend <id> --frame <n> [--output <path>]
  lattice video still --deck <id> --backend <id> --frames <n,n,...> [--output <dir>]
  lattice video render --deck <id> --backend <id> [--output <path>]
  lattice audio voices
  lattice audio narrate --deck <id> [--voice <name>] [--speed <n>]
  lattice audio bgm --deck <id> --style ambient --seed <n> | --src <file>
  lattice audience pack --deck <id> [--out <dir>] [--skip-lint] [--stills none|full]
  lattice audience session --deck <id> init|append|check
  lattice audience personas
  lattice audience verify --review <file>
  lattice template list
  lattice template show <template-id>
  lattice template scaffold <template-id> --deck <deckId> [--title <t>] [--stages <n>]
                            [--dry-run] [--force] [--no-registry-update]
  lattice deck budget --deck <id> [--unit zh|en]
  lattice edit --deck <id> --slide <slideId> --field <path> --value <json>
               [--dry-run] [--reason <text>] [--actor <id>] [--timestamp <iso>]
  lattice edit --deck <id> --structure add --slide <newId> [--after <id>]
               [--value <json>] [--notes <text>] [shared options]
  lattice edit --deck <id> --structure remove --slide <id> [shared options]
  lattice edit --deck <id> --structure reorder --value <json-id-array> [shared options]
  lattice lock verify [--deck <id>]
  lattice lock update [--deck <id>] [--actor <id>] [--reason <text>]

Prompt-driven authoring (M6) — the machine-consumable convergence loop:

  "lattice template scaffold" starts a new deck from a formal template built
  on a shared runtime Theme (structure only, never business content).
  "lattice edit" performs one minimal, auditable edit to a deck's canonical
  content source: stable slide id + field path → exact byte-range replacement,
  with a provenance record (who/when/input hash/output hash/source map) per
  applied edit and --dry-run for zero-write preview. On any deck with a
  stored Content Lock, an edit that would change the frozen fingerprint is
  rejected before a single byte is written. After an applied edit the loop
  runs automatically: fresh deck re-import, fingerprint recomputation, and
  "lattice validate". Every command in the loop is deterministic, JSON-out,
  and machine-consumable via exit codes (0 ok, 1 refused/failed, 2
  configuration or infrastructure failure):

    lattice lock update --deck <id>   # freeze content once final
    lattice edit --deck <id> --slide <id> --field <path> --value <json>
    lattice lock verify --deck <id>   # prove the freeze still holds
    lattice validate --deck <id>

Video commands (M3):
  "lattice video plan" compiles an engine-neutral integer-frame VideoPlan
without requiring any video backend installed or initialized. It validates
the selected route from the descriptor routes map (--route, default "main"),
linearises slides into non-overlapping clips, computes totalFrames, bakes
provenance from real deck sources and a real Slide Web Bundle identity, and
writes deterministic canonical JSON.
  "lattice video doctor" inspects the selected backend environment. It reports
tool presence, versions, paths, and install guidance. It never installs
dependencies.
  "lattice video presets" prints the theme's machine-readable stop-reveal
animation preset catalog. "lattice edit --timeline <path>" edits a deck's
lattice.timeline.v1 declaration (segment durations, stop frames, animation
presets, audio tracks) through the same auditable loop as content edits.
  The video workbench is a portal route (issue 005): open "lattice dev" and
visit /workbench/<deck-id> for that deck's timeline visualization
(narration/bgm dual audio tracks), backend doctor, queued rendering,
Slide-Runtime timeline preview, and artifact download. The scoped view shows
exactly one deck (plus a "← Portal" link); /workbench alone is the deck
picker fallback. No second port is opened and no workbench process is
spawned — the route is served by the portal process itself.

Exit codes: 0=success, 1=content/validation failure, 2=configuration or
infrastructure failure.

"lattice deck budget --deck <id>" is the deterministic depth-budget judge
(V2.0.31): it resolves the deck's library template, measures every page
against that template's machine-readable budgets (transcribed from the genre
skill's depth-budget table), and reports per-page pass/violation with the
exact shortfall or excess. Templates without budgets are never blocked.

"lattice present --deck <id>" starts the project server and opens the
Lattice Presentation for one lattice.deck.v2 deck: page/step navigation,
jump/play stops, branches, presenter notes, URL restore. It requires no
video backend installed or initialized; a v1 deck fails with explicit
migration guidance instead of being silently presented.

"lattice inspect --rendered" launches headless Chromium, waits for the deck's
app-ready signal plus fonts and image decode, and collects
overflow/contrast/density findings as a JSON artifact. --rendered is the
canonical form; bare "lattice inspect" is a compatibility alias. Without
--lint, the per-deck visual lint report (lattice.lint.v1: canvas text
overflow, out-of-bounds elements, typography anomalies below the theme's
readability tokens) is advisory; --lint promotes it to a blocking exit code.

"lattice dev" is the single local web portal: the deck list with per-deck
status (validate / lint / lock / provenance), the viewer and present
entries, read-only review views of the agent's provenance history, and the
video workbench as a deck-scoped portal route (/workbench/<deck-id>), served
by the same process — no workbench port or subprocess; video code is loaded
dynamically only when a workbench route is hit (A35 load boundary).
--no-portal keeps the bare deck server.
`);
    return;
  }
  const handler = commands[command];
  if (!handler) {
    console.error(`[lattice] unknown command: ${command}`);
    process.exit(1);
  }
  const { args, rest } = parseArgs(argv, {
    accumulate: ACCUMULATING_FLAGS_BY_COMMAND.get(command) ?? new Set(),
  });
  await handler({ args, rest });
}

main().catch((error) => {
  console.error(`[lattice] ${error.message}`);
  process.exit(1);
});
