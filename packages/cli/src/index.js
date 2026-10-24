#!/usr/bin/env node
import { initCommand } from "./commands/init.js";
import { devCommand } from "./commands/dev.js";
import { buildCommand } from "./commands/build.js";
import { exportCommand } from "./commands/export.js";
import { validateCommand } from "./commands/validate.js";
import { previewCommand } from "./commands/preview.js";
import { inspectCommand } from "./commands/inspect.js";
import { screenshotCommand } from "./commands/screenshot.js";

const commands = {
  init: initCommand,
  dev: devCommand,
  build: buildCommand,
  export: exportCommand,
  validate: validateCommand,
  preview: previewCommand,
  inspect: inspectCommand,
  screenshot: screenshotCommand,
};

function parseArgs(argv) {
  const args = {};
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        args[key] = next;
        index += 1;
      } else {
        args[key] = true;
      }
    } else {
      rest.push(token);
    }
  }
  return { args, rest };
}

async function main() {
  const [command, ...argv] = process.argv.slice(2);
  if (!command || command === "--help" || command === "help") {
    console.log(`lattice — native slide system

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
  lattice preview [--port <port>] [--host <host>]

"lattice inspect --rendered" launches headless Chromium, waits for the deck's
app-ready signal plus fonts and image decode, and collects
overflow/contrast/density findings as a JSON artifact. --rendered is the
canonical form (PRD 3.1.4); bare "lattice inspect" is a compatibility alias.
Unknown options are rejected. Exit code 1 marks blocking findings (including
uncaught page errors and ready timeouts), 2 an infrastructure error (e.g. no
Chromium found); stdout always carries the JSON report. console.error noise is
recorded as diagnostics only.
`);
    return;
  }
  const handler = commands[command];
  if (!handler) {
    console.error(`[lattice] unknown command: ${command}`);
    process.exit(1);
  }
  const { args, rest } = parseArgs(argv);
  await handler({ args, rest });
}

main().catch((error) => {
  console.error(`[lattice] ${error.message}`);
  process.exit(1);
});
