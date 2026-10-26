// Shared CLI argument parsing.
//
// Pre-M1 behavior: every repeated option keeps its LAST value
// ("lattice validate --deck a --deck b" validates "b"). The only accumulating
// flag in the whole CLI is `lattice migrate --slide <id>` — a slide order is
// inherently a list. Any new accumulating flag must be added here explicitly,
// never by accident.

export const ACCUMULATING_FLAGS_BY_COMMAND = new Map([
  ["migrate", new Set(["slide"])],
]);

export function parseArgs(argv, { accumulate = new Set() } = {}) {
  const args = {};
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith("--")) {
        if (accumulate.has(key)) {
          if (args[key] === undefined) args[key] = next;
          else if (Array.isArray(args[key])) args[key].push(next);
          else args[key] = [args[key], next];
        } else {
          // Last value wins (pre-M1 behavior).
          args[key] = next;
        }
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
