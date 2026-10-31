import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { actionsCommand, findActions, inputFields, readInput, runCommand } from "../actions-commands.js";

const realFetch = globalThis.fetch;
const realExit = process.exit;
const realLog = console.log;
const realErr = console.error;
const TOKEN = "lfn_test_token_value";
const APPROVAL = { id: "apr_5", url: "https://dash.lefine.ai/approvals/apr_5", expiresAt: "x" };
let dir: string;
let logs: string[];
let calls: Array<{ url: string; headers: Record<string, string>; body: any }>;
let approvalAnswers: string[];

const FOUND = [
  { action: "studio.pieces.list", module: "studio", summary: "List the Studio pieces.", runWith: "lefine_read", asksFirst: false, inputSchema: { type: "object", properties: {} } },
  {
    action: "content.entries.publish",
    module: "content",
    summary: "Publish a page.",
    runWith: "lefine_publish",
    asksFirst: true,
    inputSchema: { type: "object", properties: { projectId: {}, entryId: {}, locales: {} }, required: ["projectId", "entryId", "locales"] },
  },
];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lefine-actions-"));
  process.env.LEFINE_HOME = join(dir, "home");
  process.env.LEFINE_TOKEN = TOKEN;
  process.env.LEFINE_API_URL = "http://api.test";
  logs = [];
  calls = [];
  approvalAnswers = ["approved"];
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  console.error = (...a: unknown[]) => void logs.push(a.join(" "));
  process.exit = ((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as typeof process.exit;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body ? JSON.parse(String(init.body)) : null });
    if (url.endsWith("/v1/mcp")) return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "2 items" }], structuredContent: { items: FOUND } } });
    if (url.includes("/v1/approvals/")) return Response.json({ ok: true, data: { status: approvalAnswers.shift() ?? "pending" } });
    const name = url.split("/v1/ops/")[1]!;
    const body = JSON.parse(String(init?.body));
    if (name === "content.entries.publish" && body.approval !== APPROVAL.id) {
      return Response.json({ ok: false, error: { code: "APPROVAL_REQUIRED", message: "ask" }, approval: APPROVAL }, { status: 428 });
    }
    if (name === "studio.pieces.list") return Response.json({ ok: true, data: { items: [{ id: "pc_1", title: "Launch\u001b]0;x\u0007" }] } });
    if (name === "content.entries.publish") return Response.json({ ok: true, data: { id: "ent_1", headVersionNo: 3 } });
    return Response.json({ ok: false, error: { code: "NOT_FOUND", message: `There is no action called "${name}".` } }, { status: 404 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.exit = realExit;
  console.log = realLog;
  console.error = realErr;
  delete process.env.LEFINE_HOME;
  delete process.env.LEFINE_TOKEN;
  delete process.env.LEFINE_API_URL;
  rmSync(dir, { recursive: true, force: true });
});

const noWait = { openBrowser: () => {}, sleep: async () => {} };

describe("lefine actions", () => {
  it("asks the server's own search (lefine_find) in one stateless MCP call, with the key only in the header", async () => {
    const items = await findActions({ token: TOKEN, apiUrl: "http://api.test" }, { query: "video", module: "studio", limit: 3 });
    expect(items.map((i) => i.action)).toEqual(["studio.pieces.list", "content.entries.publish"]);
    const call = calls[0]!;
    expect(call.url).toBe("http://api.test/v1/mcp");
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.headers["mcp-method"]).toBe("tools/call");
    expect(call.headers["mcp-name"]).toBe("lefine_find");
    expect(call.body.params).toMatchObject({ name: "lefine_find", arguments: { query: "video", module: "studio", limit: 3 } });
    expect(JSON.stringify(call.body)).not.toContain(TOKEN);
  });

  it("prints each action with its module, whether it asks first, and its input (required marked)", async () => {
    await actionsCommand(["publish", "page"], {});
    const text = logs.join("\n");
    expect(text).toContain("content.entries.publish");
    expect(text).toContain("asks a person first");
    expect(text).toContain("input: projectId*, entryId*, locales*");
    expect(text).toContain("input: no input");
    expect(inputFields({ properties: { a: {}, b: {} }, required: ["b"] })).toBe("a, b*");
  });

  it("refuses a limit over the server's 10 before any call", async () => {
    await expect(actionsCommand([], { limit: "50" })).rejects.toThrow("exit:1");
    expect(calls).toEqual([]);
  });
});

describe("lefine run", () => {
  it("runs an action of any module through /v1/ops and prints the answer as JSON (no escape sequences)", async () => {
    await runCommand("studio.pieces.list", {}, noWait);
    expect(calls[0]!.url).toBe("http://api.test/v1/ops/studio.pieces.list");
    expect(calls[0]!.body).toEqual({ input: {} });
    const text = logs.join("\n");
    expect(text).toContain('"id": "pc_1"');
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u0007");
  });

  it("an action that asks first waits for the person's yes, then runs once with the approval", async () => {
    await runCommand("content.entries.publish", { input: '{"projectId":"prj_1","entryId":"ent_1","locales":["de"]}' }, noWait);
    const runs = calls.filter((c) => c.url.includes("/v1/ops/"));
    expect(runs.length).toBe(2);
    expect(runs[1]!.body).toEqual({ input: { projectId: "prj_1", entryId: "ent_1", locales: ["de"] }, approval: "apr_5" });
    expect(logs.join("\n")).toContain(APPROVAL.url);
  });

  it("nobody approving in time names the rerun with --approval", async () => {
    approvalAnswers = [];
    let t = 0;
    await expect(runCommand("content.entries.publish", { input: "{}" }, { ...noWait, now: () => (t += 60_000), approvalWaitMs: 1 })).rejects.toThrow("exit:1");
    expect(logs.join("\n")).toContain("--approval apr_5");
  });

  it("an unknown action points at lefine actions, with one period", async () => {
    await expect(runCommand("strings.nope.list", {}, noWait)).rejects.toThrow("exit:1");
    const text = logs.join("\n");
    expect(text).toContain('There is no action called "strings.nope.list". See what you can run with `lefine actions <words>`.');
    expect(text).not.toContain("whoami");
  });

  it("input from @file or stdin; not JSON, or not an object, is refused before any call", async () => {
    const file = join(dir, "in.json");
    writeFileSync(file, '{"appId":"app_1"}');
    expect(readInput(`@${file}`)).toEqual({ appId: "app_1" });
    expect(readInput("-", () => '{"a":1}')).toEqual({ a: 1 });
    expect(readInput(undefined)).toEqual({});
    expect(() => readInput("[1]")).toThrow("JSON object");
    await expect(runCommand("studio.pieces.list", { input: "{nope" }, noWait)).rejects.toThrow("exit:1");
    await expect(runCommand("../etc/passwd", {}, noWait)).rejects.toThrow("exit:1");
    expect(calls).toEqual([]);
  });
});

describe("safeJson", () => {
  it("writes DEL, C1 and bidi controls as \\uXXXX, and still parses to the same value", async () => {
    const { safeJson } = await import("../safe-text.js");
    const value = { title: "a\u009b2Jb‮c\u007fd\u001be" };
    const text = safeJson(value, 2);
    for (const ch of ["\u009b", "‮", "\u007f", "\u001b"]) expect(text).not.toContain(ch);
    expect(text).toContain("\\u009b");
    expect(JSON.parse(text)).toEqual(value);
  });

  it("lefine run prints a C1 control from the server as an escape, in text and --json", async () => {
    globalThis.fetch = (async () => Response.json({ ok: true, data: { name: "x\u009b31my" } })) as unknown as typeof fetch;
    await runCommand("studio.pieces.list", {}, noWait);
    await runCommand("studio.pieces.list", { json: true }, noWait);
    const text = logs.join("\n");
    expect(text).not.toContain("\u009b");
    expect(text).toContain("\\u009b31my");
  });
});
