import { afterEach, describe, expect, it } from "bun:test";
import { createBridge } from "../mcp-bridge.js";
import { similarity } from "../mcp-tools.js";

const APP = "app_0123456789abcdef0123456789abcdef";
const KEYS = [
  { namespace: "checkout", key: "coupon_applied", translations: { en: { text: "Coupon applied" } } },
  { namespace: "checkout", key: "total", translations: { en: { text: "Total: {amount, number}" } } },
  { namespace: "nav", key: "home", translations: { en: { text: "Home" } } },
];

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

/** The Lefine API: ops for app.get, keys.list (search like the server: key or text, any case), keys.create; /v1/mcp for the rest. */
function api() {
  const created: unknown[] = [];
  const mcp: unknown[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url.endsWith("/v1/mcp")) {
      mcp.push(body);
      return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "lefine_find", inputSchema: {} }] } });
    }
    const op = url.split("/v1/ops/")[1];
    const input2 = body.input;
    if (op === "strings.app.get") return Response.json({ ok: true, data: { app: { sourceLocale: "en" }, namespaces: [{ name: "checkout" }, { name: "nav" }] } });
    if (op === "strings.keys.list") {
      const q = String(input2.search).toLowerCase();
      return Response.json({ ok: true, data: { items: KEYS.filter((k) => k.key.toLowerCase().includes(q) || k.translations.en.text.toLowerCase().includes(q)), nextCursor: null } });
    }
    if (op === "strings.keys.create") {
      created.push(input2);
      return Response.json({ ok: true, data: { id: "key_1", ...input2 } });
    }
    return Response.json({ ok: false, error: { code: "NOT_FOUND", message: op } }, { status: 404 });
  }) as typeof globalThis.fetch;
  const out: Array<{ id?: unknown; result?: { tools?: Array<{ name: string }>; content?: Array<{ text: string }>; isError?: boolean } }> = [];
  const bridge = createBridge({ auth: { token: "lfn_x", apiUrl: "http://api.test" }, fetch, write: (l) => void out.push(JSON.parse(l)), log: () => {}, clientVersion: "test" });
  globalThis.fetch = fetch; // createOpClient uses the global fetch
  let id = 0;
  const call = async (name: string, args: object) => {
    await bridge.handle(JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }));
    const r = out.at(-1)!.result!;
    return { text: r.content![0]!.text, isError: r.isError === true };
  };
  return { bridge, out, created, mcp, call };
}

describe("lefine mcp: find_similar_key and add_key (audit, idea C)", () => {
  it("tools/list has the server's tools and the two local ones", async () => {
    const { bridge, out } = api();
    await bridge.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(out[0]?.result?.tools?.map((t) => t.name)).toEqual(["lefine_find", "lefine_find_similar_key", "lefine_add_key"]);
  });

  it("find_similar_key finds the same text with other words around it, closest first", async () => {
    const { call, mcp } = api();
    const r = await call("lefine_find_similar_key", { appId: APP, text: "coupon applied!" });
    expect(JSON.parse(r.text)[0]).toMatchObject({ namespace: "checkout", key: "coupon_applied", score: 1 });
    expect(mcp).toEqual([]); // answered here, not by the server
  });

  it("add_key refuses an existing key, an existing text, a new namespace and broken ICU, saying why", async () => {
    const { call, created } = api();
    expect(await call("lefine_add_key", { appId: APP, namespace: "nav", key: "coupon_applied", sourceText: "Coupon on" })).toMatchObject({ isError: true, text: expect.stringContaining("already exists: checkout.coupon_applied") });
    expect(await call("lefine_add_key", { appId: APP, namespace: "checkout", key: "coupon_ok", sourceText: "Coupon applied." })).toMatchObject({ isError: true, text: expect.stringContaining("already has a key: checkout.coupon_applied") });
    expect(await call("lefine_add_key", { appId: APP, namespace: "chekout", key: "x", sourceText: "X" })).toMatchObject({ isError: true, text: expect.stringContaining('Namespace "chekout" does not exist') });
    expect(await call("lefine_add_key", { appId: APP, namespace: "checkout", key: "x", sourceText: "{count, plural, one {x}" })).toMatchObject({ isError: true, text: expect.stringContaining("not valid ICU") });
    expect(created).toEqual([]);
  });

  it("add_key creates a clean new key and names its arguments", async () => {
    const { call, created } = api();
    const r = await call("lefine_add_key", { appId: APP, namespace: "checkout", key: "items", sourceText: "{n, plural, one {# item} other {# items}}", description: "Cart badge" });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("Added checkout.items");
    expect(r.text).toContain("arguments: n");
    expect(created).toEqual([{ appId: APP, namespace: "checkout", key: "items", sourceText: "{n, plural, one {# item} other {# items}}", description: "Cart badge" }]);
  });

  it("similarity: same text aside case, punctuation and argument names; else shared words", () => {
    expect(similarity("Total: {amount}", "total {sum}")).toBe(1);
    expect(similarity("Save changes", "Save")).toBe(0.5);
    expect(similarity("", "x")).toBe(0);
  });
});
