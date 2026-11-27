# @lefine/cli

## 0.12.0

### Minor Changes

- Same source as `lefine` 0.11.0: `lefine mcp` is a full MCP server with local tools (`lefine_project`, `lefine_upload_file`, `lefine_upload_folder`, `lefine_import_locale_files`), `--read-only`, `--toolsets`, `--allow-dir`, `--tools-ttl`, a cached tool list and a clear 401 message.

## 0.11.0

### Minor Changes

- `npx lefine setup` is rebuilt as a wizard (@clack/prompts) and covers more apps. It lists the AI apps it finds (pre-selected) and the others you can still pick: Claude Code, Cursor, VS Code, Windsurf, Codex, Gemini CLI, Zed, and Claude Desktop / ChatGPT as steps. "Install with defaults" is one Enter (for you only, can edit, asks before it publishes); "Customize" offers read-only and one project folder. Every app gets a line with the file it changed, then a connection test (a key-less `initialize`; 401 with `resource_metadata` means reachable), then the one click each app needs to sign in (Claude Code: `/mcp`, lefine, Authenticate; Cursor: Settings > MCP > Connect; VS Code: Start; Codex: `codex mcp login lefine`), a "Try:" sentence and `npx lefine setup --remove`.
- New flags: `--readonly` (the URL gets `?level=read`), `--project`, `--list`, `--remove`, `--doctor` (old stdio `lefine` entries, an entry with another URL, `deniedMcpServers`, no `claude` command, server not reachable), `--json`, `--no-backup`, `--no-check`. Without a terminal it prints one JSON object with a `next` command and never waits for a question. An old stdio `lefine` entry, or one with another URL, is now replaced instead of left stale.
- Config paths and formats (JSON, TOML, YAML; macOS, Linux and Windows) come from `add-mcp` 2.6.1 (Apache-2.0, neon-solutions/add-mcp); Claude Code stays on `claude mcp add`, run through the shell on Windows (`claude.cmd`). Claude Desktop's `claude_desktop_config.json` is never written for the remote server (it only starts local ones): setup prints Settings > Connectors > Add custom connector. Backups (`<file>.lefine-backup`) are now owner-only (0600); a config file that is not valid JSON is left as it is (comments are fine).

## 0.10.0

### Minor Changes

- `npx lefine setup` (alias `npx lefine mcp install`) adds Lefine's MCP server to the AI apps on the machine in one command: Claude Code (`claude mcp add --transport http --scope user`), Cursor and VS Code (one `lefine` entry merged into their `mcp.json`, other servers kept, one backup), and Claude Desktop (Connectors, or `--local`). It adds the remote server (`https://dash.lefine.ai/v1/mcp`, OAuth in the app, no key stored); `--local` adds `npx -y lefine mcp` after a device login saved as the profile `mcp`. `--client`, `--yes` and `--print` (show the config, write nothing). If Claude Code says "blocked by enterprise policy" it points at `deniedMcpServers` in `~/.claude/settings.json`; it never edits your settings.
- Profiles: `lefine login --profile <name>` saves the key to `~/.lefine/profiles/<name>.json`, and `LEFINE_PROFILE=<name>` selects it. Your main login is not touched.
- `lefine mcp` run by hand in a terminal prints a two-line hint on stderr (it is the server an AI app starts, and waits for that app) instead of looking frozen.

## 0.9.0

### Minor Changes

- `lefine import` reads Transifex and POEditor exports too: Transifex key-value and structured JSON, XLIFF 1.2 (`approved="yes"` lands approved) and 2.0, and PO; POEditor's `json` export and PO. Gettext PO files come in whole (one namespace per file, the msgid kept as the key, dots and all); fuzzy entries (POEditor's "needs review") are left out unless `--include-fuzzy`; two-form plurals become ICU, more forms are reported, not guessed. `--locale` names the language of a file that does not say it (POEditor JSON, an XLIFF with no target language). XLIFF plural groups (`id[0]`, `id[1]`) become one ICU plural.

## 0.8.0

### Minor Changes

- `lefine import <file|folder> --from crowdin|lokalise|phrase` moves a team in from another translation tool in one command: their JSON or XLIFF export, with keys, every language and review state. Signed-off texts (XLIFF `final` / `signed-off` / `approved="yes"`, Phrase `reviewed`) land approved, other translations reviewed, untranslated ones are left out. Plurals in the tools' shapes become ICU; `de-DE` maps to the app's `de` when the app has no region. Crowdin's XLIFF is refused (its ids are numbers, not keys): import its JSON export. A format without review state lands reviewed, or approved with `--state approved`. Needs the API's import `state`.

## 0.7.0

### Minor Changes

- `lefine content pages` finds pages like the API's list: `--slug a,b`, `--status published|changed|not-published|offline|scheduled` in `--locale`, `--where field=value` (repeatable; `field:=json` for a typed value such as `featured:=true`), `--expand author,tags` to show the pages relation fields point at, and `--sort` / `--order`. `--where` and `--expand` need `--type`.

## 0.6.2

### Patch Changes

- The code scan behind `lefine doctor`, `lefine strings missing` and `lefine strings unused` knows lefine's own translators: `useStrings("ns")` (lefine/react), `getStrings(locale, "ns")` and `lefine.getStrings(...)` (lefine/server, lefine/next), and `createTranslator({ namespace })` (lefine/strings). Before, their keys were read without the namespace, so a lefine app saw its keys as missing and unused.

## 0.6.1

### Patch Changes

- The CLI opens a browser only for a person at a terminal: never with `LEFINE_NO_BROWSER=1`, in CI, under a test runner, or when stdout is not a terminal (scripts, pipes). An approval page is opened only when it is a well-formed approval link on the same host as the API the CLI talks to; any other link is printed, not opened. Before, test runs and scripts could open approval links in your browser, including fake or other-server ones.

## 0.6.0

### Minor Changes

- `lefine actions [words] [--module]` searches every action this key can run, in every module (Strings, Content, Studio, Social, connected apps), with each action's input; it asks the server's own search, so a new action needs no CLI release. `lefine run <action> --input <json|@file|->` runs one by its shared name through `/v1/ops`; an action that asks first waits for a person's yes in Lefine (`--approval <id>` reruns an approved one). Server messages no longer end in a double period.
- `lefine content push` keeps content types in your repo: write them in `lefine.config.ts` with `defineContent` (from `lefine/content/config`), and the push shows what would change first. `--dry-run` stops there. A change to an existing type waits for a person's yes in Lefine, and the push never deletes a type. `lefine content types` now writes types for site settings (globals) too.

## 0.5.1

### Patch Changes

- `LEFINE_NO_BROWSER=1` stops the CLI from opening approval and sign-in pages in a browser; the link is printed as before. For scripts and unattended runs.

## 0.5.0

### Minor Changes

- GitHub Actions sign-in with no stored secret. `lefine ci trust add <owner/name> [--ref main] [--environment] [--level]` lets one repository's runs sign in to an app (a person approves it in Lefine; the repository is held by GitHub's numeric id, found with `gh` or GitHub's API). In a job with `permissions: id-token: write` and no `LEFINE_TOKEN`, every app command asks GitHub for an OIDC token with the audience `lefine:<app id>` and trades it for a key that lasts 15 minutes. `lefine ci trust list` and `remove <id>` manage the trusts. Needs the API's `POST /v1/oidc/github`.

### Patch Changes

- The CLI prints plain text when its output is not a terminal (CI logs, a pipe, a file) or `NO_COLOR` is set; `FORCE_COLOR` turns colors back on. Before, CI logs showed raw escape codes.

## 0.4.0

### Minor Changes

- `lefine content projects | pages | page <id> | publish <id>`: the Content module from the CLI, through the same actions as the MCP server. `pages` filters by `--type`, `--search` and `--missing <locale>` (pages that still need that language). `publish` is bound to the version it shows; a person approves it in Lefine, and the CLI opens the page and waits (`--approval <id>` reruns an approved one). A workspace without Content says so.

## 0.3.0

### Minor Changes

- `lefine strings push --all [folder]` pushes every language file in a folder: the source language first, so the keys exist, then each language of the app. It reads `de.json` files (what `pull` writes, next-intl's `messages/de.json`) and i18next's `de/common.json` folders. A file for a language the app does not have is skipped with a note. `--locale <code>` with a target language sets that language's translations; the preview now says when a language file names keys Lefine does not have yet.

## 0.2.0

### Minor Changes

- New `lefine content types`: writes `lefine-content.ts` with one TypeScript type per content type of a Content project, the `LefineContent` map and the project config for `lefine/content`. The generated file imports its types from `lefine/content` (in `lefine` since 0.1.0, on npm), so install `lefine` next to it.
- New `lefine strings types`: writes `lefine-strings.d.ts` with every key of the app and its source text as literal types, read from Lefine (`strings.keys.list`), so a key added in the dashboard shows up in the editor. It registers the messages with next-intl's or use-intl's `AppConfig` (found in `package.json`, or `--binding`), so `useTranslations` checks keys, namespaces and ICU arguments; `--binding @lefine/strings` registers them with the Lefine runtime's `StringsConfig` instead. Types only, no runtime code.
- `lefine strings unused` (with `--ci`, and `--delete`, which a person approves in Lefine), `lefine strings missing` and `lefine doctor`: the code scan of `strings check`, compared with the app's keys on the server, and one 0–100 report with Better's weights. `lefine init` now installs `lefine` and writes a first translated page for Next and TanStack Start.

### Patch Changes

- `lefine strings publish` no longer says "Published." when the publish failed. When the CDN check fails, Lefine puts the previous release back, so the CLI now prints "The publish failed" with Lefine's reason, and `--json` gives `published: false`. The exit code is still 1.
- `lefine init` in a Next.js app: `<html lang>` follows the locale, and Arabic, Hebrew, Persian, Urdu and other right-to-left languages get `dir="rtl"`. create-next-app's `app/layout.tsx` (which said `lang="en"` for every language) moves into `app/[locale]/layout.tsx` with its fonts, CSS and metadata. A root layout of your own is kept, and init says what to move. A Vue, Svelte or plain JS app is no longer called React, and init names the guide for the next step.
- `lefine init` in a Next.js app: `next dev` no longer prints `Error: Route "/[locale]": Next.js encountered URL data`. `app/[locale]/layout.tsx` is now the root layout, as in Next's i18n guide: init removes create-next-app's `app/layout.tsx` and `app/page.tsx` after moving their `<html>`, fonts and CSS, so `locale` is a root param (Next 16.3+ with Partial Prefetching only lets root params be read outside `<Suspense>`). The locale layout sends an unknown locale to `notFound()`, and `app/not-found.tsx` no longer renders its own `<html>` (it nested inside Next's and broke hydration).
- `strings push` works for files with several namespaces. Each apply moved the app's marker, so every namespace after the first was refused as "changed since the preview". The CLI now previews each namespace again right before its apply, applies it only if the changes are still the ones shown, and stops with a clear message otherwise.

  `--locale zh-hans` (or `pt_br`) is sent to the API as the canonical tag (`zh-Hans`, `pt-BR`); before, it was lower-cased and refused. Files keep their lower-case names (`zh-hans.json`).

- `lefine strings publish` waits for a person's approval in Lefine. The API no longer accepts `confirm: true` from a key, so the CLI prints and opens the approval link, waits up to 15 minutes, and publishes once with the approval id. Declined, expired or unanswered: nothing is published and the exit code is 1. `--yes` only skips the question in the terminal.
- `lefine strings types` writes `lefine-strings.d.ts` beside `lefine.ts`: `src/` in a Vite or TanStack Start app, where `init` puts `src/lefine.ts`. At the project root, Vite's `tsconfig.app.json` (`"include": ["src"]`) never read the file, so keys were not checked. `-o` still sets the path.
- `lefine strings types`: keys are now checked in apps that use only `lefine/next` and `lefine/react`. The generated `lefine-strings.d.ts` imports `lefine/strings`, so its `declare module "lefine/strings"` block applies. Before, an app that never imported `lefine/strings` itself got no key checks at all: `useStrings("nav")("anything")` compiled. Run the command again to get the fixed file.
