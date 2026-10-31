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
- `lefine whoami` shows who you are, the workspace, and what the key may do.
- `lefine logout` removes the saved key from this machine.

The key is saved in `~/.lefine/credentials.json`. The folder is private to you (mode 0700) and so is the file (mode 0600). A saved key is only ever sent to the server it was saved for. If `--api-url` or `LEFINE_API_URL` points somewhere else, the CLI stops and tells you to log in again for that server.

## Strings

Every strings command finds the app from `i18n.config.ts` in the current folder, or from `-p <workspace>/<app>`. Add `-d <path>` to use another folder. All except `pull` take `--json` for machine-readable output.

The workspace in your project must be the workspace of your key. If they differ, the CLI stops before it changes anything.

```sh
lefine strings status -p acme/web
```
Shows the live version, how many changes are waiting to be published, and the last CDN check.

```sh
lefine strings pull -p acme/web -o ./locales
```
Downloads the published translations to JSON files. Each file is checked against the sha256 in the manifest, and an empty file is never written. A second pull only downloads the locales that changed since the last one (`--force` downloads all). `-l en,de` picks locales, `--since 12` lists what changed since revision 12, `--cdn-url` reads from another CDN.

```sh
lefine strings push -p acme/web
```
Reads your source file (`<output>/<default locale>.json`, shaped `{ "namespace": { "key": "text" } }`), shows what would change, and asks before it applies. `--file <path>` and `--locale <code>` pick another file or locale. Add `--yes` to apply without asking.

```sh
lefine strings check -p acme/web
```
Runs the server checks (placeholders, ICU plurals, markup) and scans your code for keys that are missing from the source file. Problems are grouped by key.

```sh
lefine strings publish -p acme/web
```
Shows what will go live, asks, publishes, and then waits until every locale is read back from the CDN. Add `--yes` to publish without asking.

```sh
lefine strings types -p acme/web
```
Writes `lefine-strings.d.ts` with every key of the app and its source text, including keys added in Lefine that are not published yet. With next-intl or use-intl in your `package.json` (also through `@better-i18n/next` or `@better-i18n/use-intl`), the file registers itself, so `useTranslations("common")("hello", { name })` checks the key and its arguments. `--binding next-intl|use-intl|@lefine/strings|none` overrides the guess (`@lefine/strings` checks namespaces and keys of `createTranslator` and `useStrings`), `-o <file.d.ts>` writes elsewhere. Keep the file inside your tsconfig `include` and run the command again after keys change. Needs `strings:read`.

## Content

```sh
lefine content types -p site
```
Writes `lefine-content.ts`: one TypeScript type per content type of your Content project, plus the project's ids and languages, for `lefine/content` (from the `lefine` package). Run it again after you change a content type. Needs a key with `content:read`; `-p` can be left out when the workspace has one Content project.

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
| `LEFINE_HOME` | `~/.lefine` |

The CLI does not read these from `.env` files in your project, so a cloned repository cannot point your key at another server.

## License

MIT
