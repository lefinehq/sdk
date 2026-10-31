import { describe, it, expect, vi } from "vitest";
import { createI18nCore } from "@better-i18n/core";
import type { CacheStatus } from "@better-i18n/core";
import { revalidateAndReport, sameStatus, subscribeToCoreUpdates } from "../cache-wiring.js";

// A fake schema-2 edge: one locale, a revision that can move, an outage switch.
const makeEdge = () => {
  const state = { revision: 1, version: "aaaaaa01-aaaa", hello: "Hello", down: false };
  const fetchFn = (async (input: Parameters<typeof fetch>[0]) => {
    if (state.down) throw new Error("network down");
    const url = typeof input === "string" ? input : input.toString();
    if (url.endsWith("/manifest.json")) {
      return new Response(
        JSON.stringify({
          schema: 2,
          revision: state.revision,
          languages: [{ code: "en", name: "English", isSource: true }],
          files: { en: { url: "x", size: 1, lastModified: null, version: state.version } },
        }),
        { status: 200 },
      );
    }
    if (url.endsWith("/en/translations.json")) {
      return new Response(JSON.stringify({ common: { hello: state.hello } }), { status: 200 });
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  const publish = (version: string, hello: string) => {
    state.revision += 1;
    state.version = version;
    state.hello = hello;
  };
  return { state, fetchFn, publish };
};

const makeCore = (project: string, edge: ReturnType<typeof makeEdge>) =>
  createI18nCore({
    project,
    defaultLocale: "en",
    cdnBaseUrl: "https://cdn.test.com",
    fetch: edge.fetchFn,
    retryCount: 0,
    manifestCacheTtlMs: 0,
  });

describe("provider cache wiring", () => {
  it("a published change reaches state, onUpdate and the status; other locales and projects are ignored", async () => {
    const edge = makeEdge();
    const core = makeCore("acme/uiv2-a", edge);
    const otherCore = makeCore("acme/uiv2-b", makeEdge());
    await core.getMessages("en");

    const messages = vi.fn();
    const updates = vi.fn();
    const statuses: CacheStatus[] = [];
    const off = subscribeToCoreUpdates(core, {
      locale: "en",
      onMessages: messages,
      onUpdate: updates,
      onStatus: (s) => statuses.push(s),
    });
    const offWrongLocale = subscribeToCoreUpdates(core, { locale: "tr", onMessages: vi.fn(), onUpdate: vi.fn() });

    await revalidateAndReport(core, "en", undefined, (s) => statuses.push(s));
    expect(messages).not.toHaveBeenCalled(); // same revision

    edge.publish("aaaaaa02-aaaa", "Hi");
    await revalidateAndReport(core, "en", undefined, (s) => statuses.push(s));

    expect(messages).toHaveBeenCalledWith({ common: { hello: "Hi" } });
    expect(updates).toHaveBeenCalledTimes(1);
    expect(updates.mock.calls[0]![0]).toMatchObject({ revision: 2, previousRevision: 1 });
    expect(statuses.at(-1)).toMatchObject({ stale: false, revision: 2 });

    // A different project's bus traffic never reaches this provider.
    const otherMessages = vi.fn();
    const offOther = subscribeToCoreUpdates(otherCore, { locale: "en", onMessages: otherMessages });
    expect(otherMessages).not.toHaveBeenCalled();

    off();
    offWrongLocale();
    offOther();
    edge.publish("aaaaaa03-aaaa", "Hey");
    await revalidateAndReport(core, "en", undefined);
    expect(messages).toHaveBeenCalledTimes(1); // unsubscribed
  });

  it("a failed check still reports the status, and says stale", async () => {
    const edge = makeEdge();
    const core = makeCore("acme/uiv2-c", edge);
    await core.getMessages("en");
    edge.state.down = true;
    const onStatus = vi.fn();
    await revalidateAndReport(core, "en", undefined, onStatus);
    expect(onStatus).toHaveBeenCalledTimes(1);
    expect(onStatus.mock.calls[0]![0].stale).toBe(true);
  });

  it("sameStatus ignores lastCheckedAt only", () => {
    const base: CacheStatus = { stale: false, lastCheckedAt: 1, revision: 1, integrityFailures: 0, lastError: null, storageError: null };
    expect(sameStatus(base, { ...base, lastCheckedAt: 2 })).toBe(true);
    expect(sameStatus(base, { ...base, stale: true })).toBe(false);
    expect(sameStatus(base, { ...base, storageError: "disk full" })).toBe(false);
  });
});
