# lefine + Vite + React

A Vite React app (no server) whose texts come from [Lefine](https://lefine.ai): it loads one language from the CDN,
renders, and switches language with a button. An ICU plural included. About 50 lines of your own code.

## Run it

You need a Lefine app with English and German (any app; `npx lefine apps` lists their ids).

```sh
npm install
npx lefine login                                         # once; opens the browser to sign in
npx lefine strings push --all locales --yes --project app_...   # the texts in locales/ go to your app
npx lefine strings publish --yes --project app_...       # a person approves it in Lefine; then it is live
VITE_LEFINE_APP=app_... npm run dev                      # http://localhost:5173
```

Or put `VITE_LEFINE_APP=app_...` in `.env` (see `.env.example`).

## The files

| File | What |
|---|---|
| `src/lefine.ts` | `createStrings({ project })`, once (`npx lefine init` writes it in your own app). |
| `src/main.tsx` | `strings.load(locale, ["example"])`, then `<StringsProvider>`; sets `<html lang dir>`. |
| `src/App.tsx` | `useStrings("example")`: `t("title")`, `t("clicks", { count })`, and the language buttons. |
| `locales/*.json` | The texts, `{ namespace: { key: text } }`, pushed with `lefine strings push --all`. |

The CDN answers browsers directly (CORS `*`), so there is no server of your own. For SSR (TanStack Start, Remix), load
in the route loader with the same `strings.load` and pass the props down.

Typed keys: `npx lefine strings types --project app_...` writes `src/lefine-strings.d.ts`.

Checked by `scripts/smoke/dev-path.ts --example vite-react` in this repo: push, publish, read from the CDN, `tsc -b`,
`vite build`.
