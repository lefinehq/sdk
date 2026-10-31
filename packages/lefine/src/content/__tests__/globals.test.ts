// global(): the one document of a global content type (a footer, the navigation), as the edge delivers it
// (a file of its own, `kind: "global"`, entries = [the document]). Published from the edge, drafts through content.globals.get.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createContentClient } from "../index.js";
import type { ContentManifest } from "../types.js";
import { CDN, PROJECT, createFakeEdge, readFixture } from "./fake-edge.js";

const MANIFEST_PATH = `/${PROJECT.workspaceId}/${PROJECT.projectId}/c/manifest.json`;
const VERSION = "mh9glob1-f00f00f0";
const sha = (body: string) => createHash("sha256").update(body).digest("hex");

type Models = { footer: { copyright: string }; posts: { title: string } };

/** The fixture's manifest with a footer published in English only (revision 8). */
function withFooter() {
  const edge = createFakeEdge();
  const body = JSON.stringify({ collection: "footer", kind: "global", locale: "en", entries: [{ id: "ent_footer", slug: null, publishedAt: "2026-10-30T10:00:00.000Z", data: { copyright: "(c) Acme" }, fallbacks: [] }] });
  const original = JSON.parse(readFixture(MANIFEST_PATH)) as ContentManifest;
  const files = structuredClone(original.files);
  files.en!.footer = { version: VERSION, sha256: sha(body), size: Buffer.byteLength(body), entryCount: 1, publishedAt: "2026-10-30T10:00:00.000Z" };
  edge.override.set(MANIFEST_PATH, JSON.stringify({ ...original, revision: 8, files, fallbackLocale: "en" }));
  edge.override.set(`/${PROJECT.workspaceId}/${PROJECT.projectId}/c/v/${VERSION}/en/footer.json`, body);
  const content = createContentClient<Models>({ ...PROJECT, cdnUrl: CDN, fetch: edge.fetch });
  return { edge, content };
}

describe("global() from the edge", () => {
  it("reads the one document, typed, in the language asked for", async () => {
    const footer = await withFooter().content.global("footer", { locale: "en" });
    expect(footer).toMatchObject({ id: "ent_footer", slug: null, locale: "en", isFallback: false, draft: false, data: { copyright: "(c) Acme" } });
    if (footer) {
      const copyright: string = footer.data.copyright;
      expect(copyright).toBe("(c) Acme");
    }
  });

  it("a language it is not live in reads the next one of the chain, and says so", async () => {
    expect(await withFooter().content.global("footer", { locale: "de" })).toMatchObject({ locale: "en", isFallback: true });
  });

  it("not published anywhere: null; a content type with a list: an error that names list() and get()", async () => {
    const { content } = withFooter();
    expect(await content.global("nav" as "footer", { locale: "en" })).toBeNull();
    await expect(content.global("posts" as "footer", { locale: "en" })).rejects.toThrow("use list() or get()");
  });
});

describe("global() in preview", () => {
  const calls: string[] = [];
  const fetch = async (input: string, init?: RequestInit) => {
    const name = input.split("/v1/ops/")[1] ?? "";
    calls.push(name);
    const input_ = (JSON.parse(String(init?.body)) as { input: Record<string, unknown> }).input;
    const ok = (data: unknown) => new Response(JSON.stringify({ ok: true, data }), { status: 200 });
    switch (name) {
      case "content.projects.list":
        return ok({ items: [{ id: "prj_site", sourceLocale: "en", targetLocales: ["de"], fallbackLocale: "en" }] });
      case "content.collections.list":
        return ok({ items: [{ id: "col_footer", slug: "footer", kind: "global" }, { id: "col_posts", slug: "posts", kind: "collection" }] });
      case "content.collections.get":
        return ok({ fields: [{ type: "text", name: "copyright", localized: true }] });
      case "content.globals.get":
        expect(input_).toEqual({ projectId: "prj_site", collectionId: "col_footer" });
        return ok({ id: "ent_footer", collectionId: "col_footer", slug: null, data: { copyright: { en: "(c) Acme DRAFT", de: "" } } });
      default:
        return new Response("{}", { status: 404 });
    }
  };
  const content = createContentClient<Models>({ ...PROJECT, preview: { key: "lfn_preview", apiUrl: "http://api.test" }, fetch });

  it("reads the draft through content.globals.get, with the language chain applied", async () => {
    const footer = await content.global("footer", { locale: "de" });
    expect(footer).toMatchObject({ id: "ent_footer", draft: true, data: { copyright: "(c) Acme DRAFT" } });
    expect(calls).toContain("content.globals.get");
  });

  it("a content type with a list is refused", async () => {
    await expect(content.global("posts" as "footer", { locale: "en" })).rejects.toThrow("use list() or get()");
  });
});
