# @lefine/mcp

Lefine as an MCP server for Claude, Cursor, VS Code, Codex and other AI apps. It does two things:

1. **Passes through** Lefine's tools (`https://dash.lefine.ai/v1/mcp`) with your sign-in, so the agent can
   translate your app, edit pages and drafts, and launch new markets. The list comes from the server, so a
   new action reaches you without updating this package.
2. **Adds local tools** that only a process on your machine can offer: upload a picture or a whole folder,
   import your translation files, and read which Lefine project a code folder belongs to.

Nothing goes live without a person: publishing asks first, in the app or on a Lefine approval page.

## Install

```sh
npx @lefine/mcp          # in a terminal: the setup wizard
```

The wizard finds your AI apps (Claude Code, Cursor, VS Code, Windsurf, Codex, Gemini CLI, Zed), adds Lefine to
the ones you pick, checks that the server answers and tells you the one click each app needs to sign in.
`--list`, `--doctor`, `--remove`, `--yes`, `--readonly`, `--project`, `--print` work as in `npx lefine setup`.

To run it as a server by hand, in a client config that starts a process (Claude Desktop, some IDEs):

```json
{ "mcpServers": { "lefine": { "command": "npx", "args": ["-y", "@lefine/mcp"] } } }
```

When stdin is not a terminal (an AI app started it) this package is the stdio server. Existing configs that say
`npx -y @lefine/mcp` or `npx -y lefine mcp` keep working. Needs Node 20 or newer.

**Sign in** with `npx @lefine/mcp setup` (or `npx lefine login`), or set `LEFINE_TOKEN` to a key from
Lefine, Settings > API keys. Tick Content or Studio on the key if the agent needs them.

## Tools

From the server (always in sync, listed with `tools/list` and kept for 5 minutes):

| Tool | What it does |
|---|---|
| `lefine_context` | The workspace, the modules that are on, what the key may read, write and publish. Call it first. |
| `lefine_find` | Find an action by words, with its input schema. |
| `lefine_lookup` | Find a page, key, media file, app, project, type or global by name ("z5k privacy page"). |
| `lefine_read` | Run an action that only reads. |
| `lefine_write` | Run an action that writes drafts. Nothing goes live. `steps` runs up to 50 at once. |
| `lefine_publish` | Run an action that goes live. Asks a person first; a batch is one yes for the exact list. |
| `lefine_edit` | Change fields of one page, global or key by name, as a draft. `dryRun` shows the diff. |
| `lefine_launch`, `lefine_launch_status` | Take the workspace into a new market; read how it went. |

Added here, answered on your machine:

| Tool | What it does |
|---|---|
| `lefine_project` | Reads `lefine.ts` and `lefine.config.*` in the working folder (as text, never run) for the app and project ids, so the agent does not ask you. |
| `lefine_upload_file` `{path, project?, alt?, folder?}` | One png, jpg, gif, webp, avif, mp4 or PDF (not svg) to a Content project's media library. Answers `mediaId` and `url`. |
| `lefine_upload_folder` `{path, project?, pattern?, skip?}` | Up to 50 files per call, 4 at a time, as a table. `pattern` is a glob (`*` top level, `**/*.png` deep). `skip` takes the next batch. |
| `lefine_import_locale_files` `{path, app?, format?, locale?, namespace?, dryRun?, confirmPlan?}` | `.json` `.arb` `.yaml` `.yml` `.xml` `.xlf` `.xliff` `.properties` `.po` files into a Strings app. First call is a dry run: counts and a plan id, nothing written. The second call (`dryRun: false`) is a normal Lefine write: the server may ask a person to approve it. `confirmPlan` is only the plan id (a stale one stops the import), not an approval. Imports are drafts. |
| `lefine_find_similar_key`, `lefine_add_key` | For coding agents: find a key before adding one; add refuses duplicates and bad ICU. |

`project` and `app` take a name, a slug or an id; an unclear name lists the candidates. Left out, they come from
`lefine.config.*` / `lefine.ts` in the working folder, or the workspace's only project.

## Flags

```
--read-only             Only reading tools. Hides write, publish, edit, launch and the local write tools,
                        and asks the server for a read ceiling (?level=read), so a tool this package does
                        not know still cannot write.
--toolsets=a,b          Only these modules: strings, content, studio, social, sites, brain, integrations.
                        Actions of other modules are refused; local tools of other modules are hidden.
--allow-dir <folder>    Let local tools read this folder too (repeatable).
--tools-ttl <seconds>   How long the server's tool list is kept (default 300; 0 asks every time).
--version, --help
```

Environment: `LEFINE_TOKEN`, `LEFINE_API_URL`, `LEFINE_PROFILE`, `LEFINE_MCP_READ_ONLY=1`,
`LEFINE_MCP_TOOLSETS`, `LEFINE_MCP_ALLOW_DIRS`, `LEFINE_MCP_TOOLS_TTL`. Logs go to stderr; stdout carries only
MCP messages.

## Security

What the local tools can read and write, exactly:

- **Read: only inside the folder the server runs in**, plus each `--allow-dir`. `../`, absolute paths elsewhere and
  symlinks that lead out are refused. In any letter case, `.git`, `.ssh`, `.aws`, `.gnupg`, `.kube`, `.docker`,
  `.config`, `.lefine`, `node_modules`, `.env*`, `.git-credentials`, `.pgpass`, `.netrc`, `.npmrc`, `.pypirc`,
  `.htpasswd`, `id_rsa*`, `id_ed25519*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, shell history and `credentials*` are never
  read, even inside an allowed folder.
- **No broad root.** If the server starts in `/`, your home directory or a parent of it (`/Users`, `/home`), the local
  file tools are off (one line on stderr) until you pass `--allow-dir <project folder>`. `--allow-dir` itself is
  refused for `/`, home, its parents, `~/.ssh`, `~/.aws` and the like.
- **Which files:** uploads take png, jpg, gif, webp, avif, mp4 and PDF (not svg), 8 MB, and the first bytes must
  match the name. Locale import takes only `.json .arb .yaml .yml .xml .xlf .xliff .properties .po`; `format`
  chooses the parser and never widens what is read.
- **Write: only through the server.** The local tools never call a write on the API themselves. Uploads, imports and
  `lefine_add_key` are sent as the server's own `lefine_write` call, so the server's approvals (a person says yes in
  Lefine), its MCP ledger and the `--read-only` ceiling apply. The dry run of an import stays local and writes
  nothing. A plan id is not consent.
- **The key stays on your machine.** It goes only to the server it was saved for and never appears in tool
  output. `lefine.ts` and `lefine.config.*` are read as text: a cloned repository cannot run code by starting
  this server. Text from your files is marked as data in answers; do not let an agent treat it as instructions.
- **Publishing asks a person first,** unless you turned that off in Lefine settings.
- Not covered: a folder renamed between the path check and the read could redirect the open. Someone who can
  do that already has your account's files.

A 401 means the key is wrong or expired: run `npx @lefine/mcp setup`.

## Remote, without this package

Clients that speak remote MCP can skip the package and sign in with OAuth, no key to copy:

```sh
claude mcp add --transport http --scope user lefine https://dash.lefine.ai/v1/mcp
```

Then `/mcp` in Claude Code, pick lefine, Authenticate. Read-only: `https://dash.lefine.ai/v1/mcp?level=read`.
The local tools above need this package, because the remote server cannot see your disk.

Every action and what it needs: `npx lefine actions` (add words to filter).
