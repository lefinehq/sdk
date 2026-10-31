// Locale rules shared by the proxy, Link and alternates, so the three agree. No Next import.

import { cdnLocale } from "../locale.js";

export type Prefix = "always" | "as-needed";

export interface Routing {
  locales: readonly string[];
  defaultLocale: string;
  prefix: Prefix;
}

/** The configured spelling of a locale, however it is written (`pt-br`, `pt_BR` -> `pt-BR`). */
export function findLocale(r: Routing, value: string | null | undefined): string | undefined {
  const wanted = value ? cdnLocale(value) : "";
  return wanted ? r.locales.find((l) => cdnLocale(l) === wanted) : undefined;
}

/**
 * Best locale for an Accept-Language header, by q then order: the exact tag, then its language (`de-AT` -> `de`),
 * then another region of it (`de` -> `de-CH`). next-intl uses negotiator + @formatjs/intl-localematcher for this.
 */
export function fromAcceptLanguage(r: Routing, header: string | null): string | undefined {
  if (!header) return undefined;
  const base = (tag: string) => tag.split("-")[0]!.toLowerCase();
  const wanted = header
    .split(",")
    .map((part, i) => {
      const [tag = "", ...params] = part.trim().split(";");
      const q = params.find((p) => p.trim().startsWith("q="));
      return { tag: tag.trim(), q: q ? Number(q.trim().slice(2)) || 0 : 1, i };
    })
    .filter((w) => w.tag && w.tag !== "*" && w.q > 0)
    .sort((a, b) => b.q - a.q || a.i - b.i);
  for (const { tag } of wanted) {
    const hit = findLocale(r, tag) ?? findLocale(r, base(tag)) ?? r.locales.find((l) => base(l) === base(tag));
    if (hit) return hit;
  }
  return undefined;
}

/** `/de/about` -> `{ locale: "de", segment: "de", rest: "/about" }`; no known prefix -> locale undefined. */
export function split(r: Routing, pathname: string): { locale?: string; segment?: string; rest: string } {
  const m = /^\/([^/]+)(\/.*)?$/.exec(pathname);
  const locale = findLocale(r, m?.[1]);
  return locale ? { locale, segment: m![1], rest: m![2] ?? "/" } : { rest: pathname };
}

/** One leading slash: `//evil.com` and `/\evil.com` are another site to a browser. */
export const safe = (path: string) => `/${path.replace(/^[/\\]+/, "")}`;

export const prefixed = (r: Routing, locale: string) => r.prefix === "always" || locale !== r.defaultLocale;

/** An app path (`/about?x=1`) as the URL for `locale` (`/de/about?x=1`). Other hrefs pass through. */
export function localize(r: Routing, href: string, locale: string): string {
  if (!href.startsWith("/") || href.startsWith("//")) return href;
  const cut = href.search(/[?#]/);
  const path = split(r, cut === -1 ? href : href.slice(0, cut)).rest;
  const tail = cut === -1 ? "" : href.slice(cut);
  if (!prefixed(r, locale)) return safe(path) + tail;
  return (path === "/" ? `/${locale}` : `/${locale}${safe(path)}`) + tail;
}
