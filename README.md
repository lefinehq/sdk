<p align="center">
  <a href="https://lefine.ai">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="./assets/brand/lockup-paper.svg">
      <img src="./assets/brand/lockup-ink.svg" alt="Lefine" height="40">
    </picture>
  </a>
</p>

<h3 align="center">The SDKs, CLI and MCP server for Lefine</h3>

<p align="center">
  Strings and content from the Lefine edge, for your app and your agents.
  <br />
  <a href="https://lefine.ai/docs"><strong>Documentation</strong></a> · <a href="https://lefine.ai"><strong>Website</strong></a> · <a href="https://dash.lefine.ai"><strong>Dashboard</strong></a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/lefine"><img src="https://img.shields.io/npm/v/lefine?label=lefine&color=171717" alt="lefine version"></a>
  <a href="https://www.npmjs.com/package/@lefine/cli"><img src="https://img.shields.io/npm/v/@lefine/cli?label=%40lefine%2Fcli&color=171717" alt="CLI version"></a>
  <a href="https://www.npmjs.com/package/@lefine/mcp"><img src="https://img.shields.io/npm/v/@lefine/mcp?label=%40lefine%2Fmcp&color=171717" alt="MCP version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-MIT-171717" alt="MIT License"></a>
</p>

---

## Quick start

```sh
npm i lefine && npx lefine init     # signs in, picks the app, writes lefine.ts with its id
```

```tsx
// proxy.ts
import { lefine } from "./lefine";
export default lefine.proxy;
export const config = { matcher: ["/((?!api|_next|_vercel|.*\\..*).*)"] };

// app/[locale]/layout.tsx
const t = await lefine.getStrings(locale, "home");
return <lefine.Provider locale={locale} namespaces={["nav"]}>{children}</lefine.Provider>;

// a client component
const t = useStrings("nav");        // import { useStrings } from "lefine/react"
```

The full list of imports (Next.js, TanStack Start, any React, Vue, Content) is in [`packages/lefine`](./packages/lefine).

## Packages

| Package | What it does |
|---|---|
| [`lefine`](./packages/lefine) | Strings and content from the Lefine edge, an ICU runtime under 2 KB, no runtime dependencies |
| [`@lefine/cli`](./packages/lefine-cli) | Sign in, then pull, push, check and publish your app strings from the terminal |
| [`@lefine/mcp`](./packages/lefine-mcp) | Lefine as an MCP server for Claude, Cursor and other agents (same as `npx lefine mcp`) |
| [`github-action`](./github-action) | Push source texts from CI and get translations back as a pull request, with no stored secret |

## Use it with AI agents

```json
{
  "mcpServers": {
    "lefine": { "command": "npx", "args": ["-y", "lefine", "mcp"] }
  }
}
```

Agents can translate your app, edit and publish website pages, and make localized videos. You approve anything that goes live. Setup for each client: [`packages/lefine-mcp`](./packages/lefine-mcp).

## Examples

[`examples/`](./examples) has small apps that read their texts from Lefine: Next.js, Vite + React and Expo. CI builds each one on every pull request.

## Better i18n packages

The `@better-i18n/*` packages in `packages/` are the SDKs of [Better i18n](https://better-i18n.com), a separate product. They have their own docs at [docs.better-i18n.com](https://docs.better-i18n.com).

## License

[MIT](./LICENSE) — Lefine
