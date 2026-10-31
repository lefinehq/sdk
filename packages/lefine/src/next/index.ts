// lefine/next: createLefine, the one setup call for a Next.js App Router app. Server only.

import { notFound } from "next/navigation";
import { createElement, type ReactNode } from "react";
import { StringsProvider } from "../react/context.js";
import { keyed } from "../react/keyed.js";
import { createCore, type ServerConfig } from "../server/index.js";
import type { KeyOf, Namespace, Translator } from "../strings/translator.js";
import { nextFetch } from "./fetch.js";
import { createProxy } from "./proxy.js";
import { revalidate } from "./revalidate.js";
import { findLocale, localize, type Prefix, type Routing } from "./routing.js";

export interface LefineConfig extends ServerConfig {
  locales: readonly string[];
  defaultLocale: string;
  /** `always` (default): every URL has a locale prefix. `as-needed`: the default locale has none. */
  prefix?: Prefix;
}

export function createLefine(config: LefineConfig) {
  const routing: Routing = { locales: config.locales, defaultLocale: config.defaultLocale, prefix: config.prefix ?? "always" };
  if (!config.locales.includes(config.defaultLocale)) {
    throw new Error(`lefine: defaultLocale "${config.defaultLocale}" is not in locales (${config.locales.join(", ")}).`);
  }
  // Next's data cache holds the manifest; the loader's own copy must not outlive a publish webhook. (A 10 s in-memory
  // copy with stale-while-revalidate was measured on 2026-10-27: no gain over the noise, and it would let another
  // instance serve old texts after a webhook. bench/ and docs/benchmark.md.)
  // No promise shared between renders: with Cache Components the layout's Provider and the page's getStrings, awaiting
  // one manifest request, stopped `next build` of a fresh create-next-app 16.4 (2026-10-28). Next's cache dedupes.
  const core = createCore(config, { fetch: nextFetch, manifestTtlMs: 0, shareInFlight: false, wrap: keyed });
  /** The configured spelling of a locale; an unknown one is a 404 page. */
  const known = (locale: string): string => findLocale(routing, locale) ?? notFound();

  return {
    locales: config.locales,

    /** proxy.ts: `export default lefine.proxy`. */
    proxy: createProxy(routing),

    /** Server Components and generateMetadata: `const t = await lefine.getStrings(locale, "home")`. */
    async getStrings<N extends Namespace | undefined = undefined>(locale: string, namespace?: N): Promise<Translator<KeyOf<N>, N>> {
      return core.getStrings(known(locale), namespace);
    },

    /** In app/[locale]/layout.tsx. Only the namespaces named here reach the browser. */
    async Provider({ locale, namespaces, children }: { locale: string; namespaces: readonly string[]; children?: ReactNode }) {
      // onError stays on the server: a function cannot be sent to the browser.
      return createElement(StringsProvider, { ...(await core.load(known(locale), namespaces)), routing }, children);
    },

    /** `alternates` for generateMetadata: canonical and hreflang for every locale, plus x-default. */
    alternates(locale: string, pathname: string) {
      const languages: Record<string, string> = {};
      for (const l of config.locales) languages[l] = localize(routing, pathname, l);
      languages["x-default"] = localize(routing, pathname, config.defaultLocale);
      return { canonical: localize(routing, pathname, findLocale(routing, locale) ?? config.defaultLocale), languages };
    },

    /** app/api/lefine/route.ts: `export const POST = lefine.revalidate`. */
    revalidate: (request: Request) => revalidate(request),
  };
}
