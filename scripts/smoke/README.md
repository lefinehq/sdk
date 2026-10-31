# Developer-path smoke run

`scripts/smoke/dev-path.ts` walks the path a new customer takes, end to end, and exits 0 only when every step passed:

1. builds and packs this repo's `lefine` (or takes npm's, or a tarball)
2. a fresh Next.js app with `create-next-app@latest`, `lefine` installed
3. `npx lefine init --app <id>`, which must write `lefine.ts`, `proxy.ts` and `app/[locale]/`
4. `lefine strings push` of one key, `smoke.hello`, whose text changes every run (`Smoke run <run id>`)
5. `lefine strings publish`: a person approves it in Lefine, or `SMOKE_APPROVE_CMD` does on the local stack
6. reads `smoke.hello` back from the CDN through `lefine/server`, the SDK the app ships with (it retries for 90 s)
7. `lefine strings types`, then `tsc`: `t("hello")` compiles, and an unknown key fails with an error in that file only

It takes 2 to 4 minutes, most of it `create-next-app` and `npm install`. It prints no key. The temp app is
deleted when every step passed; on a failure (or with `--keep`) its path is printed.

## The examples (`--example`)

`--example nextjs|vite-react|expo` runs `examples/<name>` instead of a fresh create-next-app: copy it, install it with
this repo's `lefine` (`npm install --ignore-scripts`), `lefine strings push --all locales`, publish with approval, read
`example.title` in German back through `lefine/server`, then run the app its own way: Next.js `next build` +
`next start` and `/de` must show the German title; Vite `tsc -b && vite build`; Expo `tsc` + `expo export --platform
android` (Hermes bytecode). The app must have English and German. A second run finds nothing to push or publish and
still checks the rest.

`--offline` (with `--example`) needs no Lefine and no key: install, typecheck and build only. CI runs it for each
example on every pull request (`.github/workflows/ci.yml`, job `examples`).

## Settings

| Variable | |
|---|---|
| `LEFINE_SMOKE_APP` | The app id (`app_...`) the run pushes to and publishes. Use a test app: each run publishes a release. |
| `LEFINE_TOKEN` | A key with publish access to that app (Settings, API keys). |
| `LEFINE_API_URL` | Default `https://dash.lefine.ai`. Local: `http://localhost:8787`. |
| `LEFINE_CDN_URL` | Default `https://cdn.lefine.ai`, or `<api>/cdn` when the API is on localhost. |
| `LEFINE_SMOKE_PACKAGE` | `local` (default: build and pack `packages/lefine`), `npm` (`lefine@latest`), or a `.tgz` path. |
| `SMOKE_APPROVE_CMD` | A shell command that approves `$LEFINE_APPROVAL_ID`. Without it the run prints the approval link and waits up to 15 minutes for a person. |

## Against another API

Point the run at any Lefine API (a staging or local one) with `LEFINE_API_URL`; the CDN defaults to `<api>/cdn` on
localhost. `SMOKE_APPROVE_CMD` can be any command that approves `$LEFINE_APPROVAL_ID` there; without it a person
approves from the printed link.

```sh
LEFINE_API_URL=http://localhost:8787 \
LEFINE_SMOKE_APP=app_... \
LEFINE_TOKEN=lfn_... \
bun scripts/smoke/dev-path.ts
```

## Production

```sh
LEFINE_SMOKE_APP=app_... LEFINE_TOKEN=lfn_... LEFINE_SMOKE_PACKAGE=npm bun scripts/smoke/dev-path.ts
```

No `SMOKE_APPROVE_CMD`: an owner or admin approves the publish in the dashboard when the run prints the link.
