// `--version` and `--help` of the `lefine-mcp` bin: its own name and version, and the flags the server takes.
// Pure, so a test can read it. Only as the first argument: `setup --help` still belongs to `lefine setup`.

export const HELP = `lefine-mcp: Lefine's MCP server and setup (npx @lefine/mcp)

Usage:
  npx @lefine/mcp                  in a terminal: the setup wizard
  npx @lefine/mcp setup [flags]    add Lefine to your AI apps (--list, --remove, --doctor, --print, --yes, --client <name>, --readonly, --project)
  npx @lefine/mcp [flags]          started by an AI app (stdin is not a terminal): the stdio server

Server flags:
  --read-only             only reading tools (also asks the server for a read ceiling)
  --toolsets <list>       only these modules, comma separated (strings, content, studio, social, sites, brain, integrations)
  --allow-dir <dir>       a folder besides the working folder that local tools may read (repeatable)
  --tools-ttl <seconds>   how long the server's tool list is kept (default 300)
  --version, --help

Sign in:      npx @lefine/mcp setup     (or npx lefine login, or set LEFINE_TOKEN)
Environment:  LEFINE_TOKEN, LEFINE_API_URL, LEFINE_PROFILE, LEFINE_MCP_READ_ONLY=1, LEFINE_MCP_TOOLSETS,
              LEFINE_MCP_ALLOW_DIRS, LEFINE_MCP_TOOLS_TTL
Publishing: an API key publishes right away unless Agent approvals is on in Lefine settings.
Logs go to stderr; stdout carries only MCP messages.
`;

/** What to print for `--version` / `--help` as the first argument, or null when the call is something else. */
export function metaOutput(args, version) {
  const [first] = args;
  if (first === "--version" || first === "-v") return `${version}\n`;
  if (first === "--help" || first === "-h") return HELP;
  return null;
}
