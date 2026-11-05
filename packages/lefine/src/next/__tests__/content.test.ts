import { beforeEach, describe, expect, it, vi } from "vitest";

const store = new Map<string, unknown>();
const tags: string[][] = [];
vi.mock("next/cache", () => ({
  revalidateTag: () => store.clear(),
  unstable_cache: (fn: (...a: unknown[]) => Promise<unknown>, keyParts: string[], options: { tags?: string[] }) => {
    tags.push(options.tags ?? []);
    return async (...args: unknown[]) => {
      const key = JSON.stringify([keyParts, args]);
      if (!store.has(key)) store.set(key, await fn(...args));
      return store.get(key);
    };
  },
}));
let draft = false;
const enable = vi.fn(() => {
  draft = true;
});
const disable = vi.fn(() => {
  draft = false;
});
vi.mock("next/headers", () => ({ draftMode: async () => ({ get isEnabled() { return draft; }, enable, disable }) }));
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new Error("NEXT_NOT_FOUND");
  },
  redirect: (to: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { to });
  },
}));

const { createNextContent, createNextContentClient, CONTENT_TAG } = await import("../content.js");
const { createFakeEdge, CDN, PROJECT } = await import("../../content/__tests__/fake-edge.js");

const edge = createFakeEdge();
beforeEach(() => {
  store.clear();
  draft = false;
  enable.mockClear();
  disable.mockClear();
  edge.requests.length = 0;
  globalThis.fetch = vi.fn((input: RequestInfo | URL, init?: RequestInit) => edge.fetch(String(input), init)) as typeof fetch;
});

const cfg = { ...PROJECT, cdnUrl: CDN };

describe("createNextContentClient", () => {
  it("reads through Next's cache under the content tag; a second client reads the cache, not the edge", async () => {
    const first = createNextContentClient(cfg);
    expect(await first.languages()).not.toEqual([]);
    expect(tags.some((t) => t.includes(CONTENT_TAG))).toBe(true);
    const calls = edge.requests.length;
    expect(calls).toBeGreaterThan(0);
    const second = createNextContentClient(cfg);
    await second.languages();
    expect(edge.requests.length).toBe(calls);
  });

  it("after the tag is expired it asks the edge again", async () => {
    const client = createNextContentClient(cfg);
    await client.manifest();
    const calls = edge.requests.length;
    const { revalidateTag } = await import("next/cache");
    revalidateTag(CONTENT_TAG);
    await client.manifest();
    expect(edge.requests.length).toBeGreaterThan(calls);
  });
});

describe("the draft getter", () => {
  const content = () => createNextContent({ ...cfg, preview: { key: "lfn_test" }, previewSecret: "s3cret" });

  it("returns the published client until draft mode is on, then the preview client", async () => {
    const c = content();
    expect((await c.get()).preview).toBe(false);
    draft = true;
    expect((await c.get()).preview).toBe(true);
  });

  it("without a preview key it stays published even in draft mode", async () => {
    draft = true;
    expect((await createNextContent(cfg).get()).preview).toBe(false);
  });

  it("enable checks the secret, turns draft mode on and redirects to a path on this site", async () => {
    const c = content();
    const bad = await c.draft.enable(new Request("https://x.test/api/lefine/draft?secret=nope"));
    expect(bad.status).toBe(401);
    expect(enable).not.toHaveBeenCalled();
    await expect(c.draft.enable(new Request("https://x.test/d?secret=s3cret&redirect=/blog/a"))).rejects.toMatchObject({ to: "/blog/a" });
    expect(enable).toHaveBeenCalledOnce();
    await expect(c.draft.enable(new Request("https://x.test/d?secret=s3cret&redirect=//evil.test"))).rejects.toMatchObject({ to: "/" });
  });

  it("enable without any secret configured says what to set", async () => {
    delete process.env.LEFINE_PREVIEW_SECRET;
    const res = await createNextContent({ ...cfg, preview: { key: "k" } }).draft.enable(new Request("https://x.test/d?secret=x"));
    expect(res.status).toBe(500);
  });

  it("disable turns draft mode off", async () => {
    draft = true;
    await expect(content().draft.disable(new Request("https://x.test/d?redirect=/p"))).rejects.toMatchObject({ to: "/p" });
    expect(disable).toHaveBeenCalledOnce();
  });

  it("redirect refuses tricks that browsers turn into another origin", async () => {
    const tricks = ["/%09/evil.test", "/%0A/evil.test", "/%5Cevil.test", "https://evil.test/", "//evil.test", "evil.test"];
    for (const t of tricks) {
      await expect(content().draft.disable(new Request(`https://x.test/d?redirect=${t}`))).rejects.toMatchObject({ to: "/" });
    }
    await expect(content().draft.disable(new Request("https://x.test/d?redirect=%2Fblog%3Fa%3D1%23top"))).rejects.toMatchObject({ to: "/blog?a=1#top" });
  });
});

