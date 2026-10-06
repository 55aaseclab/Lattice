import { initCommand } from "./commands/init.js";
import { devCommand } from "./commands/dev.js";
import { buildCommand } from "./commands/build.js";
import { exportCommand } from "./commands/export.js";
import { validateCommand } from "./commands/validate.js";
import { previewCommand } from "./commands/preview.js";

const commands = {
  init: initCommand,
  dev: devCommand,
  build: buildCommand,
  export: exportCommand,
  validate: validateCommand,
  preview: previewCommand,
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
  lattice init <dir> [--theme <name>] [--example <name>] [--no-install]
  lattice dev [--port <port>] [--host <host>] [--deck <id>] [--grid] [--open]
  lattice validate [--deck <id>]
  lattice build [--out <dir>]
  lattice export --deck <id> [--out <dir>] [--skip-build]
  lattice preview [--port <port>] [--host <host>]`);
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
