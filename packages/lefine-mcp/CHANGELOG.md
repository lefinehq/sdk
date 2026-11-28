# @lefine/mcp

## 1.0.0-rc.3

### Patch Changes

- The server tells you when a newer `@lefine/mcp` is out: one line on stderr and one sentence in the `instructions` it sends the AI app, so the app can say "restart me". It compares this package's own version with its npm tag (a prerelease with `next` or `latest`, whichever is higher), at most once a day, never on stdout, off in CI and with `LEFINE_NO_UPDATE_CHECK=1`. Depends on `lefine ^0.11.2`.
- `npx @lefine/mcp@next setup --local` writes `npx -y @lefine/mcp@next` into your AI apps, so a restart fetches the newest version. Config lines that say `npx -y @lefine/mcp` (no tag) keep npx's cached copy; `setup --doctor` flags them.

## 1.0.0-rc.2

### Patch Changes

- Depends on `lefine ^0.11.1` (the import reply says what was saved). First release published from GitHub Actions with npm trusted publishing (OIDC, no token).

## 1.0.0-rc.1

### Patch Changes

- Fixes rc.0, which was packed with a stale lockfile and asked for `lefine ^0.10.0` (no `--read-only`, `--toolsets`, `--allow-dir` or local tools). This version depends on `lefine ^0.11.0`, and the release script now refuses a tarball whose `workspace:` ranges are not the workspace's current versions.
- `npx @lefine/mcp --version` prints this package's version, and `--help` says `lefine-mcp`, with the server flags and environment variables listed.
- README: says plainly that a connected AI app asks a person before it publishes, and an API key (`LEFINE_TOKEN`) publishes right away unless Agent approvals is on in Lefine settings (off by default).

## 1.0.0-rc.0

### Major Changes

- A real MCP server package, not just an entry point. Started by an AI app (stdin is not a terminal) it passes Lefine's remote tools through from `https://dash.lefine.ai/v1/mcp` with your sign-in (saved login or `LEFINE_TOKEN`): the tool list comes from the server (all pages), is kept for 5 minutes (`--tools-ttl`) and is served from the last read when the server cannot be reached. A 401 now says one sentence: run `npx @lefine/mcp setup`.
- Local tools for what only your machine can do: `lefine_project` (app and project ids from `lefine.ts` / `lefine.config.*`, read as text), `lefine_upload_file`, `lefine_upload_folder` (up to 50 per call, a table), `lefine_import_locale_files` (JSON, YAML, XML, XLIFF, .properties, .po; a dry run first, then an apply bound to the dry run's `confirmPlan`). `lefine_find_similar_key` and `lefine_add_key` stay.
- `--read-only` hides every write tool and asks the server for `?level=read`; `--toolsets=content,strings` limits modules; `--allow-dir` opens one more folder to local tools. Environment variables for each.
- Local files are read only inside the working folder (and `--allow-dir`): no `../`, no links out, no `.git` / `.ssh` / `.lefine` / `.env`, 8 MB, a type allowlist checked against the first bytes.
- README rewritten. Releasing this version goes to the `next` npm tag, so `npx @lefine/mcp` stays on 0.3.0 until it is promoted.
- Updated dependencies
  - lefine@0.11.0

## 0.3.0

### Minor Changes

- `npx @lefine/mcp` is the friendly front door. Run it in a terminal with no arguments and it opens the setup wizard (the same code as `npx lefine setup`, no copy). `npx @lefine/mcp setup`, `--list`, `--remove`, `--doctor`, `--print`, `--yes`, `--readonly` mirror `lefine setup`. When an AI app starts it (stdin is not a terminal) it is the stdio server, exactly as before, so configs that say `npx -y @lefine/mcp` keep working. README starts with `npx @lefine/mcp`.
- Updated dependencies
  - lefine@0.10.0

## 0.2.7

### Patch Changes

- Updated dependencies
  - lefine@0.8.0

## 0.2.6

### Patch Changes

- Updated dependencies
  - lefine@0.7.0

## 0.2.5

### Patch Changes

- Updated dependencies
  - lefine@0.6.0

## 0.2.4

### Patch Changes

- Updated dependencies
- Updated dependencies
- Updated dependencies
  - lefine@0.5.0

## 0.2.3

### Patch Changes

- Updated dependencies
- Updated dependencies
  - lefine@0.4.0

## 0.2.2

### Patch Changes

- Updated dependencies
  - lefine@0.3.0

## 0.2.1

### Patch Changes

- Updated dependencies
  - lefine@0.2.0

## 0.2.0

### Minor Changes

- `@lefine/mcp` is now a thin alias of `npx lefine mcp`: it depends on `lefine` and runs its `mcp` command, so configs that say `npx -y @lefine/mcp` keep working. Publish `lefine` first.

### Patch Changes

- Updated dependencies
  - lefine@0.1.0
