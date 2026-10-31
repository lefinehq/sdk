/**
 * Schema-2 cache rules (Lefine CDN contract 2b): conditional manifest, revision
 * as the only freshness oracle, per-locale refetch, byte verification, stale
 * on failure. Schema-1 (Better i18n) manifests must keep today's behaviour.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { createI18nCore, clearManifestCache, clearMessagesCache } from "../cdn";
import { countKeys } from "../integrity";
import type { CacheUpdateEvent, ManifestResponse, TranslationStorage } from "../types";

const sha256 = async (text: string): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
};

let projectCounter = 0;

// A variable, not a literal: `messagesCacheTtlMs` is a NormalizedConfig field
// the tests set directly (same as versioned-fetch.test.ts).
const CONFIG = {
  defaultLocale: "en",
  cdnBaseUrl: "https://cdn.test.com",
  manifestCacheTtlMs: 0,
  messagesCacheTtlMs: 0,
  retryCount: 0,
};

interface Locale {
  version: string;
  body: string;
  /** Overrides what the manifest claims, to build a lying manifest. */
  claim?: { sha256?: string; keyCount?: number };
}

/** A fake edge: a mutable manifest + snapshot files, honouring If-None-Match. */
const makeEdge = async (
  initial: Record<string, Locale>,
  schema: 1 | 2 = 2,
  storage?: TranslationStorage,
  project = `acme/p${++projectCounter}`,
) => {
  const base = `https://cdn.test.com/${project}`;
  const state = {
    revision: 1,
    locales: initial,
    etagCounter: 1,
    /** URLs that answer 404 this many more times. */
    missing: new Map<string, number>(),
    manifestOverride: null as ManifestResponse | null,
    /** Serve changes.json for the current release; `false` = pruned (404). */
    changesFile: true as boolean,
  };
  const urls: string[] = [];
  const manifestHeaders: Array<Record<string, string>> = [];

  const buildManifest = async (): Promise<ManifestResponse> => {
    const files: NonNullable<ManifestResponse["files"]> = {};
    for (const [code, l] of Object.entries(state.locales)) {
      const parsed = JSON.parse(l.body);
      files[code] = {
        url: `${base}/${code}/translations.json`,
        size: l.body.length,
        lastModified: `2026-10-22T10:00:0${state.revision}Z`,
        ...(schema === 2
          ? {
              version: l.version,
              sha256: l.claim?.sha256 ?? (await sha256(l.body)),
              keyCount: l.claim?.keyCount ?? countKeys(parsed),
              revision: state.revision,
            }
          : {}),
      };
    }
    return {
      languages: Object.keys(state.locales).map((code) => ({ code, name: code })),
      updatedAt: `2026-10-22T10:00:0${state.revision}Z`,
      files,
      ...(schema === 2
        ? {
            schema: 2,
            revision: state.revision,
            version: `rel${state.revision}aaaa-aaaa`,
            publishedAt: "2026-10-22T10:00:00Z",
            changesUrl: `${base}/v/rel${state.revision}aaaa-aaaa/changes.json`,
            previousVersion: null,
          }
        : {}),
    };
  };

  const fetchFn = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    urls.push(url);
    if (url === `${base}/manifest.json`) {
      const headers = (init?.headers ?? {}) as Record<string, string>;
      manifestHeaders.push(headers);
      const etag = `"m${state.etagCounter}"`;
      if (headers["If-None-Match"] === etag) return new Response(null, { status: 304 });
      const body = state.manifestOverride ?? (await buildManifest());
      return new Response(JSON.stringify(body), { status: 200, headers: { etag } });
    }
    if (url.endsWith("/changes.json")) {
      if (!state.changesFile) return new Response("not found", { status: 404 });
      return new Response(
        JSON.stringify({
          revision: state.revision,
          version: `rel${state.revision}aaaa-aaaa`,
          previousVersion: null,
          publishedAt: "2026-10-22T10:00:00.000Z",
          locales: {
            en: { added: 1, changed: 0, removed: 0, keys: { added: [["common", "hello"]], changed: [], removed: [] }, truncated: false },
          },
        }),
        { status: 200 },
      );
    }
    const remaining = state.missing.get(url) ?? 0;
    if (remaining > 0) {
      state.missing.set(url, remaining - 1);
      return new Response("not found", { status: 404 });
    }
    for (const [code, l] of Object.entries(state.locales)) {
      if (url === `${base}/v/${l.version}/${code}/translations.json` || url === `${base}/${code}/translations.json`) {
        return new Response(l.body, { status: 200 });
      }
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  /** Publish: new revision, new manifest etag. */
  const publish = (locales: Record<string, Locale>) => {
    state.revision += 1;
    state.etagCounter += 1;
    state.locales = { ...state.locales, ...locales };
  };

  const core = createI18nCore({
    ...CONFIG,
    project,
    snapshotRetryDelayMs: 0,
    storage,
    fetch: fetchFn,
  });

  return {
    core,
    base,
    state,
    publish,
    urls,
    manifestHeaders,
    manifestRequests: () => urls.filter((u) => u.endsWith("/manifest.json")).length,
    fileRequests: () => urls.filter((u) => !u.endsWith("/manifest.json")),
  };
};

const file = (version: string, messages: unknown): Locale => ({
  version,
  body: JSON.stringify(messages),
});

const EN1 = file("aaaaaa01-aaaa", { common: { hello: "Hello", bye: "Bye" } });
const DE1 = file("bbbbbb01-bbbb", { common: { hello: "Hallo", bye: "Tschuess" } });

beforeEach(() => {
  clearManifestCache();
  clearMessagesCache();
});

describe("schema 2 manifest", () => {
  it("1. same revision: revalidate stops at the manifest, no file is refetched", async () => {
    const edge = await makeEdge({ en: EN1, de: DE1 });
    await edge.core.getMessages("de");
    expect(edge.fileRequests()).toHaveLength(1);

    await edge.core.revalidate("de");
    await edge.core.revalidate("de");

    expect(edge.fileRequests()).toHaveLength(1);
    expect(edge.core.getStatus().stale).toBe(false);
  });

  it("2. a new revision refetches only the locales whose version changed", async () => {
    const edge = await makeEdge({ en: EN1, de: DE1 });
    await edge.core.getMessages("en");
    await edge.core.getMessages("de");
    const before = edge.fileRequests().length;

    const DE2 = file("bbbbbb02-bbbb", { common: { hello: "Hallo!", bye: "Tschuess" } });
    edge.publish({ de: DE2 });
    const updates: CacheUpdateEvent[] = [];
    edge.core.onUpdate((e) => updates.push(e));

    await edge.core.revalidate("en"); // revision moved, en bytes did not
    expect(edge.fileRequests()).toHaveLength(before);
    expect(updates).toHaveLength(0);

    await edge.core.revalidate("de");
    expect(edge.fileRequests().slice(before)).toEqual([`${edge.base}/v/bbbbbb02-bbbb/de/translations.json`]);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      locale: "de",
      revision: 2,
      previousRevision: 1,
      version: "bbbbbb02-bbbb",
      messages: { common: { hello: "Hallo!" } },
    });
    expect(updates[0]!.changesUrl).toContain("/changes.json");
    expect(await edge.core.getMessages("de")).toEqual({ common: { hello: "Hallo!", bye: "Tschuess" } });
  });

  it("2b. partial release: a locale that kept its old version is not refetched while revision moves", async () => {
    const edge = await makeEdge({ en: EN1, de: DE1 });
    await edge.core.getMessages("en");
    await edge.core.getMessages("de");
    const before = edge.fileRequests().length;
    // de failed to publish and keeps version/sha256; en advances. Revision moves for both.
    edge.publish({ en: file("aaaaaa02-aaaa", { common: { hello: "Hey", bye: "Bye" } }) });
    await edge.core.revalidate("de");
    expect(edge.fileRequests()).toHaveLength(before);
    await edge.core.revalidate("en");
    expect(edge.fileRequests()).toHaveLength(before + 1);
    expect(await edge.core.getMessages("de")).toEqual(JSON.parse(DE1.body));
  });

  it("3. sha256 mismatch keeps the old copy, reports stale, and does not fire onUpdate", async () => {
    const edge = await makeEdge({ en: EN1 });
    const first = await edge.core.getMessages("en");
    const onUpdate = vi.fn();
    edge.core.onUpdate(onUpdate);

    // Same text count, different bytes than the manifest promises.
    const EN2: Locale = {
      ...file("aaaaaa02-aaaa", { common: { hello: "Tampered", bye: "Bye" } }),
      claim: { sha256: "0".repeat(64) },
    };
    edge.publish({ en: EN2 });
    await edge.core.revalidate("en");

    expect(onUpdate).not.toHaveBeenCalled();
    expect(await edge.core.getMessages("en")).toEqual(first);
    const status = edge.core.getStatus();
    expect(status.stale).toBe(true);
    expect(status.integrityFailures).toBeGreaterThan(0);
  });

  it("4. a 200 {} body is never accepted as messages when keyCount > 0", async () => {
    const edge = await makeEdge({ en: EN1 });
    // Cold start: nothing to fall back on, so it must throw, not return {}.
    edge.state.locales = { en: { ...EN1, body: "{}", claim: { sha256: await sha256(EN1.body), keyCount: 2 } } };
    await expect(edge.core.getMessages("en")).rejects.toThrow(/empty|sha256|texts/);

    // Warm: the previous verified copy stays.
    clearManifestCache();
    clearMessagesCache();
    const edge2 = await makeEdge({ en: EN1 });
    const first = await edge2.core.getMessages("en");
    edge2.publish({ en: { ...file("aaaaaa02-aaaa", {}), claim: { keyCount: 2, sha256: "1".repeat(64) } } });
    await edge2.core.revalidate("en");
    expect(await edge2.core.getMessages("en")).toEqual(first);
    expect(edge2.core.getStatus().stale).toBe(true);
  });

  it("4b. a wrong keyCount is rejected even when the hash is right", async () => {
    const body = JSON.stringify({ common: { hello: "Hello" } });
    const edge = await makeEdge({
      en: { version: "aaaaaa01-aaaa", body, claim: { sha256: await sha256(body), keyCount: 5 } },
    });
    await expect(edge.core.getMessages("en")).rejects.toThrow(/holds 1 texts/);
  });

  it("5. the manifest is requested conditionally and a 304 reuses the cached one", async () => {
    const edge = await makeEdge({ en: EN1 });
    await edge.core.getMessages("en");
    expect(edge.manifestHeaders[0]?.["If-None-Match"]).toBeUndefined();

    await edge.core.getManifest({ forceRefresh: true });
    expect(edge.manifestHeaders[1]?.["If-None-Match"]).toBe('"m1"');

    const manifest = await edge.core.getManifest({ forceRefresh: true });
    expect(manifest.revision).toBe(1);
    expect(edge.core.getStatus()).toMatchObject({ stale: false, revision: 1 });
    expect(edge.core.getStatus().lastCheckedAt).not.toBeNull();
  });

  it("6. a lower revision is ignored", async () => {
    const edge = await makeEdge({ en: EN1 });
    edge.publish({}); // revision 2
    await edge.core.getMessages("en");
    expect((await edge.core.getManifest()).revision).toBe(2);

    // The edge starts serving an older manifest (e.g. a stale colo).
    edge.state.revision = 1;
    edge.state.etagCounter += 1;
    const manifest = await edge.core.getManifest({ forceRefresh: true });
    expect(manifest.revision).toBe(2);
    expect(edge.core.getStatus().revision).toBe(2);
  });

  it("7. snapshot 404 right after the manifest moved: retried once, then the old copy is kept", async () => {
    const edge = await makeEdge({ en: EN1 });
    const first = await edge.core.getMessages("en");

    const EN2 = file("aaaaaa02-aaaa", { common: { hello: "Hi", bye: "Bye" } });
    edge.publish({ en: EN2 });
    const snapshot = `${edge.base}/v/aaaaaa02-aaaa/en/translations.json`;

    // Still missing on the retry: stale, old copy.
    edge.state.missing.set(snapshot, 4); // revalidate (2 tries) + the getMessages below (2 tries)
    const before = edge.fileRequests().length;
    await edge.core.revalidate("en");
    expect(edge.fileRequests().slice(before)).toEqual([snapshot, snapshot]);
    expect(await edge.core.getMessages("en")).toEqual(first);
    expect(edge.core.getStatus().stale).toBe(true);

    // The files catch up (one 404, then fine): the retry succeeds.
    edge.state.missing.set(snapshot, 1);
    await edge.core.revalidate("en");
    expect(await edge.core.getMessages("en")).toEqual({ common: { hello: "Hi", bye: "Bye" } });
    expect(edge.core.getStatus().stale).toBe(false);
  });

  it("8. CDN down: the last verified copy is served and stale is true", async () => {
    const edge = await makeEdge({ en: EN1 });
    const first = await edge.core.getMessages("en");

    edge.state.revision += 1;
    const down = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    const offline = createI18nCore({
      ...CONFIG,
      project: edge.core.config.project,
      fetch: down,
    });
    expect(await offline.getMessages("en")).toEqual(first);
    expect(offline.getStatus()).toMatchObject({ stale: true });
    expect(offline.getStatus().lastError).toMatch(/network down/);
  });

  it("11. concurrent revalidations share one manifest request", async () => {
    const edge = await makeEdge({ en: EN1 });
    await edge.core.getMessages("en");
    const before = edge.manifestRequests();
    await Promise.all([edge.core.revalidate("en"), edge.core.revalidate("en"), edge.core.revalidate("en")]);
    expect(edge.manifestRequests() - before).toBe(1);
  });
});

const memoryStorage = (): TranslationStorage & { map: Map<string, string> } => {
  const map = new Map<string, string>();
  return {
    map,
    get: async (k) => map.get(k) ?? null,
    set: async (k, v) => {
      map.set(k, v);
    },
  };
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("persistence", () => {
  it("12. cold start: the persisted manifest ETag makes the first request conditional", async () => {
    const storage = memoryStorage();
    const first = await makeEdge({ en: EN1 }, 2, storage, "acme/cold");
    await first.core.getMessages("en");
    await tick();

    // New process: memory is empty, disk is not.
    clearManifestCache();
    clearMessagesCache();
    const second = await makeEdge({ en: EN1 }, 2, storage, "acme/cold");
    const manifest = await second.core.getManifest();

    expect(second.manifestHeaders[0]?.["If-None-Match"]).toBe('"m1"');
    expect(manifest.revision).toBe(1);
    expect(second.core.getStatus()).toMatchObject({ stale: false, revision: 1 });
  });

  it("12b. cold start with a newer revision on the edge takes the new manifest", async () => {
    const storage = memoryStorage();
    const first = await makeEdge({ en: EN1 }, 2, storage, "acme/cold2");
    await first.core.getMessages("en");
    await tick();

    clearManifestCache();
    clearMessagesCache();
    const second = await makeEdge({ en: EN1 }, 2, storage, "acme/cold2");
    second.publish({ en: file("aaaaaa02-aaaa", { common: { hello: "Hi", bye: "Bye" } }) });
    expect((await second.core.getManifest()).revision).toBe(2);
  });

  it("14. a failed storage write shows in getStatus().storageError and does not fail the load", async () => {
    const storage: TranslationStorage = {
      get: async () => null,
      set: async () => {
        throw new Error("disk full");
      },
    };
    const edge = await makeEdge({ en: EN1 }, 2, storage);
    expect(await edge.core.getMessages("en")).toEqual(JSON.parse(EN1.body));
    await tick();
    expect(edge.core.getStatus().storageError).toBe("disk full");
  });

  it("14b. storageError clears after a write succeeds", async () => {
    let fail = true;
    const map = new Map<string, string>();
    const storage: TranslationStorage = {
      get: async (k) => map.get(k) ?? null,
      set: async (k, v) => {
        if (fail) throw new Error("disk full");
        map.set(k, v);
      },
    };
    const edge = await makeEdge({ en: EN1 }, 2, storage);
    await edge.core.getMessages("en");
    await tick();
    expect(edge.core.getStatus().storageError).toBe("disk full");

    fail = false;
    edge.publish({ en: file("aaaaaa02-aaaa", { common: { hello: "Hi", bye: "Bye" } }) });
    await edge.core.revalidate("en");
    await tick();
    expect(edge.core.getStatus().storageError).toBeNull();
  });
});

describe("update bus is scoped to a project", () => {
  it("15. two projects in one process never see each other's updates", async () => {
    const a = await makeEdge({ en: EN1 });
    const b = await makeEdge({ en: EN1 });
    await a.core.getMessages("en");
    await b.core.getMessages("en");

    const seenByA: CacheUpdateEvent[] = [];
    const seenByB: CacheUpdateEvent[] = [];
    const legacyA = vi.fn();
    const legacyB = vi.fn();
    a.core.onUpdate((e) => seenByA.push(e));
    b.core.onUpdate((e) => seenByB.push(e));
    a.core.onMessagesUpdate(legacyA);
    b.core.onMessagesUpdate(legacyB);

    a.publish({ en: file("aaaaaa02-aaaa", { common: { hello: "Hi", bye: "Bye" } }) });
    await a.core.revalidate("en");

    expect(seenByA).toHaveLength(1);
    expect(seenByA[0]!.project).toContain(a.core.config.project);
    expect(legacyA).toHaveBeenCalledTimes(1);
    expect(legacyA.mock.calls[0]![0].project).toContain(a.core.config.project);
    expect(seenByB).toHaveLength(0);
    expect(legacyB).not.toHaveBeenCalled();
  });

  it("15b. unsubscribe removes the scoped listener", async () => {
    const a = await makeEdge({ en: EN1 });
    await a.core.getMessages("en");
    const listener = vi.fn();
    const off = a.core.onUpdate(listener);
    off();
    a.publish({ en: file("aaaaaa02-aaaa", { common: { hello: "Hi", bye: "Bye" } }) });
    await a.core.revalidate("en");
    expect(listener).not.toHaveBeenCalled();
  });
});

describe("changesSince", () => {
  it("16. one revision behind: complete, with the release's change list", async () => {
    const edge = await makeEdge({ en: EN1 });
    edge.publish({}); // revision 2
    const result = await edge.core.changesSince(1);
    expect(result).toMatchObject({ complete: true, fromRevision: 1, toRevision: 2 });
    expect(result.latest?.locales.en!.added).toBe(1);
  });

  it("16b. already at the current revision: complete, nothing to report", async () => {
    const edge = await makeEdge({ en: EN1 });
    expect(await edge.core.changesSince(1)).toEqual({ complete: true, fromRevision: 1, toRevision: 1, latest: null });
  });

  it("16c. more than one revision behind: incomplete, the last release is only a part", async () => {
    const edge = await makeEdge({ en: EN1 });
    edge.publish({});
    edge.publish({}); // revision 3
    const result = await edge.core.changesSince(1);
    expect(result.complete).toBe(false);
    expect(result.latest?.revision).toBe(3);
  });

  it("16d. a pruned changes.json (404) is incomplete, never a throw", async () => {
    const edge = await makeEdge({ en: EN1 });
    edge.publish({});
    edge.state.changesFile = false;
    expect(await edge.core.changesSince(1)).toMatchObject({ complete: false, latest: null });
  });

  it("16e. a changesUrl on another origin is never requested: the file is read from the configured CDN", async () => {
    const edge = await makeEdge({ en: EN1 });
    edge.publish({});
    edge.state.manifestOverride = {
      ...(await edge.core.getManifest({ forceRefresh: true })),
      changesUrl: "https://cdn.lefine.ai/v/rel2aaaa-aaaa/changes.json",
    };
    edge.state.etagCounter += 1;
    const before = edge.urls.length;
    const result = await edge.core.changesSince(1);
    const requested = edge.urls.slice(before);
    expect(requested.some((u) => u.includes("lefine.ai"))).toBe(false);
    expect(requested).toContain(`${edge.base}/v/rel2aaaa-aaaa/changes.json`);
    expect(result.complete).toBe(true);
  });

  it("16g. a changesUrl that is not v/{version}/changes.json is ignored", async () => {
    const edge = await makeEdge({ en: EN1 });
    edge.publish({});
    edge.state.manifestOverride = {
      ...(await edge.core.getManifest({ forceRefresh: true })),
      changesUrl: "https://evil.test/anything/else.json",
    };
    edge.state.etagCounter += 1;
    const before = edge.urls.length;
    expect((await edge.core.changesSince(1)).complete).toBe(false);
    expect(edge.urls.slice(before).some((u) => u.includes("evil.test"))).toBe(false);
  });

  it("16f. a schema-1 manifest has no revision: incomplete", async () => {
    const edge = await makeEdge({ en: EN1 }, 1);
    expect(await edge.core.changesSince(1)).toMatchObject({ complete: false, toRevision: null });
  });
});

describe("schema 1 manifest (Better i18n CDN)", () => {
  it("13. keeps today's behaviour: no conditional header, no byte checks, lastModified drives revalidate", async () => {
    const edge = await makeEdge({ en: EN1 }, 1);
    const updates: CacheUpdateEvent[] = [];
    edge.core.onUpdate((e) => updates.push(e));
    await edge.core.getMessages("en");

    await edge.core.getManifest({ forceRefresh: true });
    expect(edge.manifestHeaders.every((h) => h["If-None-Match"] === undefined)).toBe(true);

    // lastModified moves: revalidate refetches and notifies, as before.
    edge.publish({ en: file("aaaaaa02-aaaa", { common: { hello: "Hi" } }) });
    await edge.core.revalidate("en");
    expect(await edge.core.getMessages("en")).toEqual({ common: { hello: "Hi" } });
    expect(updates).toHaveLength(1);
    expect(updates[0]!.revision).toBeUndefined();
    expect(edge.core.getStatus().stale).toBe(false);
  });
});
