# Lefine Strings — GitHub Action

Push your app's source texts to Lefine from CI, and get the latest translations back as a pull request.
A thin wrapper around the pinned `@lefine/cli` (`lefine strings push --yes`, `lefine strings pull`).

## Sign in with no stored secret (default)

Trust the repository once, from your machine. A person approves it in Lefine (an owner or admin):

```sh
npx lefine ci trust add acme/web --ref main --project app_...
```

Then the workflow needs no secret, only `id-token: write`:

```yaml
permissions:
  id-token: write   # the run asks GitHub for its OIDC token
  contents: read
steps:
  - uses: actions/checkout@v4
  - uses: lefinehq/sdk/github-action@main
    with:
      mode: push            # or check, or pull
      app: app_...          # the app's id; or leave it out when lefine.ts names it
      cli-version: 0.9.0    # the first CLI that signs in with no secret (the default until then is 0.1.0)
```

Each run trades GitHub's token (audience `lefine:<app id>`) for a Lefine key that lasts 15 minutes and reaches
only that app. Lefine checks GitHub's signature and the repository by its numeric id, so a repository deleted and
made again under the same name is not trusted. `--ref main` keeps other branches and pull requests out.

## Or with a key

Set `api-key` and the key is used instead (it wins when both are there):

```yaml
- uses: lefinehq/sdk/github-action@main
  with:
    mode: push
    app: app_...
    api-key: ${{ secrets.LEFINE_API_KEY }}
```

## Which sign-in a run uses

1. `api-key` set: the key.
2. A fork's or Dependabot's pull request with no key: skipped, green.
3. `id-token: write` on the job: GitHub OIDC, failing closed on pull requests. A `pull_request` signs in only when its
   head is this repository; `pull_request_target` never does (it would give anyone's pull request your repository's
   identity), nor does a pull request whose event cannot be read. Pass `api-key` to run there on purpose.
   Needs the app's id (`app:` or `lefine.ts`) and `cli-version: 0.9.0` or newer: until that release is on npm, the
   default pin is 0.1.0 and a keyless run says so.
4. None of these: the step fails and says how to set up either.

## Modes

`pull` needs `permissions: contents: write, pull-requests: write`, commits only changed translation files (never the
source language's file), force-pushes the `lefine/strings` branch and reuses its open pull request. It reads the
public CDN and needs no sign-in.

`check` is the doctor for a pull request. It fails the step on names in the code with no key (`lefine strings
missing`), untranslated texts and texts that lost a variable (the release preview); `fail-on` picks which. Keys in
Lefine that the code never uses (`lefine strings unused`) are a warning, an annotation and the `unused-keys` output;
add `unused-keys` to `fail-on` to fail on them too. On a pull request it writes one comment with the lists and
updates it on each push (`permissions: pull-requests: write`; `comment: false` turns it off):

```yaml
on: pull_request
permissions:
  id-token: write        # sign in with no secret (or pass api-key)
  contents: read
  pull-requests: write   # the comment
jobs:
  strings:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: lefinehq/sdk/github-action@main
        with:
          mode: check
          app: app_...
          cli-version: 0.9.0
```

Full guide, inputs and outputs: https://lefine.ai/docs/strings/github-action

Tests: `bunx vitest run github-action` from the repo root. The end-to-end test runs against a live Lefine when
`LEFINE_E2E_TOKEN` and `LEFINE_E2E_APP` are set (see `__tests__/e2e-local.test.ts`).
