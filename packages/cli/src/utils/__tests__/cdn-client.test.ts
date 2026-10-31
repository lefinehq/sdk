import { describe, it, expect, afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { fetchChanges, fetchRemoteKeys } from "../cdn-client.js";
import type { CdnManifest } from "../../analyzer/types.js";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Records the URL asked for and answers with an empty published file. */
function captureUrl(): { urls: string[] } {
  const seen: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    seen.push(String(input));
    return Promise.resolve(new Response("{}", { status: 200 }));
  }) as typeof fetch;
  return { urls: seen };
}

const manifestWithoutFileUrls = {
  projectSlug: "utmgen",
  sourceLanguage: "en",
  languages: [],
  files: {},
  updatedAt: "2026-08-20T00:00:00.000Z",
} as unknown as CdnManifest;

describe("fetchRemoteKeys", () => {
  it("prefers the file URL carried by the manifest", async () => {
    const cap = captureUrl();
    const manifest = {
      ...manifestWithoutFileUrls,
      files: {
        en: {
          url: "https://cdn.better-i18n.com/org/proj/en/translations.json",
          size: 10,
          lastModified: "2026-08-20T00:00:00.000Z",
        },
      },
    } as unknown as CdnManifest;

    await fetchRemoteKeys("https://cdn.better-i18n.com", "org", "proj", "en", manifest);

    expect(cap.urls).toEqual([
      "https://cdn.better-i18n.com/org/proj/en/translations.json",
    ]);
  });

  /* Regression: the old fallback asked for /{org}/{proj}/translations/{locale}.json,
     a path the CDN answers with 200 + `{}` instead of 404 — so pull wrote empty
     files and still reported success. */
  it("falls back to the published /{locale}/translations.json layout", async () => {
    const cap = captureUrl();

    await fetchRemoteKeys(
      "https://cdn.better-i18n.com",
      "org",
      "proj",
      "en",
      manifestWithoutFileUrls,
    );

    expect(cap.urls).toEqual([
      "https://cdn.better-i18n.com/org/proj/en/translations.json",
    ]);
    expect(cap.urls[0]).not.toContain("/translations/en.json");
  });

  it("throws on a non-ok CDN response", async () => {
    globalThis.fetch = (() =>
      Promise.resolve(new Response("", { status: 404 }))) as typeof fetch;

    await expect(
      fetchRemoteKeys("https://cdn.better-i18n.com", "org", "proj", "en", null),
    ).rejects.toThrow("CDN fetch failed (404)");
  });
});

describe("fetchRemoteKeys with a schema-2 manifest", () => {
  const BODY = JSON.stringify({ common: { hello: "Hello", bye: "Bye" } });
  const sha = createHash("sha256").update(BODY).digest("hex");
  const V = "aaaaaa01-aaaa";

  const manifestFor = (entry: Record<string, unknown>) =>
    ({
      projectSlug: "p",
      sourceLanguage: "en",
      languages: [],
      updatedAt: "2026-10-22T00:00:00.000Z",
      schema: 2,
      revision: 3,
      files: {
        en: {
          url: "https://cdn.test/org/proj/en/translations.json",
          size: BODY.length,
          lastModified: "2026-10-22T00:00:00.000Z",
          version: V,
          sha256: sha,
          keyCount: 2,
          ...entry,
        },
      },
    }) as unknown as CdnManifest;

  const serve = (body: string) => {
    const urls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      urls.push(String(input));
      return Promise.resolve(new Response(body, { status: 200 }));
    }) as typeof fetch;
    return urls;
  };

  it("reads the immutable snapshot URL and returns verified messages", async () => {
    const urls = serve(BODY);
    const result = await fetchRemoteKeys("https://cdn.test", "org", "proj", "en", manifestFor({}));
    expect(urls).toEqual([`https://cdn.test/org/proj/v/${V}/en/translations.json`]);
    expect(result).toEqual({ common: { hello: "Hello", bye: "Bye" } });
  });

  it("rejects a 200 {} when the manifest promises texts", async () => {
    serve("{}");
    await expect(
      fetchRemoteKeys("https://cdn.test", "org", "proj", "en", manifestFor({})),
    ).rejects.toThrow(/empty file \(2 texts expected\)/);
  });

  it("rejects bytes that do not match the sha256", async () => {
    serve(JSON.stringify({ common: { hello: "Tampered", bye: "Bye" } }));
    await expect(
      fetchRemoteKeys("https://cdn.test", "org", "proj", "en", manifestFor({})),
    ).rejects.toThrow(/sha256/);
  });

  it("rejects a wrong text count even when the hash matches", async () => {
    serve(BODY);
    await expect(
      fetchRemoteKeys("https://cdn.test", "org", "proj", "en", manifestFor({ keyCount: 5 })),
    ).rejects.toThrow(/holds 2 texts, the manifest says 5/);
  });

  it("a schema-1 manifest is read as before: file URL, no byte checks", async () => {
    const urls = serve("{}");
    const m = manifestFor({});
    delete (m as { schema?: number }).schema;
    await fetchRemoteKeys("https://cdn.test", "org", "proj", "en", m);
    expect(urls).toEqual(["https://cdn.test/org/proj/en/translations.json"]);
  });
});

describe("fetchChanges", () => {
  const manifest = (changesUrl: string) =>
    ({ languages: [], files: {}, revision: 2, changesUrl }) as unknown as CdnManifest;
  const changes = { revision: 2, version: "v", previousVersion: null, publishedAt: "x", locales: {} };
  const V = "aaaaaa02-aaaa";

  it("reads changes.json from the configured CDN, whatever origin the manifest names", async () => {
    const urls: string[] = [];
    globalThis.fetch = ((input: RequestInfo | URL) => {
      urls.push(String(input));
      return Promise.resolve(new Response(JSON.stringify(changes)));
    }) as typeof fetch;
    const result = await fetchChanges("http://localhost:8788", "ws", "app", manifest(`https://cdn.lefine.ai/ws/app/v/${V}/changes.json`));
    expect(result).toEqual(changes);
    expect(urls).toEqual([`http://localhost:8788/ws/app/v/${V}/changes.json`]);
  });

  it("ignores a changesUrl that is not v/{version}/changes.json", async () => {
    let called = false;
    globalThis.fetch = (() => {
      called = true;
      return Promise.resolve(new Response(JSON.stringify(changes)));
    }) as typeof fetch;
    expect(await fetchChanges("https://cdn.test", "ws", "app", manifest("https://evil.test/changes.json"))).toBeNull();
    expect(called).toBe(false);
  });

  it("a pruned file (404) is null, not a throw", async () => {
    globalThis.fetch = (() => Promise.resolve(new Response("nope", { status: 404 }))) as typeof fetch;
    expect(await fetchChanges("https://cdn.test", "ws", "app", manifest(`https://cdn.test/ws/app/v/${V}/changes.json`))).toBeNull();
  });
});
