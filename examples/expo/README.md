# lefine + Expo (React Native)

An Expo SDK 58 app whose texts come from [Lefine](https://lefine.ai): English and German, an ICU plural, a language
switch, and **offline starts**: the last texts stay on the device (AsyncStorage), so a cold start shows them at once,
even without a network, and refreshes in the background.

## Run it

You need a Lefine app with English and German (any app; `npx lefine apps` lists their ids).

```sh
npm install
npx lefine login                                         # once; opens the browser to sign in
npx lefine strings push --all locales --yes --project app_...   # the texts in locales/ go to your app
npx lefine strings publish --yes --project app_...       # a person approves it in Lefine; then it is live
EXPO_PUBLIC_LEFINE_APP=app_... npx expo start            # scan the QR code with Expo Go
```

## The files

| File | What |
|---|---|
| `index.ts` | The `Intl.PluralRules` polyfill: Hermes has none. One `locale-data` import per language you ship. |
| `App.tsx` | `createStrings({ project, storage })` once; `strings.load(locale, ["example"])`, then `<StringsProvider>` and `useStrings("example")`. |
| `locales/*.json` | The texts, `{ namespace: { key: text } }`, pushed with `lefine strings push --all`. |

`lefine/server` runs anywhere: it has no Node or React inside, so the same package serves React Native. MMKV instead
of AsyncStorage is one line (see the comment in `App.tsx`).

Checked by `scripts/smoke/dev-path.ts --example expo` in this repo: push, publish, read from the CDN, `tsc`, and
`expo export --platform android` (Hermes bytecode).
