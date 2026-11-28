import { describe, expect, test } from "bun:test";
import { localToolDefs } from "../mcp-local.js";
import { DEFAULT_OPTIONS } from "../mcp-config.js";
import { KEY_REFUSED, createBridge, runBridge } from "../mcp-bridge.js";

type Sent = { url: string; headers: Record<string, string>; body: unknown };

function setup(answer: (body: Record<string, unknown>) => { status: number; body?: unknown }, auth: { token: string; apiUrl: string } | null = { token: "lfn_test", apiUrl: "https://dash.lefine.ai" }, extra: { updateNote?: string | null } = {}) {
  const sent: Sent[] = [];
  const out: unknown[] = [];
  const logs: string[] = [];
  const deps = {
    auth,
    fetch: (async (url: string, init: { headers: Record<string, string>; body: string }) => {
      const body = JSON.parse(init.body) as Record<string, unknown>;
      sent.push({ url, headers: init.headers, body });
      const a = answer(body);
      return new Response(a.body === undefined ? null : JSON.stringify(a.body), { status: a.status });
    }) as unknown as typeof fetch,
    write: (line: string) => out.push(JSON.parse(line)),
    log: (line: string) => logs.push(line),
    clientVersion: "0.0.0-test",
    ...extra,
  };
  return { bridge: createBridge(deps), deps, sent, out, logs };
}

const ok = (id: unknown, result: Record<string, unknown>) => ({ status: 200, body: { jsonrpc: "2.0", id, result } });

describe("lefine-mcp bridge", () => {
  test("legacy: initialize, then every request carries the agreed version and the key", async () => {
    const { bridge, sent, out } = setup((b) => (b.method === "initialize" ? ok(b.id, { protocolVersion: "2025-06-18" }) : ok(b.id, { tools: [] })));
    await bridge.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }));
    await bridge.handle(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    expect(sent[0]!.url).toBe("https://dash.lefine.ai/v1/mcp");
    expect(sent[0]!.headers.authorization).toBe("Bearer lfn_test");
    expect(sent[0]!.headers["mcp-protocol-version"]).toBeUndefined();
    expect(sent[1]!.headers["mcp-protocol-version"]).toBe("2025-06-18");
    expect(out).toEqual([
      { jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18" } },
      // The bridge adds its local tools to the server's list (mcp-local.ts).
      { jsonrpc: "2.0", id: 2, result: { tools: [...localToolDefs(DEFAULT_OPTIONS)] } },
    ]);
  });

  test("update note: added once to the initialize instructions (kept after the server's own), never to a tool result", async () => {
    const note = "Lefine update: a newer Lefine MCP (1.2.3) is out.";
    const { bridge, out } = setup((b) => (b.method === "initialize" ? ok(b.id, { protocolVersion: "2025-06-18", instructions: "Use lefine_read." }) : ok(b.id, { content: [{ type: "text", text: "hi" }] })), undefined, { updateNote: note });
    await bridge.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }));
    await bridge.handle(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "lefine_read", arguments: {} } }));
    expect((out[0] as { result: { instructions: string } }).result.instructions).toBe(`Use lefine_read.\n\n${note}`);
    expect((out[1] as { result: { content: unknown[] } }).result.content).toEqual([{ type: "text", text: "hi" }]);
  });

  test("update note: instructions are created when the server sent none; without a note nothing changes", async () => {
    const a = setup((b) => ok(b.id, { protocolVersion: "2025-06-18" }), undefined, { updateNote: "N" });
    await a.bridge.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    expect((a.out[0] as { result: Record<string, unknown> }).result).toEqual({ protocolVersion: "2025-06-18", instructions: "N" });
    const b = setup((x) => ok(x.id, { protocolVersion: "2025-06-18" }), undefined, { updateNote: null });
    await b.bridge.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }));
    expect((b.out[0] as { result: Record<string, unknown> }).result).toEqual({ protocolVersion: "2025-06-18" });
  });

  test("update note: with no initialize (modern era) the first tool result carries it once, an error result never", async () => {
    const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };
    let n = 0;
    const { bridge, out } = setup((b) => ok(b.id, ++n === 1 ? { isError: true, content: [{ type: "text", text: "no" }] } : { content: [{ type: "text", text: "yes" }] }), undefined, { updateNote: "N" });
    for (const id of [1, 2, 3]) await bridge.handle(JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "lefine_read", arguments: {}, _meta: meta } }));
    const texts = out.map((o) => (o as { result: { content: Array<{ text: string }> } }).result.content.map((c) => c.text));
    expect(texts).toEqual([["no"], ["yes", "N"], ["yes"]]);
  });

  test("modern: the _meta version, method and tool name are mirrored in the headers", async () => {
    const { bridge, sent } = setup((b) => ok(b.id, { resultType: "complete" }));
    const meta = { "io.modelcontextprotocol/protocolVersion": "2026-07-28" };
    await bridge.handle(JSON.stringify({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lefine_read", arguments: {}, _meta: meta } }));
    expect(sent[0]!.headers).toMatchObject({ "mcp-protocol-version": "2026-07-28", "mcp-method": "tools/call", "mcp-name": "lefine_read" });
  });

  test("a notification is forwarded and nothing is written back", async () => {
    const { bridge, sent, out } = setup(() => ({ status: 202 }));
    await bridge.handle(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(sent.length).toBe(1);
    expect(out).toEqual([]);
  });

  test("without a key, a request is answered with how to sign in and nothing is sent", async () => {
    const { bridge, sent, out } = setup(() => ok(1, {}), null);
    await bridge.handle(JSON.stringify({ jsonrpc: "2.0", id: 9, method: "tools/list" }));
    expect(sent.length).toBe(0);
    expect((out[0] as { error: { message: string } }).error.message).toContain("npx @lefine/mcp setup");
  });

  test("a 401 becomes one clear sentence on the client's id, and is said on stderr", async () => {
    const err = { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Add your Lefine access key" } };
    const { bridge, out, logs } = setup(() => ({ status: 401, body: err }));
    await bridge.handle(JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }));
    expect(out).toEqual([{ jsonrpc: "2.0", id: 4, error: { code: -32001, message: KEY_REFUSED } }]);
    expect(KEY_REFUSED).toContain("npx @lefine/mcp setup");
    expect(logs[0]).toContain("refused");
  });

  test("another error body from the server is passed through on the client's id", async () => {
    const err = { jsonrpc: "2.0", id: null, error: { code: -32602, message: "bad params" } };
    const { bridge, out } = setup(() => ({ status: 400, body: err }));
    await bridge.handle(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "lefine_read" } }));
    expect(out).toEqual([{ ...err, id: 8 }]);
  });

  test("a network failure or a non-JSON answer becomes a JSON-RPC error for that id", async () => {
    const { bridge, out, deps } = setup(() => ({ status: 502, body: undefined }));
    await bridge.handle(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list" }));
    expect((out[0] as { id: number; error: { code: number } }).id).toBe(5);
    deps.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const again = createBridge(deps);
    await again.handle(JSON.stringify({ jsonrpc: "2.0", id: 6, method: "tools/list" }));
    expect((out[1] as { error: { message: string } }).error.message).toContain("Could not reach Lefine");
  });

  test("junk on stdin gets a parse error; a split stream is read line by line", async () => {
    const { deps, out } = setup((b) => ok(b.id, {}));
    async function* chunks() {
      yield "not json\n";
      yield '{"jsonrpc":"2.0","id":7,"meth';
      yield 'od":"ping"}\n';
    }
    await runBridge(chunks(), deps);
    expect((out[0] as { error: { code: number } }).error.code).toBe(-32700);
    expect(out[1]).toEqual({ jsonrpc: "2.0", id: 7, result: {} });
  });
});
