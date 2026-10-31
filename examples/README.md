# lefine examples

Small apps that read their texts from [Lefine](https://lefine.ai) with the `lefine` package. Each one is the
whole path: your texts in `locales/`, `lefine strings push --all`, publish, run.

| Example | What it shows |
|---|---|
| [`nextjs`](./nextjs) | Next.js 16 App Router: `/en`, `/de`, server page + client component, `<html lang dir>` |
| [`vite-react`](./vite-react) | Vite + React, no server: load from the CDN in the browser, switch language |
| [`expo`](./expo) | Expo SDK 58: offline starts (AsyncStorage), the Hermes plural polyfill |

They need `lefine` 0.5.1 or newer.

## How they are kept working

- **Every pull request** (CI, `examples` job): each example is installed with this repo's `lefine` build, then
  typechecked and built (`scripts/smoke/dev-path.ts --example <name> --offline`). An SDK change that breaks an
  example fails the PR.
- **The full path** against a running Lefine: push, publish with approval,
  read back from the CDN, and run the app (`next start` serves `/de` in German; `vite build`; `expo export`):

```sh
LEFINE_NO_BROWSER=1 LEFINE_SMOKE_APP=app_... LEFINE_TOKEN=lfn_... \
bun scripts/smoke/dev-path.ts --example nextjs      # or vite-react, expo
```

The app must have English and German. See `scripts/smoke/README.md`.
