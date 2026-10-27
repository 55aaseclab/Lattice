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
import { migrateCommand } from "./commands/migrate.js";
import { editCommand } from "./commands/edit.js";
import { lockCommand } from "./commands/lock.js";
import { templateCommand } from "./commands/template.js";
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
  migrate: migrateCommand,
  edit: editCommand,
  lock: lockCommand,
  template: templateCommand,
};

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === "--help" || command === "help") {
    console.log(`lattice — Slide-first creation, presentation, and multi-format delivery system

Usage:
  lattice init <dir> [--theme <name>] [--example <name>] [--local] [--no-install]
  lattice dev [--port <port>] [--host <host>] [--deck <id>] [--grid] [--open]
  lattice present --deck <id> [--route <name>] [--presenter] [--port <port>] [--host <host>] [--open]
  lattice validate [--deck <id>]
  lattice inspect --rendered [--deck <id>] [--out <file>] [--timeout <ms>]
                  [--browser <path>] [--base-url <url>] [--port <port>] [--host <host>]
  lattice screenshot [--deck <id>] [--update-baseline] [--baseline-dir <dir>]
                     [--out <dir>] [--report <file>] [--max-diff-ratio <n>] [--timeout <ms>]
  lattice build [--out <dir>]
  lattice export --deck <id> [--out <dir>] [--skip-build]
  lattice migrate --deck <id> [--slide <id>]... [--slides-module <path>]
                  [--report-dir <dir>] [--dry-run]
  lattice preview [--port <port>] [--host <host>]
  lattice video plan --deck <id> [--route <name>] [--bundle-dir <dir>] [--output <path>]
  lattice video doctor --backend remotion|hyperframes
  lattice video still --deck <id> --backend <id> --frame <n> [--output <path>]
  lattice video render --deck <id> --backend <id> [--output <path>]
  lattice template list
  lattice template show <template-id>
  lattice template scaffold <template-id> --deck <deckId> [--title <t>] [--stages <n>]
                            [--dry-run] [--force] [--no-registry-update]
  lattice edit --deck <id> --slide <slideId> --field <path> --value <json>
               [--dry-run] [--reason <text>] [--actor <id>] [--timestamp <iso>]
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

Exit codes: 0=success, 1=content/validation failure, 2=configuration or
infrastructure failure.

"lattice present --deck <id>" starts the project server and opens the
Lattice Presentation for one lattice.deck.v2 deck: page/step navigation,
jump/play stops, branches, presenter notes, URL restore. It requires no
video backend installed or initialized; a v1 deck fails with explicit
migration guidance instead of being silently presented.

"lattice inspect --rendered" launches headless Chromium, waits for the deck's
app-ready signal plus fonts and image decode, and collects
overflow/contrast/density findings as a JSON artifact. --rendered is the
canonical form; bare "lattice inspect" is a compatibility alias.
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
