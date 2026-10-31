import { afterEach, describe, expect, it } from "vitest";
import { ContentPreviewError, createContentClient } from "../index.js";
import { localizeData, type ModelField } from "../localize.js";

/** The `posts` model as `content.collections.get` returns it (Payload-style fields). */
const FIELDS: ModelField[] = [
  { type: "text", name: "title", localized: true },
  { type: "richText", name: "body", localized: true },
  { type: "upload", name: "cover" },
  {
    type: "tabs",
    tabs: [
      {
        fields: [
          {
            type: "group",
            fields: [{ type: "text", name: "kicker", localized: true }],
          },
        ],
      },
      {
        name: "seo",
        fields: [{ type: "text", name: "metaTitle", localized: true }],
      },
    ],
  },
  {
    type: "blocks",
    name: "sections",
    blocks: [
      {
        slug: "hero",
        fields: [{ type: "text", name: "heading", localized: true }],
      },
    ],
  },
];

const rt = (text: string) => ({
  root: {
    type: "root",
    children: [
      { type: "paragraph", children: text ? [{ type: "text", text }] : [] },
    ],
  },
});

const DRAFT = {
  id: "ent_hello",
  collectionId: "col_posts",
  slug: "hello",
  locales: [{ locale: "en" }, { locale: "pt-BR" }],
  data: {
    title: { en: "Hello DRAFT", "pt-BR": "Olá RASCUNHO" },
    body: { en: rt("English body"), "pt-BR": rt("") },
    cover: "med_1",
    kicker: { en: "New" },
    seo: { metaTitle: { pt: "Meta PT" } },
    sections: [
      {
        id: "r1",
        blockType: "hero",
        heading: { en: "Welcome", "pt-BR": "Bem-vindo" },
      },
      { id: "r2", blockType: "removed", heading: { en: "x" } },
    ],
  },
};

function fakeOps() {
  const calls: Array<{
    name: string;
    input: Record<string, unknown>;
    auth: string | null;
  }> = [];
  const fetch = async (input: string, init?: RequestInit) => {
    const name = input.split("/v1/ops/")[1] ?? "";
    const body = JSON.parse(String(init?.body)) as {
      input: Record<string, unknown>;
    };
    calls.push({
      name,
      input: body.input,
      auth: new Headers(init?.headers).get("authorization"),
    });
    const ok = (data: unknown) =>
      new Response(JSON.stringify({ ok: true, data }), { status: 200 });
    if (
      new Headers(init?.headers).get("authorization") !== "Bearer lfn_preview"
    )
      return new Response(
        JSON.stringify({
          ok: false,
          error: { code: "UNAUTHORIZED", message: "invalid key" },
        }),
        { status: 401 },
      );
    switch (name) {
      case "content.projects.list":
        return ok({
          items: [
            {
              id: "prj_site",
              sourceLocale: "en",
              targetLocales: ["pt", "pt-BR"],
              fallbackLocale: "en",
            },
          ],
        });
      case "content.collections.list":
        return ok({
          items: [{ id: "col_posts", slug: "posts", kind: "collection" }],
        });
      case "content.collections.get":
        return ok({ id: "col_posts", slug: "posts", fields: FIELDS });
      case "content.entries.list":
        return ok({ items: [{ id: "ent_hello", slug: "hello" }], total: 1 });
      case "content.entries.get":
        return body.input.entryId === "ent_hello"
          ? ok(DRAFT)
          : new Response(
              JSON.stringify({
                ok: false,
                error: { code: "NOT_FOUND", message: "no page" },
              }),
              { status: 404 },
            );
      default:
        return new Response("{}", { status: 404 });
    }
  };
  return { calls, fetch };
}

describe("preview: drafts through the ops API", () => {
  const client = (
    fetch: ReturnType<typeof fakeOps>["fetch"],
    key = "lfn_preview",
  ) =>
    createContentClient({
      workspaceId: "ws_acme",
      projectId: "prj_site",
      preview: { key, apiUrl: "http://api.test" },
      fetch,
    });

  it("reads the draft in one language with the project's chain, and marks the fields that fell back", async () => {
    const ops = fakeOps();
    const page = await client(ops.fetch).get("posts", {
      locale: "pt-BR",
      slug: "hello",
    });
    expect(page).toMatchObject({
      id: "ent_hello",
      locale: "pt-br",
      isFallback: false,
      draft: true,
      publishedAt: null,
    });
    expect(page?.data).toEqual({
      title: "Olá RASCUNHO",
      body: rt("English body"),
      cover: "med_1",
      kicker: "New",
      seo: { metaTitle: "Meta PT" },
      sections: [{ id: "r1", blockType: "hero", heading: "Bem-vindo" }, null],
    });
    expect(page?.fallbacks).toEqual([
      { path: "body", from: "en" },
      { path: "kicker", from: "en" },
      { path: "seo.metaTitle", from: "pt" },
    ]);
    expect(ops.calls.every((c) => c.auth === "Bearer lfn_preview")).toBe(true);
  });

  it("list, a missing page, a page of another type, a missing type", async () => {
    const ops = fakeOps();
    const c = client(ops.fetch);
    expect(
      (await c.list("posts", { locale: "en" })).map((p) => p.data.title),
    ).toEqual(["Hello DRAFT"]);
    expect(await c.get("posts", { locale: "en", id: "ent_gone" })).toBeNull();
    expect(await c.get("authors", { locale: "en", slug: "hello" })).toBeNull();
    expect(c.preview).toBe(true);
  });

  it("localesOf in preview: every language the draft has", async () => {
    const c = client(fakeOps().fetch);
    expect(await c.localesOf("posts", { slug: "hello" })).toEqual([
      "en",
      "pt-br",
    ]);
    expect(await c.localesOf("posts", { id: "ent_gone" })).toEqual([]);
  });

  it("a bad key says so with the server's code", async () => {
    await expect(
      client(fakeOps().fetch, "lfn_wrong").get("posts", {
        locale: "en",
        slug: "hello",
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      client(fakeOps().fetch, "lfn_wrong").list("posts", { locale: "en" }),
    ).rejects.toBeInstanceOf(ContentPreviewError);
  });

  describe("in a browser", () => {
    const g = globalThis as Record<string, unknown>;
    afterEach(() => {
      delete g.window;
      delete g.document;
    });
    it("refuses to start: the key is a secret", () => {
      g.window = {};
      g.document = {};
      expect(() => client(fakeOps().fetch)).toThrow(/server only/);
    });
  });
});

describe("localizeData", () => {
  it("a localized list is picked whole; a rich text without words is empty; no chain value gives null", () => {
    const fields: ModelField[] = [
      {
        type: "array",
        name: "faq",
        localized: true,
        fields: [{ type: "text", name: "q", localized: true }],
      },
      { type: "richText", name: "body", localized: true },
      { type: "text", name: "subtitle", localized: true },
      {
        type: "group",
        name: "meta",
        fields: [{ type: "checkbox", name: "featured" }],
      },
    ];
    const out = localizeData(
      fields,
      {
        faq: { de: [{ q: "Was?" }], en: [{ q: "What?" }] },
        body: { de: rt(" "), en: rt("Hi") },
        meta: { featured: true },
      },
      ["de", "en"],
    );
    expect(out.data).toEqual({
      faq: [{ q: "Was?" }],
      body: rt("Hi"),
      subtitle: null,
      meta: { featured: true },
    });
    expect(out.fallbacks).toEqual([{ path: "body", from: "en" }]);
  });

  it("does not read inherited keys", () => {
    const out = localizeData([{ type: "text", name: "constructor" }], {}, [
      "en",
    ]);
    expect(out.data).toEqual({ constructor: null });
  });
});
