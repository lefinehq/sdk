import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { createProxy } from "../proxy.js";
import { fromAcceptLanguage, localize, type Routing } from "../routing.js";

const always: Routing = { locales: ["en", "de", "pt-BR"], defaultLocale: "en", prefix: "always" };
const asNeeded: Routing = { ...always, prefix: "as-needed" };

function run(r: Routing, path: string, headers: Record<string, string> = {}) {
  const res = createProxy(r)(new NextRequest(`https://acme.test${path}`, { headers }));
  return {
    status: res.status,
    location: res.headers.get("location"),
    rewrite: res.headers.get("x-middleware-rewrite"),
    vary: res.headers.get("vary"),
    cookie: res.cookies.get("NEXT_LOCALE"),
  };
}

// Rows of the test matrix in docs/strings-runtime.md (from next-intl / Paraglide / Lingui, 2026-10-26).
describe("proxy", () => {
  it("/ with Accept-Language: de redirects 307 to /de, varies on the header, and remembers the choice", () => {
    const r = run(always, "/", { "accept-language": "de-AT,de;q=0.9,en;q=0.5" });
    expect([r.status, r.location, r.vary]).toEqual([307, "https://acme.test/de", "Accept-Language, Cookie"]);
    expect(r.cookie).toMatchObject({ value: "de", path: "/", maxAge: 34560000, sameSite: "lax" });
  });

  it("the cookie wins over Accept-Language; the URL prefix wins over the cookie and updates it", () => {
    expect(run(always, "/pricing", { cookie: "NEXT_LOCALE=pt-BR", "accept-language": "de" }).location).toBe("https://acme.test/pt-BR/pricing");
    const r = run(always, "/de/pricing", { cookie: "NEXT_LOCALE=en" });
    expect([r.status, r.location, r.cookie?.value]).toEqual([200, null, "de"]);
  });

  it("no cookie and no header: the default locale", () => {
    expect(run(always, "/about").location).toBe("https://acme.test/en/about");
  });

  it("keeps the query string; a wrong case of the locale redirects to its spelling", () => {
    expect(run(always, "/about?ref=x", { "accept-language": "de" }).location).toBe("https://acme.test/de/about?ref=x");
    expect(run(always, "/PT-br/about").location).toBe("https://acme.test/pt-BR/about");
    expect(run(always, "/pricing", { cookie: "NEXT_LOCALE=pt_BR" }).location).toBe("https://acme.test/pt-BR/pricing");
  });

  it("as-needed: the default locale has no prefix (rewritten inside), others keep theirs", () => {
    expect(run(asNeeded, "/about").rewrite).toBe("https://acme.test/en/about");
    expect(run(asNeeded, "/en/about").location).toBe("https://acme.test/about");
    expect(run(asNeeded, "/de/about")).toMatchObject({ status: 200, location: null, rewrite: null });
    expect(run(asNeeded, "/about", { cookie: "NEXT_LOCALE=de" }).location).toBe("https://acme.test/de/about");
  });

  it("never redirects to another site (//evil.com, /\\evil.com, /en//evil.com)", () => {
    for (const path of ["//evil.com", "/%5Cevil.com", "/\\evil.com"]) {
      expect(new URL(run(always, path).location!).host).toBe("acme.test");
    }
    expect(new URL(run(asNeeded, "/en//evil.com").location!).host).toBe("acme.test");
  });

  it("a prefetch (Sec-Fetch-Dest: empty) does not change the remembered locale", () => {
    expect(run(always, "/de/pricing", { cookie: "NEXT_LOCALE=en", "sec-fetch-dest": "empty" }).cookie).toBeUndefined();
  });
});

describe("Accept-Language", () => {
  const r = always;
  it("q order, then position; a region falls back to its language and the other way round", () => {
    expect(fromAcceptLanguage(r, "fr;q=1, de;q=0.8, en;q=0.9")).toBe("en");
    expect(fromAcceptLanguage(r, "de-CH")).toBe("de");
    expect(fromAcceptLanguage(r, "pt")).toBe("pt-BR");
    expect(fromAcceptLanguage(r, "*, en;q=0")).toBeUndefined();
    expect(fromAcceptLanguage(r, "")).toBeUndefined();
  });
});

describe("localize", () => {
  it("adds, replaces or drops the prefix; other hrefs pass through", () => {
    expect(localize(always, "/", "de")).toBe("/de");
    expect(localize(always, "/de/about?x=1#y", "pt-BR")).toBe("/pt-BR/about?x=1#y");
    expect(localize(asNeeded, "/de/about", "en")).toBe("/about");
    expect(localize(always, "https://x.test/a", "de")).toBe("https://x.test/a");
    expect(localize(always, "#top", "de")).toBe("#top");
  });
});
