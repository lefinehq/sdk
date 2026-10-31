import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("react", () => ({ cache: (fn: () => unknown) => fn }));
vi.mock("next-intl/server", () => ({ getRequestConfig: (fn: unknown) => fn }));
vi.mock("next/headers", () => ({}));

const { createIsrFetch, MANIFEST_CACHE_TAG, MESSAGES_CACHE_TAG } = await import("../server.js");
const { normalizeConfig } = await import("../config.js");

const BASE = "https://cdn.test.com/acme/web";

describe("createIsrFetch", () => {
  const calls: Array<{ url: string; init: Record<string, unknown> }> = [];

  beforeEach(() => {
    calls.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: Record<string, unknown>) => {
        calls.push({ url, init });
        return new Response("{}");
      }),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it("tags the manifest request so the webhook's revalidateTag reaches it, with a short window", async () => {
    await createIsrFetch(60, [MANIFEST_CACHE_TAG])(`${BASE}/manifest.json`, {
      headers: { "If-None-Match": '"m1"' },
      cache: "no-store",
    });
    expect(calls[0]!.init.next).toEqual({ revalidate: 60, tags: ["i18n-manifest"] });
    // `cache` and `next.revalidate` together make Next throw.
    expect(calls[0]!.init.cache).toBeUndefined();
    // The conditional header still goes through.
    expect(calls[0]!.init.headers).toEqual({ "If-None-Match": '"m1"' });
  });

  it("caches an immutable snapshot URL forever, not for the messages window", async () => {
    await createIsrFetch(5, [MESSAGES_CACHE_TAG])(`${BASE}/v/mgz1k2lc-0a1b2c3d/de/translations.json`);
    expect(calls[0]!.init.next).toEqual({ revalidate: false, tags: ["i18n-messages"] });
  });

  it("a legacy path or a look-alike keeps the revalidate window", async () => {
    const f = createIsrFetch(5, [MESSAGES_CACHE_TAG]);
    await f(`${BASE}/de/translations.json`);
    await f(`${BASE}/v/not-a-version/de/translations.json`);
    expect(calls.map((c) => (c.init.next as { revalidate: unknown }).revalidate)).toEqual([5, 5]);
  });
});

describe("manifest revalidate default", () => {
  it("is 60 s in production, not 3600 s", () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";
    try {
      const config = normalizeConfig({ project: "acme/web", defaultLocale: "en" });
      expect(config.manifestRevalidateSeconds).toBe(60);
      expect(
        normalizeConfig({ project: "acme/web", defaultLocale: "en", manifestRevalidateSeconds: 300 })
          .manifestRevalidateSeconds,
      ).toBe(300);
    } finally {
      process.env.NODE_ENV = prev;
    }
  });
});
