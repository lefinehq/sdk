# @lefine/mcp

Lefine for AI agents. Claude, Cursor and other MCP clients can translate your app, edit and publish
website pages, and make localized videos, with you approving anything that goes live.

## Set it up

```sh
npx @lefine/mcp
```

That opens the setup wizard (the same as `npx lefine setup`). It finds your AI apps (Claude Code, Cursor,
VS Code, Windsurf, Codex, Gemini CLI, Zed), adds the Lefine server to the ones you pick, checks that the server
answers, and tells you the one click each app needs to sign in. It can read and edit; it asks you before it
publishes (unless you turn that off in Lefine settings). Claude Desktop and ChatGPT take a URL in their own
settings, so for them it prints the steps (Settings > Connectors > Add custom connector) and writes no file.

```sh
npx @lefine/mcp --list      # where Lefine is set up
npx @lefine/mcp --doctor    # old entries, a blocked server, no claude command, server not reachable
npx @lefine/mcp --remove    # take Lefine out again
npx @lefine/mcp --yes --readonly   # no questions, read-only access
```

Without a terminal (an agent or CI runs it) the command prints one JSON object with a `next` command.
`setup`, `--client`, `--readonly`, `--project`, `--print` and `--no-backup` work as in `npx lefine setup`.

An AI app that starts `npx -y @lefine/mcp` as its server keeps working: when stdin is not a terminal this
package is the stdio server, as before.

## Sign in (local server only)

The remote server needs no key: the app opens a browser page and you approve there. Only the local server
(`npx -y lefine mcp`, for clients that start a process) uses a key:

```sh
npx lefine login
```

Or set `LEFINE_TOKEN` to a key from Lefine, Settings > API keys. To let the agent reach Content,
Studio or your connected apps, make the key there and tick them under "Also reach".

## By hand

**Claude Desktop** (`claude_desktop_config.json` only starts local servers), and any client that starts a
local process:

```json
{
  "mcpServers": {
    "lefine": { "command": "npx", "args": ["-y", "lefine", "mcp"] }
  }
}
```

**Remote-capable clients** connect to the server directly. They sign in with OAuth, so there is no key to copy:

```sh
claude mcp add --transport http --scope user lefine https://dash.lefine.ai/v1/mcp
```

Then type `/mcp` in Claude Code, pick lefine and choose Authenticate. In Claude Desktop, Claude on the web
and ChatGPT add the same URL under Settings > Connectors > Add custom connector. For read-only access use
`https://dash.lefine.ai/v1/mcp?level=read`.

## What the agent gets

Up to seven tools. The agent sees only the ones the key can use:

| Tool | What it does |
|---|---|
| `lefine_context` | The workspace, the modules that are on, and what the key may do. |
| `lefine_find` | Find an action by words, with its input schema. |
| `lefine_read` | Run an action that only reads. |
| `lefine_write` | Run an action that writes drafts. Nothing goes live. |
| `lefine_publish` | Run an action that goes live or spends credits. It asks you first. |
| `lefine_launch` | Take the workspace into a new market in one run, like "launch in Japanese". It drafts the work and shows one diff. Nothing goes live until you approve it in Lefine. |
| `lefine_launch_status` | Read a launch: its steps, its diff, and whether it waits for your yes. |

Every action, with what it needs: run `npx lefine actions` (add words to filter, e.g. `npx lefine actions content`).

The tools live on Lefine's server, so a new action reaches you without updating this package.

## Options

- `LEFINE_TOKEN`: the key to use (wins over the saved one).
- `LEFINE_API_URL`: another Lefine server. A saved key is only sent to the server it was saved for.
- `lefine-mcp --version`, `lefine-mcp --help`.

Logs go to stderr; stdout carries only MCP messages.

## Two tools for coding agents

`npx lefine mcp` (and this alias) add two tools next to the server's, answered on your machine:

- `lefine_find_similar_key`: keys whose name or source text is like the one you want, closest first, each with its `keyId`. Agents call it first.
- `lefine_add_key`: adds one key with its source text, and refuses with the reason when the key exists in any namespace,
  the same text already has a key, the namespace does not exist (`newNamespace: true` to make one), or the text is not
  valid ICU. When the key exists, the answer points at the server's `strings.keys.update` (change its text or description)
  and `strings.translations.set` (one translation); both ask a person first. A new key is not live until someone publishes.
