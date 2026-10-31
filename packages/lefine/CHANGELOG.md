# lefine

## 0.8.0

### Minor Changes

- `lefine import` reads Transifex and POEditor exports too: Transifex key-value and structured JSON, XLIFF 1.2 (`approved="yes"` lands approved) and 2.0, and PO; POEditor's `json` export and PO. Gettext PO files come in whole (one namespace per file, the msgid kept as the key, dots and all); fuzzy entries (POEditor's "needs review") are left out unless `--include-fuzzy`; two-form plurals become ICU, more forms are reported, not guessed. `--locale` names the language of a file that does not say it (POEditor JSON, an XLIFF with no target language). XLIFF plural groups (`id[0]`, `id[1]`) become one ICU plural.

## 0.7.0

### Minor Changes

- `lefine import <file|folder> --from crowdin|lokalise|phrase` moves a team in from another translation tool in one command: their JSON or XLIFF export, with keys, every language and review state. Signed-off texts (XLIFF `final` / `signed-off` / `approved="yes"`, Phrase `reviewed`) land approved, other translations reviewed, untranslated ones are left out. Plurals in the tools' shapes become ICU; `de-DE` maps to the app's `de` when the app has no region. Crowdin's XLIFF is refused (its ids are numbers, not keys): import its JSON export. A format without review state lands reviewed, or approved with `--state approved`. Needs the API's import `state`.

## 0.6.0

### Minor Changes

- `lefine content pages` finds pages like the API's list: `--slug a,b`, `--status published|changed|not-published|offline|scheduled` in `--locale`, `--where field=value` (repeatable; `field:=json` for a typed value such as `featured:=true`), `--expand author,tags` to show the pages relation fields point at, and `--sort` / `--order`. `--where` and `--expand` need `--type`.

## 0.5.2

### Patch Changes

- The code scan behind `lefine doctor`, `lefine strings missing` and `lefine strings unused` knows lefine's own translators: `useStrings("ns")` (lefine/react), `getStrings(locale, "ns")` and `lefine.getStrings(...)` (lefine/server, lefine/next), and `createTranslator({ namespace })` (lefine/strings). Before, their keys were read without the namespace, so a lefine app saw its keys as missing and unused.

## 0.5.1

### Patch Changes

- The CLI opens a browser only for a person at a terminal: never with `LEFINE_NO_BROWSER=1`, in CI, under a test runner, or when stdout is not a terminal (scripts, pipes). An approval page is opened only when it is a well-formed approval link on the same host as the API the CLI talks to; any other link is printed, not opened. Before, test runs and scripts could open approval links in your browser, including fake or other-server ones.

## 0.5.0

### Minor Changes

- `lefine actions [words] [--module]` searches every action this key can run, in every module (Strings, Content, Studio, Social, connected apps), with each action's input; it asks the server's own search, so a new action needs no CLI release. `lefine run <action> --input <json|@file|->` runs one by its shared name through `/v1/ops`; an action that asks first waits for a person's yes in Lefine (`--approval <id>` reruns an approved one). Server messages no longer end in a double period.
- `lefine content push` keeps content types in your repo: write them in `lefine.config.ts` with `defineContent` (from `lefine/content/config`), and the push shows what would change first. `--dry-run` stops there. A change to an existing type waits for a person's yes in Lefine, and the push never deletes a type. `lefine content types` now writes types for site settings (globals) too.
- Content: render what you publish, safely, in React or Vue.

  - `renderBlocks(blocks, renderers, { schemas })` in `lefine/content`: each section goes to the renderer of its block type. An unknown block throws `UnknownBlockError`, and a block its schema refuses throws `InvalidBlockError`, so a page never loses a section silently. Any schema with `parse()` works (Zod does).
  - `lefine/content/react` and `lefine/content/vue`: `RichText` draws a rich text field with the same tags as Lefine's HTML. Text is escaped, links keep only safe schemes, and anything outside the rich text format throws.
  - `lefine/content/media`: `mediaUrl(project, mediaId, size)` builds the URL of an image or file that an upload field holds (`original`, `thumbnail`, `medium`, `large`). It also works as `RichText`'s `uploadToSrc`.
  - `content.global(type, { locale })` reads a site setting (the footer, the navigation) from the edge, or its draft in preview.
  - `lefine/content/live-preview`: `onDocumentSaved` and, for React, `<RefreshOnSave refresh={router.refresh} />` make a draft page follow Lefine's editor.

## 0.4.1

### Patch Changes

- `LEFINE_NO_BROWSER=1` stops the CLI from opening approval and sign-in pages in a browser; the link is printed as before. For scripts and unattended runs.

## 0.4.0

### Minor Changes

- GitHub Actions sign-in with no stored secret. `lefine ci trust add <owner/name> [--ref main] [--environment] [--level]` lets one repository's runs sign in to an app (a person approves it in Lefine; the repository is held by GitHub's numeric id, found with `gh` or GitHub's API). In a job with `permissions: id-token: write` and no `LEFINE_TOKEN`, every app command asks GitHub for an OIDC token with the audience `lefine:<app id>` and trades it for a key that lasts 15 minutes. `lefine ci trust list` and `remove <id>` manage the trusts. Needs the API's `POST /v1/oidc/github`.

### Patch Changes

- The CLI prints plain text when its output is not a terminal (CI logs, a pipe, a file) or `NO_COLOR` is set; `FORCE_COLOR` turns colors back on. Before, CI logs showed raw escape codes.

## 0.3.0

### Minor Changes

- `lefine content projects | pages | page <id> | publish <id>`: the Content module from the CLI, through the same actions as the MCP server. `pages` filters by `--type`, `--search` and `--missing <locale>` (pages that still need that language). `publish` is bound to the version it shows; a person approves it in Lefine, and the CLI opens the page and waits (`--approval <id>` reruns an approved one). A workspace without Content says so.

## 0.2.0

### Minor Changes

- `lefine strings push --all [folder]` pushes every language file in a folder: the source language first, so the keys exist, then each language of the app. It reads `de.json` files (what `pull` writes, next-intl's `messages/de.json`) and i18next's `de/common.json` folders. A file for a language the app does not have is skipped with a note. `--locale <code>` with a target language sets that language's translations; the preview now says when a language file names keys Lefine does not have yet.

## 0.1.1

### Patch Changes

- `lefine strings publish` no longer says "Published." when the publish failed. When the CDN check fails, Lefine puts the previous release back, so the CLI now prints "The publish failed" with Lefine's reason, and `--json` gives `published: false`. The exit code is still 1.
- `lefine init` in a Next.js app: `<html lang>` follows the locale, and Arabic, Hebrew, Persian, Urdu and other right-to-left languages get `dir="rtl"`. create-next-app's `app/layout.tsx` (which said `lang="en"` for every language) moves into `app/[locale]/layout.tsx` with its fonts, CSS and metadata. A root layout of your own is kept, and init says what to move. A Vue, Svelte or plain JS app is no longer called React, and init names the guide for the next step.
- `lefine init` in a Next.js app: `next dev` no longer prints `Error: Route "/[locale]": Next.js encountered URL data`. `app/[locale]/layout.tsx` is now the root layout, as in Next's i18n guide: init removes create-next-app's `app/layout.tsx` and `app/page.tsx` after moving their `<html>`, fonts and CSS, so `locale` is a root param (Next 16.3+ with Partial Prefetching only lets root params be read outside `<Suspense>`). The locale layout sends an unknown locale to `notFound()`, and `app/not-found.tsx` no longer renders its own `<html>` (it nested inside Next's and broke hydration).
- `lefine strings types` writes `lefine-strings.d.ts` beside `lefine.ts`: `src/` in a Vite or TanStack Start app, where `init` puts `src/lefine.ts`. At the project root, Vite's `tsconfig.app.json` (`"include": ["src"]`) never read the file, so keys were not checked. `-o` still sets the path.
- Typed keys now reach `useStrings` (`lefine/react`) and `getStrings` (`lefine/next`, `lefine/server`) in an app that never imports `lefine/strings` itself. These entries take their types through `lefine/strings`, so the `declare module "lefine/strings"` block of `lefine-strings.d.ts` applies, also in files written by lefine 0.1.0. `lefine/strings` now also exports the `KeyOf` and `Namespace` types.
- `lefine strings types`: keys are now checked in apps that use only `lefine/next` and `lefine/react`. The generated `lefine-strings.d.ts` imports `lefine/strings`, so its `declare module "lefine/strings"` block applies. Before, an app that never imported `lefine/strings` itself got no key checks at all: `useStrings("nav")("anything")` compiled. Run the command again to get the fixed file.

## 0.1.0

### Minor Changes

- First release of `lefine`: one package for Lefine. `lefine/strings` (an ICU runtime under 2 KB gzip, our own parser and formatter), `lefine/content` (published Lefine Content from the edge, typed by `lefine content types`), `lefine/next` (App Router: locale proxy, navigation, server strings, metadata, revalidate on publish), `lefine/react` (provider and hooks), `lefine/compile` (server and build only), and the `lefine` CLI. No runtime dependencies; Next.js, React and TypeScript are optional peers.
