# @lefine/mcp

Lefine for AI agents. Claude, Cursor and other MCP clients can translate your app, edit and publish
website pages, and make localized videos, with you approving anything that goes live.

## Sign in

```sh
npx lefine login
```

Or set `LEFINE_TOKEN` to a key from Lefine, Settings > API keys. To let the agent reach Content,
Studio or your connected apps, make the key there and tick them under "Also reach".

## Add it to your client

**Claude Desktop** (`claude_desktop_config.json`), and any client that starts a local server:

```json
{
  "mcpServers": {
    "lefine": { "command": "npx", "args": ["-y", "lefine", "mcp"] }
  }
}
```

**Claude, ChatGPT, Claude Code, Cursor, VS Code and other remote-capable clients** can skip this
package and connect to the server directly. They sign in to Lefine with OAuth, so there is no key to
copy:

```sh
claude mcp add --transport http lefine https://dash.lefine.ai/v1/mcp
```

In Claude, add the same URL under Settings > Connectors > Add custom connector. A key also works:
add `--header "Authorization: Bearer <key>"`.

## What the agent gets

Five tools, whatever your plan:

| Tool | What it does |
|---|---|
| `lefine_context` | The workspace, the modules that are on, and what the key may do. |
| `lefine_find` | Find an action by words, with its input schema. |
| `lefine_read` | Run an action that only reads. |
| `lefine_write` | Run an action that writes drafts. Nothing goes live. |
| `lefine_publish` | Run an action that goes live or spends credits. It asks you first. |

Every action, with what it needs: run `npx lefine actions` (add words to filter, e.g. `npx lefine actions content`).

The tools live on Lefine's server, so a new action reaches you without updating this package.

## Options

- `LEFINE_TOKEN`: the key to use (wins over the saved one).
- `LEFINE_API_URL`: another Lefine server. A saved key is only sent to the server it was saved for.
- `lefine-mcp --version`, `lefine-mcp --help`.

Logs go to stderr; stdout carries only MCP messages.

## Two tools for coding agents

`npx lefine mcp` (and this alias) add two tools next to the server's, answered on your machine:

- `lefine_find_similar_key`: keys whose name or source text is like the one you want, closest first. Agents call it first.
- `lefine_add_key`: adds one key with its source text, and refuses with the reason when the key exists in any namespace,
  the same text already has a key, the namespace does not exist (`newNamespace: true` to make one), or the text is not
  valid ICU. A new key is not live until someone publishes.
