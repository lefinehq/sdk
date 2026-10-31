import { describe, it, expect, vi } from "vitest";
import { createServerI18n } from "../index.js";

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

describe("createServerI18n: schema-2 cache surface", () => {
  it("revalidate swaps in a published change and onUpdate hears it, scoped to the project", async () => {
    const edge = makeEdge();
    const i18n = createServerI18n({
      project: "acme/server-v2-a",
      defaultLocale: "en",
      cdnBaseUrl: "https://cdn.test.com",
      fetch: edge.fetchFn,
      retryCount: 0,
    });
    const other = createServerI18n({
      project: "acme/server-v2-other",
      defaultLocale: "en",
      cdnBaseUrl: "https://cdn.test.com",
      fetch: edge.fetchFn,
      retryCount: 0,
    });
    const heard = vi.fn();
    const heardByOther = vi.fn();
    i18n.onUpdate(heard);
    other.onUpdate(heardByOther);

    expect((await i18n.getTranslator("en"))("common.hello")).toBe("Hello");
    await i18n.revalidate("en"); // same revision: nothing to do
    expect(heard).not.toHaveBeenCalled();

    edge.publish("aaaaaa02-aaaa", "Hi");
    await i18n.revalidate("en");

    expect(heard).toHaveBeenCalledTimes(1);
    expect(heard.mock.calls[0]![0]).toMatchObject({ locale: "en", revision: 2, version: "aaaaaa02-aaaa" });
    expect(heardByOther).not.toHaveBeenCalled();
    expect((await i18n.getTranslator("en"))("common.hello")).toBe("Hi");
    expect(i18n.getStatus()).toMatchObject({ stale: false, revision: 2 });
  });

  it("getStatus reports stale while the CDN is down and the last copy keeps serving", async () => {
    const edge = makeEdge();
    const i18n = createServerI18n({
      project: "acme/server-v2-b",
      defaultLocale: "en",
      cdnBaseUrl: "https://cdn.test.com",
      fetch: edge.fetchFn,
      retryCount: 0,
      manifestCacheTtlMs: 0,
    });
    await i18n.getTranslator("en");
    edge.state.down = true;
    expect((await i18n.getTranslator("en"))("common.hello")).toBe("Hello");
    expect(i18n.getStatus().stale).toBe(true);
  });

  it("changesSince is exposed", async () => {
    const edge = makeEdge();
    const i18n = createServerI18n({
      project: "acme/server-v2-c",
      defaultLocale: "en",
      cdnBaseUrl: "https://cdn.test.com",
      fetch: edge.fetchFn,
      retryCount: 0,
    });
    expect(await i18n.changesSince(1)).toMatchObject({ complete: true, toRevision: 1 });
  });
});
