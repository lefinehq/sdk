import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileMessages } from "../compile.js";
import { createStringsLoader } from "../loader.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const V1 = "mh3k2lc0-a1b2c3d4";
const V2 = "mh4p9xq1-e5f6a7b8";

/** A Lefine edge in memory: files by path, a manifest with an ETag, and every request recorded. */
function edge() {
  const files = new Map<string, { body: string; status?: number }>();
  const requests: Array<{ url: string; ifNoneMatch?: string }> = [];
  let manifest: object = {};
  let etag = '"m1"';
  let down = false;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const ifNoneMatch = (init?.headers as Record<string, string>)?.["If-None-Match"];
    requests.push({ url, ifNoneMatch });
    if (down) throw new Error("offline");
    const path = new URL(url).pathname;
    if (path.endsWith("/manifest.json")) {
      if (ifNoneMatch === etag) return new Response(null, { status: 304 });
      return new Response(JSON.stringify(manifest), { headers: { etag } });
    }
    const f = files.get(path);
    return f ? new Response(f.body, { status: f.status ?? 200 }) : new Response('{"error":"not_found"}', { status: 404 });
  }) as typeof globalThis.fetch;
  return {
    fetch,
    requests,
    file: (path: string, body: string, status?: number) => files.set(path, { body, status }),
    setManifest: (m: object, e = etag) => {
      manifest = m;
      etag = e;
    },
    setDown: (d: boolean) => {
      down = d;
    },
  };
}

const EN = JSON.stringify({ common: { hello: "Hello {name}", bye: "Bye" } });
const DE = JSON.stringify({ common: { hello: "Hallo {name}", bye: "Tschüss" } });
const manifestOf = (revision: number, files: Record<string, { version: string; body: string; keyCount?: number; ir?: boolean }>) => ({
  schema: 2,
  revision,
  languages: Object.keys(files).map((code) => ({ code })),
  files: Object.fromEntries(Object.entries(files).map(([lc, f]) => [lc, { version: f.version, sha256: sha(f.body), keyCount: f.keyCount ?? 2, ...(f.ir ? { ir: true } : {}) }])),
});

function setup() {
  const e = edge();
  e.file(`/app_web1/v/${V1}/en/translations.json`, EN);
  e.file(`/app_web1/v/${V1}/de/translations.json`, DE);
  e.setManifest(manifestOf(1, { en: { version: V1, body: EN }, de: { version: V1, body: DE } }));
  const loader = createStringsLoader({ project: "app_web1", cdnBaseUrl: "https://cdn.test", fetch: e.fetch, manifestTtlMs: 0 });
  return { e, loader };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createStringsLoader", () => {
  it("reads the versioned file the manifest names and checks it", async () => {
    const { e, loader } = setup();
    const en = await loader.load("en");
    expect(en.texts).toEqual(JSON.parse(EN));
    expect(en.ir).toBeNull();
    expect(en.stale).toBe(false);
    expect(e.requests.map((r) => new URL(r.url).pathname)).toContain(`/app_web1/v/${V1}/en/translations.json`);
    expect(await loader.locales()).toEqual(["en", "de"]);
  });

  it("asks for the manifest with If-None-Match, and a 304 reuses it", async () => {
    const { e, loader } = setup();
    await loader.load("en");
    await loader.load("en");
    const manifests = e.requests.filter((r) => r.url.endsWith("manifest.json"));
    expect(manifests.at(-1)?.ifNoneMatch).toBe('"m1"');
    // Same version and sha256: the file is not fetched again.
    expect(e.requests.filter((r) => r.url.endsWith("en/translations.json"))).toHaveLength(1);
  });

  it("fetches a locale again only when its version or sha256 changed", async () => {
    const { e, loader } = setup();
    await loader.load("en");
    const EN2 = JSON.stringify({ common: { hello: "Hi {name}", bye: "Bye" } });
    e.file(`/app_web1/v/${V2}/en/translations.json`, EN2);
    e.setManifest(manifestOf(2, { en: { version: V2, body: EN2 }, de: { version: V1, body: DE } }), '"m2"');
    expect((await loader.load("en")).texts).toEqual(JSON.parse(EN2));
    await loader.load("de");
    await loader.load("de");
    expect(e.requests.filter((r) => r.url.endsWith("de/translations.json"))).toHaveLength(1);
  });

  it("ignores a manifest with a lower revision", async () => {
    const { e, loader } = setup();
    e.setManifest(manifestOf(5, { en: { version: V1, body: EN } }), '"m5"');
    await loader.manifest();
    e.setManifest(manifestOf(3, { en: { version: V2, body: EN } }), '"m3"');
    expect((await loader.manifest()).revision).toBe(5);
  });

  it("a file that does not match the manifest never replaces the verified copy", async () => {
    const { e, loader } = setup();
    await loader.load("en");
    const bad = JSON.stringify({ common: { hello: "Hacked" } });
    e.file(`/app_web1/v/${V2}/en/translations.json`, bad);
    // The manifest promises other bytes (sha256 of EN): hash mismatch.
    e.setManifest({ ...manifestOf(2, { en: { version: V2, body: EN } }) }, '"m2"');
    const en = await loader.load("en");
    expect(en.texts).toEqual(JSON.parse(EN));
    expect(en.stale).toBe(true);
  });

  it("refuses {} and a wrong key count; with no copy at all it throws", async () => {
    const e = edge();
    e.file(`/app_web1/v/${V1}/en/translations.json`, "{}");
    e.file(`/app_web1/v/${V1}/de/translations.json`, DE);
    e.setManifest({ schema: 2, revision: 1, languages: [{ code: "en" }, { code: "de" }], files: { en: { version: V1, sha256: sha("{}"), keyCount: 0 }, de: { version: V1, sha256: sha(DE), keyCount: 3 } } });
    const loader = createStringsLoader({ project: "app_web1", cdnBaseUrl: "https://cdn.test", fetch: e.fetch });
    await expect(loader.load("en")).rejects.toThrow("empty");
    await expect(loader.load("de")).rejects.toThrow("has 2 texts, the manifest says 3");
  });

  it("uses the edge's compiled file only when its sha256 is the manifest's", async () => {
    const { e, loader } = setup();
    e.setManifest(manifestOf(1, { en: { version: V1, body: EN, ir: true }, de: { version: V1, body: DE, ir: true } }));
    const ir = compileMessages(JSON.parse(EN));
    e.file(`/app_web1/v/${V1}/en/messages.ir.json`, JSON.stringify({ format: 1, sha256: sha(EN), messages: ir }));
    e.file(`/app_web1/v/${V1}/de/messages.ir.json`, JSON.stringify({ format: 1, sha256: "0".repeat(64), messages: {} }));
    expect((await loader.load("en")).ir).toEqual(JSON.parse(JSON.stringify(ir)));
    expect((await loader.load("de")).ir).toBeNull();
  });

  it("asks for the compiled file only when the manifest lists it, and a listed one that fails is not asked for again", async () => {
    const { e, loader } = setup();
    const irRequests = () => e.requests.filter((r) => r.url.endsWith("/messages.ir.json")).length;
    // An app that never published IR (the Landing app, 2026-10-27: every request was a 404): no request at all.
    await loader.load("en");
    await loader.load("de");
    expect(irRequests()).toBe(0);
    // Listed but missing (404): asked once for this version, then not again when the file is fetched again.
    const listed = createStringsLoader({ project: "app_web1", cdnBaseUrl: "https://cdn.test", fetch: e.fetch, manifestTtlMs: 0 });
    e.setManifest(manifestOf(1, { en: { version: V1, body: EN, ir: true }, de: { version: V1, body: DE } }));
    e.file(`/app_web1/v/${V1}/en/translations.json`, EN, 500);
    await expect(listed.load("en")).rejects.toThrow();
    expect(irRequests()).toBe(1);
    e.file(`/app_web1/v/${V1}/en/translations.json`, EN);
    expect((await listed.load("en")).ir).toBeNull();
    expect(irRequests()).toBe(1);
  });

  it("an unknown IR format or a broken IR file is ignored, not an error", async () => {
    const { e, loader } = setup();
    e.setManifest(manifestOf(1, { en: { version: V1, body: EN, ir: true }, de: { version: V1, body: DE, ir: true } }));
    e.file(`/app_web1/v/${V1}/en/messages.ir.json`, JSON.stringify({ format: 2, sha256: sha(EN), messages: {} }));
    e.file(`/app_web1/v/${V1}/de/messages.ir.json`, "not json");
    expect((await loader.load("en")).ir).toBeNull();
    expect((await loader.load("de")).ir).toBeNull();
  });

  it("never reads the wall clock: Next 16 with cacheComponents (create-next-app's default) refuses Date.now() while prerendering", async () => {
    const spy = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("Date.now() while prerendering");
    });
    try {
      const { loader } = setup();
      await expect(loader.load("en")).resolves.toBeTruthy();
      await loader.load("en");
    } finally {
      spy.mockRestore();
    }
  });

  it("a version that fails to download is retried once per 30 s, not on every render (audit #11)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_800_000_000_000);
    const { e, loader } = setup();
    await loader.load("en");
    e.setManifest({ ...manifestOf(2, { en: { version: V2, body: EN } }) }, '"m2"'); // V2's file is missing: 404
    const tries = () => e.requests.filter((r) => r.url.includes(`/v/${V2}/en/translations.json`)).length;
    expect((await loader.load("en")).stale).toBe(true);
    await loader.load("en");
    await loader.load("en");
    expect(tries()).toBe(1);
    vi.advanceTimersByTime(31_000); // the loader times with performance.now(), not the wall clock
    await loader.load("en");
    expect(tries()).toBe(2);
  });

  it("pt_BR, pt-BR and PT-br are one locale, as in lefine/content (audit #13)", async () => {
    const e = edge();
    const PT = JSON.stringify({ a: { x: "Olá", y: "Tchau" } });
    e.file(`/app_web1/v/${V1}/pt-br/translations.json`, PT);
    e.setManifest(manifestOf(1, { "pt-br": { version: V1, body: PT } }));
    const loader = createStringsLoader({ project: "app_web1", cdnBaseUrl: "https://cdn.test", fetch: e.fetch });
    for (const spelling of ["pt_BR", "pt-BR", " PT-br "]) expect((await loader.load(spelling)).texts).toEqual(JSON.parse(PT));
  });

  it("the edge going down keeps the manifest and files we have", async () => {
    const { e, loader } = setup();
    await loader.load("en");
    e.setDown(true);
    expect((await loader.load("en")).texts).toEqual(JSON.parse(EN));
  });

  it("concurrent loads of one locale share one request", async () => {
    const { e, loader } = setup();
    await Promise.all([loader.load("en"), loader.load("en"), loader.load("EN")]);
    expect(e.requests.filter((r) => r.url.endsWith("en/translations.json"))).toHaveLength(1);
    expect(e.requests.filter((r) => r.url.endsWith("manifest.json"))).toHaveLength(1);
  });

  it("with shareInFlight: false (lefine/next) every call has its own request, and a verified file is still not fetched again", async () => {
    // Cache Components count a promise another render started as uncached data; Next's cache dedupes instead.
    const { e } = setup();
    const loader = createStringsLoader({ project: "app_web1", cdnBaseUrl: "https://cdn.test", fetch: e.fetch, manifestTtlMs: 0, shareInFlight: false });
    await Promise.all([loader.load("en"), loader.load("en")]);
    expect(e.requests.filter((r) => r.url.endsWith("manifest.json"))).toHaveLength(2);
    expect(e.requests.filter((r) => r.url.endsWith("en/translations.json"))).toHaveLength(2);
    await loader.load("en");
    expect(e.requests.filter((r) => r.url.endsWith("en/translations.json"))).toHaveLength(2);
  });

  it("a locale the manifest does not list says it is not published", async () => {
    const { loader } = setup();
    await expect(loader.load("fr")).rejects.toThrow("fr is not published for app_web1");
  });

  it("builds file URLs itself and refuses a project or locale that could change the path", async () => {
    // A name is refused with where to find the id: names change, the id does not.
    expect(() => createStringsLoader({ project: "acme/web" })).toThrow("Settings, App, App id");
    expect(() => createStringsLoader({ project: "app_../x" })).toThrow("must be the app's id");
    const { loader } = setup();
    await expect(loader.load("../en")).rejects.toThrow("not a locale");
  });
});

describe("device storage (React Native: AsyncStorage or MMKV behind { get, set })", () => {
  /** A device store in memory; `broken` makes every call fail, as a full disk would. */
  const device = () => {
    const data = new Map<string, string>();
    let broken = false;
    return {
      data,
      breakIt: () => (broken = true),
      storage: {
        get: async (k: string) => {
          if (broken) throw new Error("disk");
          return data.get(k) ?? null;
        },
        set: async (k: string, v: string) => {
          if (broken) throw new Error("disk");
          data.set(k, v);
        },
      },
    };
  };
  const launch = (e: ReturnType<typeof edge>, storage: ReturnType<typeof device>["storage"]) =>
    createStringsLoader({ project: "app_web1", cdnBaseUrl: "https://cdn.test", fetch: e.fetch, storage });
  const settle = () => new Promise((r) => setTimeout(r, 0));

  it("keeps the verified manifest and file; a cold start with no network serves them", async () => {
    const { e } = setup();
    const d = device();
    await launch(e, d.storage).load("en");
    await settle();
    expect([...d.data.keys()].sort()).toEqual(["lefine:app_web1:en", "lefine:app_web1:manifest"]);

    e.setDown(true);
    const offline = launch(e, d.storage); // the next launch: nothing in memory
    const en = await offline.load("en");
    expect(en.texts).toEqual(JSON.parse(EN));
    expect(en.stale).toBe(true);
    expect(await offline.locales()).toEqual(["en", "de"]);
    // A language never loaded online is not on the device: it says so, it does not invent texts.
    await expect(offline.load("de")).rejects.toThrow();
  });

  it("online, the device copy is served at once and the edge is asked in the background; the next load has the new release", async () => {
    const { e } = setup();
    const d = device();
    await launch(e, d.storage).load("en");
    await settle();

    const EN2 = JSON.stringify({ common: { hello: "Hi {name}", bye: "Bye" } });
    e.file(`/app_web1/v/${V2}/en/translations.json`, EN2);
    e.setManifest(manifestOf(2, { en: { version: V2, body: EN2 } }), '"m2"');
    const next = launch(e, d.storage);
    expect((await next.load("en")).texts).toEqual(JSON.parse(EN)); // at once, from the device
    await vi.waitFor(async () => expect((await next.load("en")).texts).toEqual(JSON.parse(EN2)));
    expect((await next.load("en")).stale).toBe(false);
    await settle();
    expect(JSON.parse(d.data.get("lefine:app_web1:en")!).texts).toEqual(JSON.parse(EN2));
  });

  it("a device copy that does not match its manifest (edited, cut short, another app) is ignored", async () => {
    const { e } = setup();
    const d = device();
    await launch(e, d.storage).load("en");
    await settle();
    d.data.set("lefine:app_web1:en", JSON.stringify({ stamp: JSON.parse(d.data.get("lefine:app_web1:en")!).stamp, texts: { common: { hello: "pwned" } } }));
    e.setDown(true);
    await expect(launch(e, d.storage).load("en")).rejects.toThrow();
    d.data.set("lefine:app_web1:manifest", "not json");
    await expect(launch(e, d.storage).load("en")).rejects.toThrow();
  });

  it("a storage that fails is only a missing cache: loads still work online", async () => {
    const { e } = setup();
    const d = device();
    d.breakIt();
    const en = await launch(e, d.storage).load("en");
    expect(en.stale).toBe(false);
  });
});

describe("stale while revalidate (createStrings with a snapshot)", () => {
  const swrSetup = () => {
    const { e } = setup();
    const loader = createStringsLoader({ project: "app_web1", cdnBaseUrl: "https://cdn.test", fetch: e.fetch, manifestTtlMs: 10_000, staleWhileRevalidate: true });
    return { e, loader };
  };
  const manifests = (e: ReturnType<typeof edge>) => e.requests.filter((r) => r.url.endsWith("/manifest.json")).length;
  const EN2 = JSON.stringify({ common: { hello: "Hi {name}", bye: "Bye" } });

  it("within the TTL nothing is asked; past it the render gets what is in memory at once and one request refreshes it", async () => {
    vi.useFakeTimers();
    const { e, loader } = swrSetup();
    await loader.load("en");
    await loader.load("en");
    expect(manifests(e)).toBe(1);
    e.file(`/app_web1/v/${V2}/en/translations.json`, EN2);
    e.setManifest(manifestOf(2, { en: { version: V2, body: EN2 } }), '"m2"');
    vi.advanceTimersByTime(11_000);
    // Past the TTL: the old texts now, and one manifest request (not one per call) in the background.
    const [a, b] = await Promise.all([loader.load("en"), loader.load("en")]);
    expect(a.texts).toEqual(JSON.parse(EN));
    expect(b.texts).toEqual(JSON.parse(EN));
    vi.useRealTimers();
    await vi.waitFor(async () => expect((await loader.load("en")).texts).toEqual(JSON.parse(EN2)));
    expect(manifests(e)).toBe(2);
  });
});
