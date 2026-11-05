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

// app/[locale]/layout.tsx  <- this is the ROOT layout: move <html> and <body> here and delete app/layout.tsx
// and app/page.tsx (`npx lefine init` does the move for a fresh create-next-app).
import { notFound } from "next/navigation";
import { lefine } from "../../lefine";

// Required with Cache Components (create-next-app's default): without it `next build` stops with
// "A required root parameter (locale) was not provided in generateStaticParams for /[locale]".
export const generateStaticParams = () => lefine.locales.map((locale) => ({ locale }));

export default async function LocaleLayout({ children, params }: { children: React.ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!lefine.locales.includes(locale)) notFound();
  return (
    <html lang={locale}>
      <body>
        <lefine.Provider locale={locale} namespaces={["nav"]}>{children}</lefine.Provider>
      </body>
    </html>
  );
}

// app/[locale]/page.tsx
const t = await lefine.getStrings(locale, "home");     // t("title"); t.rich("terms", { a: (chunks) => <a href="/terms">{chunks}</a> })

// a client component
const t = useStrings("nav");             // import { useStrings } from "lefine/react"; Link from "lefine/next/link"
```

`next build` needs the edge (`cdn.lefine.ai`) for the texts. To build when it is away, run `npx lefine strings snapshot`
first and pass the file: `createLefine({ ..., snapshot })` (`import snapshot from "./lefine-snapshot.json"`). With a
snapshot, an edge that is down logs one warning and the build uses the snapshot; without one, the build stops with one
error that says so.

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
