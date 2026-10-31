import { describe, it, expect, vi } from "vitest";
import { createI18nCore } from "@better-i18n/core";
import { createFreshMessagesLoader } from "../fresh-messages.js";

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

describe("createFreshMessagesLoader", () => {
  const setup = (project: string) => {
    const edge = makeEdge();
    const core = createI18nCore({
      project,
      defaultLocale: "en",
      cdnBaseUrl: "https://cdn.test.com",
      fetch: edge.fetchFn,
      retryCount: 0,
      // A long manifest TTL: without the revalidate step a reload would not see a publish.
      manifestCacheTtlMs: 600_000,
    });
    const warn = vi.fn();
    return { edge, core, warn, load: createFreshMessagesLoader(core, warn) };
  };

  it("a reload after a publish shows the new text without waiting for the manifest TTL", async () => {
    const { edge, load } = setup("acme/vite-v2-a");
    expect(await load("en")).toEqual({ common: { hello: "Hello" } });
    edge.publish("aaaaaa02-aaaa", "Hi");
    expect(await load("en")).toEqual({ common: { hello: "Hi" } });
  });

  it("warns once per outage when only the last verified copy is available, and again after recovery", async () => {
    const { edge, warn, load } = setup("acme/vite-v2-b");
    await load("en");
    edge.state.down = true;
    expect(await load("en")).toEqual({ common: { hello: "Hello" } });
    await load("en");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain("last verified");

    edge.state.down = false;
    edge.publish("aaaaaa02-aaaa", "Hi");
    expect(await load("en")).toEqual({ common: { hello: "Hi" } });
    edge.state.down = true;
    await load("en");
    expect(warn).toHaveBeenCalledTimes(2);
  });
});
