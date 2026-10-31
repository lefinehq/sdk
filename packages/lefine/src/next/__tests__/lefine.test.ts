import { createHash } from "node:crypto";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  usePathname: () => "/de/pricing",
}));
/** Next's cache in memory, keyed like unstable_cache (key parts + arguments); records each cache's options. */
const caches: Array<{ keyParts: string[]; options: { tags?: string[]; revalidate?: number | false } }> = [];
const store = new Map<string, unknown>();
vi.mock("next/cache", () => ({
  revalidateTag: () => store.clear(),
  unstable_cache: (fn: (...a: unknown[]) => Promise<unknown>, keyParts: string[], options: { tags?: string[]; revalidate?: number | false }) => {
    caches.push({ keyParts, options });
    return async (...args: unknown[]) => {
      const key = JSON.stringify([keyParts, args]);
      if (!store.has(key)) store.set(key, await fn(...args)); // a thrown error is not kept, as in Next
      return store.get(key);
    };
  },
}));
const { createLefine } = await import("../index.js");
const { compileMessages } = await import("../../strings/compile.js");
const { flightRender } = await import("./flight.js");

const APP = "app_0123456789abcdef0123456789abcdef";
const V = "mh3k2lc0-a1b2c3d4";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const TEXTS: Record<string, string> = {
  en: JSON.stringify({ home: { title: "Hello {name}" }, nav: { pricing: "Pricing" }, admin: { secret: "x" } }),
  de: JSON.stringify({ home: { title: "Hallo {name}" }, nav: { pricing: "Preise" }, admin: { secret: "x" } }),
};

let n = 0;
/** A Lefine edge for one app id; `ir` serves messages.ir.json too. Records each request's Next cache options. */
function edge(ir = false, extra: Partial<Parameters<typeof createLefine>[0]> = {}) {
  const app = `${APP.slice(0, -2)}${String(++n).padStart(2, "0")}`; // a fresh app per test: the loader caches per app
  const seen: Array<{ path: string; next: unknown; headers?: Record<string, string> }> = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit & { next?: unknown }) => {
    const path = new URL(String(input)).pathname;
    seen.push({ path, next: init?.next, headers: init?.headers as Record<string, string> });
    if (path === `/${app}/manifest.json`) {
      const files = Object.fromEntries(Object.entries(TEXTS).map(([lc, body]) => [lc, { version: V, sha256: sha(body), keyCount: 3, ...(ir ? { ir: true } : {}) }]));
      return Response.json({ schema: 2, revision: 1, languages: [{ code: "en" }, { code: "de" }], files }, { headers: { etag: '"m1"' } });
    }
    const m = /\/v\/[^/]+\/([^/]+)\/(translations|messages\.ir)\.json$/.exec(path);
    if (m && m[2] === "translations") return new Response(TEXTS[m[1]!]);
    if (m && ir) return Response.json({ format: 1, sha256: sha(TEXTS[m[1]!]!), messages: { ...compileMessages(JSON.parse(TEXTS[m[1]!]!)), home: { title: "from IR" } } });
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { lefine: createLefine({ project: app, locales: ["en", "de"], defaultLocale: "en", cdn: "https://cdn.test", ...extra }), seen };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("createLefine", () => {
  it("getStrings reads the app id path, compiles on the server, and tags every fetch for the webhook", async () => {
    const { lefine, seen } = edge();
    const t = await lefine.getStrings("de", "home");
    expect(t("title", { name: "Ada" })).toBe("Hallo Ada");
    // The manifest, then the texts; no compiled file is asked for, since this manifest lists none.
    expect(seen.map((s) => s.path.split("/").pop())).toEqual(["manifest.json", "translations.json"]);
    // Through unstable_cache (Cache Components ignore fetch's own cache options): the manifest kept 60 s, a
    // versioned file until a webhook, both tagged for it.
    expect(caches.map((c) => c.options)).toEqual([
      { tags: ["lefine-strings"], revalidate: false },
      { tags: ["lefine-strings"], revalidate: 60 },
    ]);
    for (const s of seen) expect(s.next).toBeUndefined();
  });

  it("under Next's cache the manifest is asked once and without If-None-Match (audit, unverified point 1)", async () => {
    const { lefine, seen } = edge();
    await lefine.getStrings("de", "home");
    await lefine.getStrings("de", "home");
    const manifests = seen.filter((s) => s.path.endsWith("/manifest.json"));
    expect(manifests.length).toBe(1);
    for (const m of manifests) expect(Object.keys(m.headers ?? {}).map((h) => h.toLowerCase())).not.toContain("if-none-match");
  });

  it("uses the edge's compiled file when it has one", async () => {
    const { lefine } = edge(true);
    expect((await lefine.getStrings("en", "home"))("title")).toBe("from IR");
  });

  it("an unknown locale is a 404 page", async () => {
    const { lefine } = edge();
    await expect(lefine.getStrings("fr")).rejects.toThrow("NEXT_NOT_FOUND");
  });

  it("Provider sends only the namespaces it names; Link keeps or switches the locale", async () => {
    const { lefine } = edge();
    const { useStrings } = await import("../../react/index.js");
    const { Link } = await import("../link.js");
    const { createElement: h } = await import("react");
    function Nav() {
      const t = useStrings("nav");
      return h("nav", null, h(Link, { href: "/pricing" }, t("pricing")), h(Link, { locale: "en" }, "English"));
    }
    const element = await lefine.Provider({ locale: "de", namespaces: ["nav"], children: h(Nav) });
    expect(Object.keys((element.props as { messages: object }).messages)).toEqual(["nav"]);
    expect(renderToStaticMarkup(element)).toBe('<nav><a href="/de/pricing">Preise</a><a hrefLang="en" href="/en/pricing">English</a></nav>');
  });

  it("what Provider hands the Client Component survives React Flight, on the compile path and the IR path (audit #2)", async () => {
    for (const ir of [false, true]) {
      const { lefine } = edge(ir);
      const element = await lefine.Provider({ locale: "de", namespaces: ["home", "nav"] });
      const { children: _none, ...props } = element.props as Record<string, unknown>;
      expect((await flightRender(props)).errors).toEqual([]);
    }
  });

  it("timeZone, formats and onError reach getStrings; Provider sends timeZone and formats to the client (audit #7)", async () => {
    const errors: string[] = [];
    const { lefine } = edge(false, {
      timeZone: "Asia/Tokyo",
      formats: { number: { money: { style: "currency", currency: "EUR" } } },
      onError: (e) => void errors.push(`${e.code}:${e.name}`),
    });
    const t = await lefine.getStrings("en", "home");
    expect(t("missing" as never)).toBe("home.missing");
    expect(errors).toEqual(["MISSING_MESSAGE:home.missing"]);
    const element = await lefine.Provider({ locale: "en", namespaces: ["nav"] });
    expect(element.props).toMatchObject({ timeZone: "Asia/Tokyo", formats: { number: { money: { style: "currency", currency: "EUR" } } } });
    expect(() => createLefine({ project: APP, locales: ["en"], defaultLocale: "en", timeZone: "Mars/Base" })).toThrow('timeZone "Mars/Base"');
  });

  it("outside production a missing key says once what to do (Do next 7, dev-time hook)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { lefine } = edge();
    const t = await lefine.getStrings("de", "home");
    t("nope" as never);
    t("nope" as never);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('no text for "home.nope" in de. Add the key in Lefine');
    warn.mockRestore();
  });

  it("t.rich keys its elements on the server and in nested tags, so React does not warn (audit #8)", async () => {
    const { createElement: h } = await import("react");
    const { createTranslator } = await import("../../strings/translator.js");
    const { keyed } = await import("../../react/keyed.js");
    const rich = keyed(createTranslator({ locale: "en", messages: compileMessages({ a: { x: "<b>one <i>two</i> three</b> and <i>four</i>" } }) }));
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const html = renderToStaticMarkup(h("p", null, rich.rich("a.x", { b: (c: unknown) => h("b", null, c as never), i: (c: unknown) => h("i", null, c as never) }) as never));
    expect(html).toBe("<p><b>one <i>two</i> three</b> and <i>four</i></p>");
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("alternates: canonical, every locale and x-default", () => {
    const { lefine } = edge();
    expect(lefine.alternates("de", "/pricing")).toEqual({ canonical: "/de/pricing", languages: { en: "/en/pricing", de: "/de/pricing", "x-default": "/en/pricing" } });
  });

  it("refuses a name for project and a defaultLocale outside locales, saying what to do", () => {
    expect(() => createLefine({ project: "acme/web", locales: ["en"], defaultLocale: "en" })).toThrow("App id");
    expect(() => createLefine({ project: APP, locales: ["en"], defaultLocale: "de" })).toThrow('defaultLocale "de" is not in locales');
  });
});
