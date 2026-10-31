# lefine + Next.js (App Router)

A Next.js 16 app whose texts come from [Lefine](https://lefine.ai): `/en` and `/de`, a server page and a client
component, an ICU plural, and `<html lang dir>` that follows the language. About 60 lines of your own code.

## Run it

You need a Lefine app with English and German (any app; `npx lefine apps` lists their ids).

```sh
npm install
npx lefine login                                         # once; opens the browser to sign in
npx lefine strings push --all locales --yes --project app_...   # the texts in locales/ go to your app
npx lefine strings publish --yes --project app_...       # a person approves it in Lefine; then it is live
LEFINE_APP=app_... npm run dev                           # http://localhost:3000 → /en, click "de"
```

Change a text in Lefine, publish, reload: the page shows it within a minute.

## The files

| File | What |
|---|---|
| `lefine.ts` | `createLefine({ project, locales, defaultLocale })`, once. `npx lefine init` writes it in your own app. |
| `proxy.ts` | Sends `/` to the visitor's language. |
| `app/[locale]/layout.tsx` | The root layout: `<html lang dir>`, and `lefine.Provider` with the namespaces client components use. |
| `app/[locale]/page.tsx` | Server: `await lefine.getStrings(locale, "example")`. |
| `app/[locale]/clicks.tsx` | Client: `useStrings("example")` with a plural, `{count, plural, ...}`. |
| `locales/*.json` | The texts, `{ namespace: { key: text } }`, pushed with `lefine strings push --all`. |

Typed keys: `npx lefine strings types --project app_...` writes `lefine-strings.d.ts`, and then `t("nope")` is a type
error.

In your own app, start with `npx lefine init` instead: it writes these files for your app, with its id.

Checked by `scripts/smoke/dev-path.ts --example nextjs` in this repo: push, publish, read from the CDN, `next build`,
`next start`, and `/de` shows the German title.
