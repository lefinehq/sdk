# lefine

Strings and content from Lefine for your app. No runtime dependencies.

```sh
npm i lefine && npx lefine init          # signs in, picks the app, writes lefine.ts with its id
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
const t = useStrings("nav");             // import { useStrings } from "lefine/react"; Link from "lefine/next/link"
```

| Import | What | Size (gzip) |
|---|---|---|
| `lefine/next` | `createLefine`: `proxy`, `getStrings`, `Provider`, `alternates`, `revalidate`, `locales` | server |
| `lefine/next/link` | `Link` that keeps the locale (Next.js) | client |
| `lefine/server` | `createStrings`: `getStrings`, `load`, for TanStack Start and any React SSR | server |
| `lefine/react` | `useStrings`, `StringsProvider` (any React) | 1.7 KB |
| `lefine/strings` | `createTranslator`, `format`, for any runtime | 1.2 KB |
| `lefine/content` | `createContentClient` for Lefine Content (`list`, `get`, `global`); `renderBlocks` (throws on an unknown or invalid block) | 4.8 KB |
| `lefine/content/react` | `RichText`: a rich text field as React, the same tags as Lefine's HTML (closed node set, safe links) | client |
| `lefine/content/vue` | `RichText`: a rich text field as Vue 3, the same tags as `lefine/content/react` | client |
| `lefine/content/media` | `mediaUrl(project, mediaId, size)`: the edge URL of an image or file an upload field holds | 0.2 KB |
| `lefine/content/config` | `defineContent`: content types in your repo, for `npx lefine content push` (diff first, never deletes) | build |
| `lefine/content/live-preview` | `onDocumentSaved`, `ready`: follow Lefine's editor on a draft page; `/react`: `<RefreshOnSave refresh={router.refresh} />` | client |
| `lefine/compile` | `compile`, `compileMessages` (server, build) | server |
| `npx lefine` | `init`, `login`, `strings pull/push/check/publish/types`, `content types`, `content push`, `mcp` | CLI |
