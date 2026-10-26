#!/usr/bin/env node
import { initCommand } from "./commands/init.js";
import { devCommand } from "./commands/dev.js";
import { buildCommand } from "./commands/build.js";
import { exportCommand } from "./commands/export.js";
import { validateCommand } from "./commands/validate.js";
import { previewCommand } from "./commands/preview.js";
import { inspectCommand } from "./commands/inspect.js";
import { screenshotCommand } from "./commands/screenshot.js";
import { videoCommand } from "./commands/video.js";
import { migrateCommand } from "./commands/migrate.js";
import { ACCUMULATING_FLAGS_BY_COMMAND, parseArgs } from "./args.js";

const commands = {
  init: initCommand,
  dev: devCommand,
  build: buildCommand,
  export: exportCommand,
  validate: validateCommand,
  preview: previewCommand,
  inspect: inspectCommand,
  screenshot: screenshotCommand,
  video: videoCommand,
  migrate: migrateCommand,
};

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === "--help" || command === "help") {
    console.log(`lattice — Slide-first creation, presentation, and multi-format delivery system

Usage:
  lattice init <dir> [--theme <name>] [--example <name>] [--local] [--no-install]
  lattice dev [--port <port>] [--host <host>] [--deck <id>] [--grid] [--open]
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
