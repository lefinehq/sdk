# @lefine/cli

Lefine from the terminal. Sign in, then pull, push, check and publish your app strings.

## Install

Needs Node 20 or newer.

```sh
npm install --global @lefine/cli     # or: pnpm add -g @lefine/cli
yarn global add @lefine/cli          # or: bun add -g @lefine/cli
npx @lefine/cli --help               # no install
```

This gives you the `lefine` command.

## Sign in

```sh
lefine login
```

The CLI prints a short code and a link, and tries to open your browser. Open the link, check the code, and pick the workspace and the access you want to give. It works over SSH and in containers, because nothing listens on your machine.

- `lefine login --no-browser` prints the link and does not try to open it.
- `lefine login --token lfn_...` saves an access key you created in Settings, API keys.
- `lefine login --api-url <url>` signs in to another server.
- `lefine login --profile <name>` saves the key as a separate profile; use it with `LEFINE_PROFILE=<name>`.
- `lefine whoami` shows who you are, the workspace, and what the key may do.
- `lefine logout` removes the saved key from this machine.

The key is saved in `~/.lefine/credentials.json`. The folder is private to you (mode 0700) and so is the file (mode 0600). A saved key is only ever sent to the server it was saved for. If `--api-url` or `LEFINE_API_URL` points somewhere else, the CLI stops and tells you to log in again for that server.

## Start here: `lefine init`

```sh
cd my-next-app
lefine init
```
Signs you in if needed, asks which app this folder is, installs `lefine`, and writes `lefine.ts` plus a first translated page. It works for Next.js and TanStack Start. After this, every command below finds the app from `lefine.ts`, so you do not pass `-p`.

- `--app <id|slug>` picks the app without the question (CI).
- `--create <name>` makes a new Strings app first (`--source-locale`, default `en`; `--languages de,pt-BR`) and writes `lefine.ts` for it. Creating counts against the plan, so a person approves it in Lefine; the CLI prints the link and waits. It never replaces an existing `lefine.ts`, and it makes a Strings app only: a Content project is made in Lefine or with the server's `content.projects.create`.
- `-d <path>` is the app's folder, `-o <path>` is where `lefine.ts` goes.
- `--force` replaces an existing `lefine.ts` (never your pages). `--no-install` leaves `package.json` alone.

`lefine apps` lists your workspace's apps with their ids (`app_...`).

## Which project does a command mean?

| Command | Flag | Takes |
| --- | --- | --- |
| `init` | `--app` | an app id or slug |
| `strings ...`, `doctor`, `import`, `ci trust` | `-p, --project` | an app id (`app_...`). `workspace/app` still works as an alias |
| `content ...` | `-p, --project` | a Content project id or slug (can be left out when the workspace has one) |

Without `-p`, the app comes from `lefine.ts` in the current folder, then from `i18n.config.ts` (older projects). Add `-d <path>` to use another folder. The app must belong to the workspace of your key, or the CLI stops before it changes anything.

## Check your code

```sh
lefine doctor
```
One report and a score from 0 to 100: hard-coded text in your code, texts that break, missing keys and unused keys. `--threshold <score>` fails under that score (default 70). `--verbose` shows every finding.

## Strings

All strings commands except `pull` take `--json` for machine-readable output.

```sh
lefine strings status
```
Shows the live version, how many changes are waiting to be published, and the last CDN check.

```sh
lefine strings pull -o ./locales
```
Downloads the published translations to JSON files. Each file is checked against the sha256 in the manifest, and an empty file is never written. A second pull only downloads the locales that changed (`--force` downloads all). `-l en,de` picks locales, `--since 12` lists what changed since revision 12, `--cdn-url` reads from another CDN.

```sh
lefine strings push
```
Reads your source file (`<output>/<default locale>.json`, shaped `{ "namespace": { "key": "text" } }`), shows what would change, and asks before it applies. The file can also be YAML, XLIFF, Android XML or `.properties` (`--namespace` names it). `--file <path>` and `--locale <code>` pick another file or language. `--all [folder]` pushes every language file, source first. Add `--yes` to apply without asking.

```sh
lefine strings check
```
Runs the server checks (placeholders, ICU plurals, markup) and scans your code for keys missing from the source file. Problems are grouped by key.

```sh
lefine strings unused
lefine strings missing
```
`unused` lists keys in Lefine that your code never uses. `--ci` exits 1 when there is one, `--delete` removes them after a person approves it in Lefine. `missing` lists names in your code that have no key in Lefine. Both take `--namespace <name>`.

```sh
lefine strings publish
```
A person approves the publish in Lefine (the CLI opens the page and waits). Then it publishes and waits until every locale is read back from the CDN. `--yes` only skips the question in the terminal.

```sh
lefine strings keys list
lefine strings keys create common.hello --text "Hello"
lefine strings keys delete common.hello
```
List keys (`--namespace`, `--search`, `--locale`, `--limit`, `--all`), add a key (`--text`, `--description`), or delete keys by `namespace.key` or id. A delete needs a person's approval in Lefine. `--approval <id>` runs one that was already approved.

```sh
lefine strings runs [id]
```
Recent syncs, imports and publishes, or one run with its steps. `--kind` and `--limit` filter.

```sh
lefine strings languages add de
```
Adds a language to the app. A person approves it in Lefine.

```sh
lefine strings languages remove de
```
Removes a language and deletes its translations. It shows how many translations go, asks you first (`-y` skips that question), and a person still approves in Lefine. Lefine cannot undo it. The next publish takes the language off the CDN.

```sh
lefine strings types
```
Writes `lefine-strings.d.ts` with every key of the app and its source text, including keys added in Lefine that are not published yet. With next-intl or use-intl in your `package.json` (also through `@better-i18n/next` or `@better-i18n/use-intl`), the file registers itself, so `useTranslations("common")("hello", { name })` checks the key and its arguments. `--binding next-intl|use-intl|@lefine/strings|none` overrides the guess, `-o <file.d.ts>` writes elsewhere. Keep the file inside your tsconfig `include` and run the command again after keys change. Needs `strings:read`.

```sh
lefine strings snapshot
```
Writes the published texts to `lefine-snapshot.json` for `createLefine({ snapshot })`, so the first request after a deploy is served from it. `-o` writes elsewhere.

## Move in and migrate

```sh
lefine import ./export --from crowdin
```
Moves in from Crowdin, Lokalise, Phrase, Transifex or POEditor: their export (a file or folder of JSON, XLIFF or PO) with keys, translations and review state. `--from` is required. `--locale` sets the language of a file that does not say it, `--include-fuzzy` brings in fuzzy PO entries as reviewed, `--namespace` is for keys with no dot (default `common`), `--state reviewed|approved` is for formats with no review state. Add `--yes` to apply without asking.

```sh
lefine migrate ./src
lefine migrate ./src --write
```
Moves next-intl and `@better-i18n` code to lefine. It rewrites what maps one to one and lists the rest. It is a dry run unless you pass `--write`. `--lefine-import <path>` sets where your `lefine.ts` is imported from (default `@/lefine`).

## Content

All content commands take `-p <id|slug>`, `--api-url` and `--json`.

```sh
lefine content projects
lefine content pages --type post --status published
lefine content page <id>
```
`projects` lists your Content projects with their ids and languages. `pages` lists a project's pages, newest first, with what is live in each language. Filters: `--type`, `--search`, `--missing <locale>`, `--slug`, `--status`, `--locale`, `--where field=value` (repeat for more), `--expand`, `--sort`, `--order`, `--limit`, `--all`. `page` shows one page with its languages and data.

```sh
lefine content publish <id>
```
Publishes a page's latest version. A person approves it in Lefine and the CLI waits. `--locales de,fr` limits the languages.

```sh
lefine content push
```
Makes Lefine's content types match your `lefine.config.ts`. It shows the diff first and never deletes. A type change is approved in Lefine. `--dry-run` shows the diff and stops, `-c <path>` picks another config.

```sh
lefine content types
```
Writes `lefine-content.ts`: one TypeScript type per content type of your Content project, plus the project's ids and languages, for `lefine/content` (from the `lefine` package). Run it again after you change a content type. Needs a key with `content:read`.

## Actions

Every module (strings, content, studio, social, integrations) exposes its operations as named actions.

```sh
lefine actions publish --module strings
lefine run strings.status --input '{}'
```
`actions` searches the actions your key can run: name, what it does, its input. `run <action>` runs one. `--input` is JSON, `@file.json`, or `-` for stdin. An action that asks first waits for a person's yes in Lefine. `--approval <id>` runs one that was already approved.

## CI sign-in without a secret

```sh
lefine ci trust add acme/web --ref main
lefine ci trust list
lefine ci trust remove <id>
```
Lets a GitHub repository sign in to the app from GitHub Actions with no stored secret. A person approves `add` in Lefine. `--ref`, `--environment` and `--level read|write|publish` narrow it. `list` shows trusted repositories, `remove` stops one.

## MCP

```sh
npx lefine setup
```
Adds Lefine to the AI apps on this machine: Claude Code, Cursor, Claude Desktop and VS Code. It looks for them, asks which to set up (`--yes` takes all found, `--client claude-code|cursor|claude-desktop|vscode` names one), and adds the remote server `https://dash.lefine.ai/v1/mcp`. Then open the app and approve Lefine when it asks; you pick the workspace there, and no key is stored. `lefine mcp install` does the same.

- Claude Code: runs `claude mcp add --transport http --scope user lefine <url>`. If it says "blocked by enterprise policy", look for `lefine` in `deniedMcpServers` in `~/.claude/settings.json` (or a policy from your admin) and remove it. Setup never edits your settings.
- Cursor, VS Code: merges one `lefine` entry into `~/.cursor/mcp.json` or VS Code's user `mcp.json`. Your other servers stay, and the file is copied once to `<file>.lefine-backup`. A file with comments is left alone.
- Claude Desktop: remote servers are added in the app (Settings > Connectors > Add custom connector), because its config file only starts local servers. `--local` writes it there.
- `--local` adds the stdio server (`npx -y lefine mcp`) instead. It signs in first (browser device code) and saves the key as the profile `mcp` (`~/.lefine/profiles/mcp.json`), selected by `LEFINE_PROFILE=mcp` in the app's config, so the key is not in the config file. Your own login stays as it is.
- `--print` shows the config for each app and changes nothing.

```sh
lefine mcp
```
The local MCP server itself (stdio). An AI app starts it; run by hand in a terminal it prints a hint and waits.

## CI

Do not run `lefine login` in CI. Create an access key in Settings, API keys, store it as a secret, and pass it as `LEFINE_TOKEN`. Anything that changes data needs `--yes` there, because nobody can answer a question.

```yaml
- run: npx @lefine/cli strings push --yes
  env:
    LEFINE_TOKEN: ${{ secrets.LEFINE_TOKEN }}
- run: npx @lefine/cli strings publish --yes
  env:
    LEFINE_TOKEN: ${{ secrets.LEFINE_TOKEN }}
```

`LEFINE_TOKEN` wins over a saved key. Give the key only the access the job needs: read to check and pull, write to push, publish to publish.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | It worked. For `publish`: every locale is verified on the CDN. Nothing to push or publish is also `0`. |
| `1` | It did not work: not signed in, wrong workspace, missing access, a failed request, a `check` that found problems, a `publish` that is not verified on the CDN, or `push`/`publish` without `--yes` where nobody can answer. |

## Settings

| Setting | Default |
| --- | --- |
| `--api-url`, `LEFINE_API_URL` | `https://dash.lefine.ai` |
| `--cdn-url`, `LEFINE_CDN_URL` (pull) | `https://cdn.lefine.ai` |
| `LEFINE_TOKEN` | the key saved by `lefine login` |
| `LEFINE_PROFILE` | use `~/.lefine/profiles/<name>.json` (made by `lefine login --profile <name>`) instead of your main login |
| `LEFINE_HOME` | `~/.lefine` |

The CLI does not read these from `.env` files in your project, so a cloned repository cannot point your key at another server.

## License

MIT
