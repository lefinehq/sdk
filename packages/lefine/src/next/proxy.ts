import { NextResponse, type NextRequest } from "next/server";
import { findLocale, fromAcceptLanguage, prefixed, safe, split, type Routing } from "./routing.js";

const COOKIE = "NEXT_LOCALE";
const YEAR = 400 * 24 * 60 * 60; // the longest a browser keeps a cookie

/**
 * The locale proxy (proxy.ts on Next 16, middleware.ts before). Order: URL prefix, NEXT_LOCALE cookie,
 * Accept-Language, defaultLocale (next-intl's order). Unprefixed URLs redirect (307) to their locale, or under
 * "as-needed" the default locale is rewritten to `/{locale}/...` so `app/[locale]` renders it.
 */
export function createProxy(r: Routing) {
  return function proxy(request: NextRequest): NextResponse {
    const { pathname, search } = request.nextUrl;
    const { locale: inPath, segment, rest } = split(r, pathname);
    const to = (path: string) => new URL(safe(path) + search, request.url);

    let response: NextResponse;
    let locale: string;
    if (inPath) {
      locale = inPath;
      if (!prefixed(r, locale)) response = NextResponse.redirect(to(rest), 307);
      else if (segment !== locale) response = NextResponse.redirect(to(`/${locale}${rest === "/" ? "" : rest}`), 307);
      else response = NextResponse.next();
    } else {
      locale = findLocale(r, request.cookies.get(COOKIE)?.value) ?? fromAcceptLanguage(r, request.headers.get("accept-language")) ?? r.defaultLocale;
      const target = `/${locale}${pathname === "/" ? "" : safe(pathname)}`;
      response = prefixed(r, locale) ? NextResponse.redirect(to(target), 307) : NextResponse.rewrite(to(target));
      // The answer depends on these: a CDN must not give one visitor's locale to another.
      response.headers.set("Vary", "Accept-Language, Cookie");
    }

    // Only on page loads: a prefetch of another locale's link must not change the visitor's choice.
    const dest = request.headers.get("sec-fetch-dest");
    if ((!dest || dest === "document") && request.cookies.get(COOKIE)?.value !== locale) {
      response.cookies.set(COOKIE, locale, { path: "/", maxAge: YEAR, sameSite: "lax" });
    }
    return response;
  };
}
