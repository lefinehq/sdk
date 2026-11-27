import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { KEY_REFUSED, NO_KEY, createBridge } from "../mcp-bridge.js";
import { DEFAULT_OPTIONS, type McpOptions, resolveMcpOptions } from "../mcp-config.js";
import { localToolDefs } from "../mcp-local.js";

/** A stub of dash.lefine.ai/v1/mcp on a real port: the bridge talks to it with the real fetch. */
type Seen = { url: string; headers: Record<string, string>; body: { id?: unknown; method?: string; params?: Record<string, unknown> } };
let seen: Seen[] = [];
let mode: "ok" | "401" | "down" = "ok";
let server: ReturnType<typeof Bun.serve>;
let apiUrl = "";

const REMOTE = [
  { name: "lefine_context", inputSchema: {}, annotations: { readOnlyHint: true } },
  { name: "lefine_lookup", inputSchema: {}, annotations: { readOnlyHint: true } },
  { name: "lefine_read", inputSchema: {} },
  { name: "lefine_write", inputSchema: {} },
  { name: "lefine_publish", inputSchema: {} },
  { name: "lefine_edit", inputSchema: {} },
  { name: "lefine_launch", inputSchema: {} },
  { name: "lefine_launch_status", inputSchema: {}, annotations: { readOnlyHint: true } },
  { name: "lefine_future_report", inputSchema: {}, annotations: { readOnlyHint: true } },
  { name: "lefine_future_delete", inputSchema: {} },
];

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const body = (await req.json()) as Seen["body"];
      seen.push({ url: req.url, headers: Object.fromEntries(req.headers), body });
      if (mode === "401") return Response.json({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "Add your Lefine access key" } }, { status: 401 });
      if (body.method === "tools/list") {
        // Two pages, to prove the bridge follows nextCursor.
        const cursor = body.params?.cursor;
        return Response.json({ jsonrpc: "2.0", id: body.id, result: cursor ? { tools: REMOTE.slice(5) } : { tools: REMOTE.slice(0, 5), nextCursor: "p2" } });
      }
      if (body.method === "tools/call") return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: `ran ${String(body.params?.name)}` }] } });
      return Response.json({ jsonrpc: "2.0", id: body.id, result: {} });
    },
  });
  apiUrl = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));
beforeEach(() => {
  seen = [];
  mode = "ok";
});

function make(options: McpOptions = DEFAULT_OPTIONS, extra: { fetch?: typeof fetch; now?: () => number } = {}) {
  const out: Array<Record<string, any>> = [];
  const logs: string[] = [];
  const bridge = createBridge({
    auth: { token: "lfn_secret_token", apiUrl },
    fetch: extra.fetch ?? fetch,
    write: (l) => out.push(JSON.parse(l)),
    log: (l) => logs.push(l),
    clientVersion: "1.0.0-test",
    options,
    now: extra.now,
    cwd: process.cwd(),
  });
  const send = (method: string, params?: Record<string, unknown>, id: number = out.length + seen.length + 1) => bridge.handle(JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }));
  return { bridge, out, logs, send };
}
const names = (m: Record<string, any>): string[] => m.result.tools.map((t: { name: string }) => t.name);
const LOCAL = localToolDefs(DEFAULT_OPTIONS).map((t) => t.name);

describe("proxy: tools/list", () => {
  test("the server's tools (every page) and the local tools are merged", async () => {
    const { out, send } = make();
    await send("tools/list");
    expect(names(out[0]!)).toEqual([...REMOTE.map((t) => t.name), ...LOCAL]);
    expect(seen.map((s) => s.body.params?.cursor)).toEqual([undefined, "p2"]);
  });
  test("the key goes in the Authorization header and the bridge names itself", async () => {
    const { send } = make();
    await send("tools/list");
    expect(seen[0]!.headers.authorization).toBe("Bearer lfn_secret_token");
    expect(seen[0]!.headers["user-agent"]).toBe("lefine-mcp/1.0.0-test");
    expect(seen[0]!.url).toBe(`${apiUrl}/v1/mcp`);
  });
  test("the list is cached for the ttl, then read again", async () => {
    let t = 1_000;
    const { out, send } = make({ ...DEFAULT_OPTIONS, toolsTtlMs: 60_000 }, { now: () => t });
    await send("tools/list");
    const first = seen.length;
    t += 30_000;
    await send("tools/list");
    expect(seen.length).toBe(first);
    expect(names(out[1]!)).toEqual(names(out[0]!));
    t += 31_000;
    await send("tools/list");
    expect(seen.length).toBe(first * 2);
  });
  test("ttl 0 means every tools/list asks the server", async () => {
    const { send } = make({ ...DEFAULT_OPTIONS, toolsTtlMs: 0 });
    await send("tools/list");
    await send("tools/list");
    expect(seen.length).toBe(4);
  });
  test("when the server cannot be reached, the last list is served and it is said on stderr", async () => {
    let t = 0;
    let down = false;
    const flaky = (async (...a: Parameters<typeof fetch>) => {
      if (down) throw new TypeError("fetch failed");
      return fetch(...a);
    }) as typeof fetch;
    const { out, logs, send } = make({ ...DEFAULT_OPTIONS, toolsTtlMs: 10 }, { fetch: flaky, now: () => t });
    await send("tools/list");
    t += 1000;
    down = true;
    await send("tools/list");
    expect(names(out[1]!)).toEqual(names(out[0]!));
    expect(logs.join("\n")).toContain("last one read");
  });
  test("with no list yet and no connection, the client gets an error on its own id", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const { out, send } = make(DEFAULT_OPTIONS, { fetch: down });
    await send("tools/list", undefined, 41);
    expect(out[0]).toMatchObject({ id: 41, error: { code: -32603 } });
    expect(out[0]!.error.message).toContain("Could not reach Lefine");
  });
});

describe("proxy: calls and auth", () => {
  test("a remote tools/call is passed through with the key, and the answer comes back unchanged", async () => {
    const { out, send } = make();
    await send("tools/call", { name: "lefine_read", arguments: { action: "strings.apps.list", input: {} } }, 7);
    expect(out[0]).toEqual({ jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "ran lefine_read" }] } });
    expect(seen[0]!.headers.authorization).toBe("Bearer lfn_secret_token");
    expect(seen[0]!.body.params).toEqual({ name: "lefine_read", arguments: { action: "strings.apps.list", input: {} } });
  });
  test("a 401 says: run npx @lefine/mcp setup, once, on the client's id, and drops the cached list", async () => {
    const { out, logs, send } = make();
    await send("tools/list");
    mode = "401";
    await send("tools/call", { name: "lefine_read", arguments: {} }, 9);
    expect(out[1]).toEqual({ jsonrpc: "2.0", id: 9, error: { code: -32001, message: KEY_REFUSED } });
    expect(KEY_REFUSED).toContain("npx @lefine/mcp setup");
    expect(logs.some((l) => l.includes("npx @lefine/mcp setup"))).toBe(true);
    seen = [];
    await send("tools/list", undefined, 10);
    expect(seen.length).toBe(1);
    expect(out[2]).toMatchObject({ id: 10, error: { message: KEY_REFUSED } });
  });
  test("no key at all: nothing is sent and the answer says how to sign in", async () => {
    const out: Array<Record<string, any>> = [];
    const bridge = createBridge({ auth: null, fetch, write: (l) => out.push(JSON.parse(l)), log: () => {}, clientVersion: "x" });
    await bridge.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(seen.length).toBe(0);
    expect(out[0]!.error.message).toBe(NO_KEY);
    expect(NO_KEY).toContain("npx @lefine/mcp setup");
  });
  test("the key never appears in what the client receives", async () => {
    const { out, send } = make();
    await send("tools/list");
    await send("tools/call", { name: "lefine_read", arguments: {} });
    expect(JSON.stringify(out)).not.toContain("lfn_secret_token");
  });
});

describe("--read-only", () => {
  const ro = resolveMcpOptions({ readOnly: true }, {});
  test("write, publish, edit, launch and unknown non-read tools are hidden; read tools stay", async () => {
    const { out, send } = make(ro);
    await send("tools/list");
    const shown = names(out[0]!);
    expect(shown).toEqual(["lefine_context", "lefine_lookup", "lefine_read", "lefine_launch_status", "lefine_future_report", "lefine_project", "lefine_find_similar_key"]);
    for (const hidden of ["lefine_write", "lefine_publish", "lefine_edit", "lefine_launch", "lefine_future_delete", "lefine_upload_file", "lefine_upload_folder", "lefine_import_locale_files", "lefine_add_key"]) expect(shown).not.toContain(hidden);
  });
  test("the server is asked for a read ceiling, on every request", async () => {
    const { send } = make(ro);
    await send("tools/list");
    await send("tools/call", { name: "lefine_read", arguments: {} });
    expect(seen.every((s) => s.url.endsWith("/v1/mcp?level=read"))).toBe(true);
  });
  test("calling a hidden tool is refused here, and nothing is sent", async () => {
    const { out, send } = make(ro);
    await send("tools/call", { name: "lefine_write", arguments: { action: "strings.keys.create", input: {} } }, 3);
    await send("tools/call", { name: "lefine_upload_file", arguments: { path: "a.png" } }, 4);
    expect(seen.length).toBe(0);
    for (const o of out) expect(o.result).toMatchObject({ isError: true });
    expect(out[0]!.result.content[0].text).toContain("--read-only");
  });
});

describe("--toolsets", () => {
  const strings = resolveMcpOptions({ toolsets: "strings" }, {});
  test("local tools of other modules are hidden; the generic tools stay; launch and unknown tools go", async () => {
    const { out, send } = make(strings);
    await send("tools/list");
    const shown = names(out[0]!);
    expect(shown).toContain("lefine_import_locale_files");
    expect(shown).toContain("lefine_add_key");
    expect(shown).toContain("lefine_project");
    expect(shown).toContain("lefine_edit");
    for (const hidden of ["lefine_upload_file", "lefine_upload_folder", "lefine_launch", "lefine_launch_status", "lefine_future_report"]) expect(shown).not.toContain(hidden);
  });
  test("an action of another module is refused, also inside steps; an action of the toolset goes through", async () => {
    const { out, send } = make(strings);
    await send("tools/call", { name: "lefine_write", arguments: { action: "content.entries.update", input: {} } }, 1);
    await send("tools/call", { name: "lefine_write", arguments: { steps: [{ action: "strings.keys.create", input: {} }, { action: "studio.pieces.create", input: {} }] } }, 2);
    expect(seen.length).toBe(0);
    expect(out[0]!.result.content[0].text).toContain("content toolset");
    expect(out[1]!.result.content[0].text).toContain("studio toolset");
    await send("tools/call", { name: "lefine_write", arguments: { action: "strings.keys.create", input: {} } }, 3);
    expect(out[2]).toMatchObject({ id: 3, result: { content: [{ text: "ran lefine_write" }] } });
  });
  test("an unknown toolset name is an error that lists the real ones", () => {
    expect(() => resolveMcpOptions({ toolsets: "strings,nope" }, {})).toThrow(/Unknown toolset nope.*strings/);
  });
});

describe("flags and environment", () => {
  test("flags beat environment; environment fills what flags leave", () => {
    expect(resolveMcpOptions({}, { LEFINE_MCP_READ_ONLY: "1" }).readOnly).toBe(true);
    expect(resolveMcpOptions({}, {}).readOnly).toBe(false);
    expect([...resolveMcpOptions({}, { LEFINE_MCP_TOOLSETS: "content, strings" }).toolsets!]).toEqual(["content", "strings"]);
    expect([...resolveMcpOptions({ toolsets: "studio" }, { LEFINE_MCP_TOOLSETS: "content" }).toolsets!]).toEqual(["studio"]);
    expect(resolveMcpOptions({ allowDir: ["/a", "/b"] }, {}).allowDirs).toEqual(["/a", "/b"]);
    expect(resolveMcpOptions({ readonly: true }, {}).readOnly).toBe(true);
  });
  test("ttl is seconds; nonsense is refused", () => {
    expect(resolveMcpOptions({ toolsTtl: "2" }, {}).toolsTtlMs).toBe(2000);
    expect(() => resolveMcpOptions({ toolsTtl: "-1" }, {})).toThrow();
    expect(() => resolveMcpOptions({ toolsTtl: "abc" }, {})).toThrow();
  });
});
