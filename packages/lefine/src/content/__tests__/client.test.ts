import { describe, expect, expectTypeOf, it } from "vitest";
import {
  ContentFetchError,
  ContentIntegrityError,
  createContentClient,
  type LefineRichText,
} from "../index.js";
import type { ContentManifest } from "../types.js";
import { CDN, PROJECT, createFakeEdge, readFixture } from "./fake-edge.js";

/** What `lefine content types` writes for the fixture project (see packages/cli content-types test). */
interface Post {
  title: string;
  body: LefineRichText | null;
  cover: string | null;
  tags: Array<"news" | "guide"> | null;
  sections: Array<{
    id?: string;
    blockType: "hero";
    heading: string | null;
  }> | null;
}
interface Models {
  posts: Post;
}

const MANIFEST_PATH = `/${PROJECT.workspaceId}/${PROJECT.projectId}/c/manifest.json`;

function setup(extra: Partial<Parameters<typeof createContentClient>[0]> = {}) {
  const edge = createFakeEdge();
  const content = createContentClient<Models>({
    ...PROJECT,
    cdnUrl: CDN,
    fetch: edge.fetch,
    ...extra,
  });
  return { edge, content };
}

describe("lefine/content against the edge fixture", () => {
  it("lists a content type in one language, typed, read from the edge's URL shapes", async () => {
    const { edge, content } = setup();
    const posts = await content.list("posts", { locale: "en" });
    expect(posts.map((p) => [p.slug, p.locale, p.isFallback, p.draft])).toEqual(
      [
        ["hello", "en", false, false],
        ["only-en", "en", false, false],
      ],
    );
    expectTypeOf(posts[0]!.data.title).toEqualTypeOf<string>();
    expectTypeOf(posts[0]!.data.body).toEqualTypeOf<LefineRichText | null>();
    expect(edge.requests.map((r) => r.path)).toEqual([
      MANIFEST_PATH,
      `/${PROJECT.workspaceId}/${PROJECT.projectId}/c/v/mh3k2lc0-a1b2c3d4/en/posts.json`,
    ]);
  });

  it("gets one page by slug or id; field fallback comes from the file", async () => {
    const { content } = setup();
    const hallo = await content.get("posts", { locale: "de", slug: "hello" });
    expect(hallo?.data.title).toBe("Hallo");
    expect(hallo?.fallbacks).toEqual([{ path: "body", from: "en" }]);
    expect(
      (await content.get("posts", { locale: "de", id: "ent_hello" }))?.id,
    ).toBe("ent_hello");
    expect(
      await content.get("posts", { locale: "de", slug: "nope" }),
    ).toBeNull();
    expect(
      await content
        .get("posts", { locale: "en", slug: "hello" })
        .then((p) => p?.data.sections?.[0]?.blockType),
    ).toBe("hero");
  });

  it("page fallback: pt-BR reads pt, then the project's fallback language; every spelling of a locale is one", async () => {
    const { content } = setup({ fallbackLocale: "en" });
    for (const locale of ["pt-BR", "pt_br", "PT-br"]) {
      const page = await content.get("posts", { locale, slug: "hello" });
      expect({
        locale,
        served: page?.locale,
        isFallback: page?.isFallback,
        title: page?.data.title,
      }).toEqual({ locale, served: "pt", isFallback: true, title: "Olá" });
    }
    const onlyEn = await content.get("posts", {
      locale: "pt-BR",
      slug: "only-en",
    });
    expect([onlyEn?.locale, onlyEn?.isFallback]).toEqual(["en", true]);
    const list = await content.list("posts", { locale: "pt-BR" });
    expect(list.map((p) => [p.slug, p.locale])).toEqual([
      ["hello", "pt"],
      ["only-en", "en"],
    ]);
  });

  it("no fallback language: parents only; fallback off: the language asked for only", async () => {
    expect(
      await setup().content.get("posts", { locale: "pt-BR", slug: "only-en" }),
    ).toBeNull();
    expect(
      await setup()
        .content.get("posts", { locale: "pt-BR", slug: "hello" })
        .then((p) => p?.locale),
    ).toBe("pt");
    const off = setup({ fallbackLocale: "en", fallback: false }).content;
    expect(
      await off.get("posts", { locale: "pt-BR", slug: "hello" }),
    ).toBeNull();
    expect(
      await off
        .list("posts", { locale: "de" })
        .then((l) => l.map((p) => p.slug)),
    ).toEqual(["hello"]);
  });

  it("without fallbackLocale in the config, the manifest's is used; null in the config turns it off", async () => {
    const edge = createFakeEdge();
    const original = JSON.parse(readFixture(MANIFEST_PATH)) as ContentManifest;
    edge.override.set(
      MANIFEST_PATH,
      JSON.stringify({ ...original, sourceLocale: "en", fallbackLocale: "en" }),
    );
    const fromManifest = createContentClient<Models>({
      ...PROJECT,
      cdnUrl: CDN,
      fetch: edge.fetch,
    });
    expect(
      (await fromManifest.get("posts", { locale: "pt-BR", slug: "only-en" }))
        ?.locale,
    ).toBe("en");
    const off = createContentClient<Models>({
      ...PROJECT,
      cdnUrl: CDN,
      fetch: edge.fetch,
      fallbackLocale: null,
    });
    expect(
      await off.get("posts", { locale: "pt-BR", slug: "only-en" }),
    ).toBeNull();
  });

  it("localesOf: the languages one page is live in, not every language of the project", async () => {
    const { content } = setup();
    expect(await content.localesOf("posts", { slug: "hello" })).toEqual([
      "de",
      "en",
      "pt",
    ]);
    expect(await content.localesOf("posts", { slug: "only-en" })).toEqual([
      "en",
    ]);
    expect(await content.localesOf("posts", { id: "ent_missing" })).toEqual([]);
    await expect(content.localesOf("posts", {})).rejects.toThrow(
      /slug or an id/,
    );
  });

  it("caches: the manifest for its TTL, then If-None-Match (304 keeps the copy); a versioned file is read once", async () => {
    const edge = createFakeEdge();
    const content = createContentClient<Models>({
      ...PROJECT,
      cdnUrl: CDN,
      fetch: edge.fetch,
    });
    await content.list("posts", { locale: "en" });
    await content.list("posts", { locale: "en" });
    expect(edge.requests).toHaveLength(2);

    const fast = createContentClient<Models>({
      ...PROJECT,
      cdnUrl: CDN,
      fetch: edge.fetch,
      manifestTtlMs: 0,
    });
    edge.requests.length = 0;
    await fast.list("posts", { locale: "en" });
    await fast.list("posts", { locale: "en" });
    const manifests = edge.requests.filter((r) => r.path === MANIFEST_PATH);
    expect(manifests).toHaveLength(2);
    expect(manifests[0]?.ifNoneMatch).toBeNull();
    expect(manifests[1]?.ifNoneMatch).toMatch(/^"/);
    expect(
      edge.requests.filter((r) => r.path.endsWith("/posts.json")),
    ).toHaveLength(1);
  });

  it("a newer revision is used; an older one (another data centre) is ignored", async () => {
    const { edge, content } = setup({ manifestTtlMs: 0 });
    const original = JSON.parse(readFixture(MANIFEST_PATH)) as ContentManifest;
    await content.manifest();
    edge.override.set(
      MANIFEST_PATH,
      JSON.stringify({ ...original, revision: 3, languages: ["en"] }),
    );
    expect((await content.manifest())?.revision).toBe(7);
    edge.override.set(
      MANIFEST_PATH,
      JSON.stringify({ ...original, revision: 8 }),
    );
    expect((await content.manifest())?.revision).toBe(8);
  });

  it("the edge is down: the last manifest and files keep serving; without a copy it throws", async () => {
    const { edge, content } = setup({ manifestTtlMs: 0 });
    await content.list("posts", { locale: "en" });
    edge.down = true;
    expect((await content.list("posts", { locale: "en" })).length).toBe(2);
    const cold = createContentClient({
      ...PROJECT,
      cdnUrl: CDN,
      fetch: edge.fetch,
    });
    await expect(cold.list("posts", { locale: "en" })).rejects.toBeInstanceOf(
      ContentFetchError,
    );
  });

  it("a file whose bytes do not match the manifest is refused and not cached", async () => {
    const { edge, content } = setup();
    const path = `/${PROJECT.workspaceId}/${PROJECT.projectId}/c/v/mh3k2lc0-a1b2c3d4/en/posts.json`;
    edge.override.set(path, readFixture(path).replace("Hello", "Hacked"));
    await expect(
      content.list("posts", { locale: "en" }),
    ).rejects.toBeInstanceOf(ContentIntegrityError);
    edge.override.delete(path);
    expect((await content.list("posts", { locale: "en" }))[0]?.data.title).toBe(
      "Hello",
    );
  });

  it("nothing published: an empty list and null, never an error", async () => {
    const edge = createFakeEdge();
    const content = createContentClient({
      workspaceId: "ws_acme",
      projectId: "prj_never",
      cdnUrl: CDN,
      fetch: edge.fetch,
    });
    expect(await content.list("posts", { locale: "en" })).toEqual([]);
    expect(
      await content.get("posts", { locale: "en", slug: "hello" }),
    ).toBeNull();
    expect(await content.languages()).toEqual([]);
  });

  it("unknown content type or language: empty; ids are checked up front", async () => {
    const { content } = setup();
    expect(await content.list("authors" as "posts", { locale: "en" })).toEqual(
      [],
    );
    expect(await content.list("posts", { locale: "fr" })).toEqual([]);
    expect(await content.languages()).toEqual(["de", "en", "pt"]);
    expect(() =>
      createContentClient({ workspaceId: "acme", projectId: "site" }),
    ).toThrow(/ws_/);
    await expect(content.get("posts", { locale: "en" })).rejects.toThrow(
      /slug or an id/,
    );
  });

  it("the fixture is consistent: every file the manifest names exists with its checksum", async () => {
    const manifest = JSON.parse(readFixture(MANIFEST_PATH)) as ContentManifest;
    const { createHash } = await import("node:crypto");
    for (const [lc, types] of Object.entries(manifest.files)) {
      for (const [slug, file] of Object.entries(types)) {
        const text = readFixture(
          `/${PROJECT.workspaceId}/${PROJECT.projectId}/c/v/${file.version}/${lc}/${slug}.json`,
        );
        expect(createHash("sha256").update(text).digest("hex")).toBe(
          file.sha256,
        );
        expect(JSON.parse(text).entries).toHaveLength(file.entryCount);
      }
    }
  });
});
