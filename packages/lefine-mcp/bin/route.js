// Which `lefine` command an `npx @lefine/mcp ...` call means. Pure, so a test can read it.
//
//   started by an AI app (stdin is not a terminal), or `mcp`: the stdio server, as always
//   `setup` and its flags (--remove --list --doctor --print --yes ...): the setup wizard, same as `lefine setup`
//   no arguments in a terminal: the setup wizard (a person typed `npx @lefine/mcp`)
const SETUP_FLAGS = new Set(["--remove", "--list", "--doctor", "--print", "--yes", "-y", "--client", "--readonly", "--project", "--local", "--json", "--no-backup", "--no-check", "--api-url"]);

/** Arguments to hand to the `lefine` bin, after node and the script. */
export function routeArgs(args, { stdinIsTTY, stdoutIsTTY }) {
  const [first] = args;
  if (first === "setup") return args;
  if (first === "mcp") return args;
  if (first !== undefined && SETUP_FLAGS.has(first.split("=")[0])) return ["setup", ...args];
  if (args.length === 0 && stdinIsTTY && stdoutIsTTY) return ["setup"];
  return ["mcp", ...args];
}
