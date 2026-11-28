import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// End to end: the real bin, over stdio, against a stub of dash.lefine.ai/v1/mcp. Needs `lefine` built (bun run build in packages/lefine).
const bin = new URL("../bin/lefine-mcp.js", import.meta.url).pathname;
const built = existsSync(new URL("../../lefine/dist/cli.js", import.meta.url).pathname);

let stub: Server;
let url = "";
const requests: Array<{ url: string; auth: string | undefined; method: string }> = [];
let home: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "lefine-mcp-e2e-"));
  writeFileSync(join(home, "lefine.ts"), 'export const lefine = createLefine({ project: "app_e2e123" });');
  stub = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const msg = JSON.parse(body) as { id: number; method: string };
      requests.push({ url: req.url ?? "", auth: req.headers.authorization, method: msg.method });
      res.setHeader("content-type", "application/json");
      if (req.headers.authorization !== "Bearer lfn_e2e") {
        res.statusCode = 401;
        res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "key" } }));
        return;
      }
      const result = msg.method === "tools/list" ? { tools: [{ name: "lefine_read", inputSchema: {} }, { name: "lefine_write", inputSchema: {} }] } : { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "stub", version: "0" } };
      res.end(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
    });
  });
  await new Promise<void>((r) => stub.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(stub.address() as { port: number }).port}`;
});
afterAll(() => {
  stub.close();
  rmSync(home, { recursive: true, force: true });
});

/** Starts the bin with stdin as a pipe (so it is the server, not the wizard), sends lines, reads one reply per id. */
function run(args: string[], env: Record<string, string>) {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [bin, ...args], { cwd: home, env: { PATH: process.env.PATH ?? "", HOME: home, LEFINE_HOME: join(home, ".lefine"), LEFINE_API_URL: url, LEFINE_NO_UPDATE_CHECK: "1", ...env } });
  let out = "";
  let err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  const lines = () => out.split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, any>);
  const ask = async (msg: Record<string, unknown>) => {
    child.stdin.write(`${JSON.stringify(msg)}\n`);
    for (let i = 0; i < 200; i++) {
      const hit = lines().find((l) => l.id === msg.id);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`no answer to ${JSON.stringify(msg)}; stderr: ${err}`);
  };
  return { ask, stderr: () => err, stdout: () => out, stop: () => child.kill() };
}

describe.skipIf(!built)("npx @lefine/mcp over stdio", () => {
  it("lists the server's tools plus the local ones, with the key, and stdout stays pure JSON-RPC", async () => {
    const s = run([], { LEFINE_TOKEN: "lfn_e2e" });
    try {
      await s.ask({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
      const list = await s.ask({ jsonrpc: "2.0", id: 2, method: "tools/list" });
      const names = list.result.tools.map((t: { name: string }) => t.name);
      expect(names).toEqual(expect.arrayContaining(["lefine_read", "lefine_write", "lefine_project", "lefine_upload_file", "lefine_upload_folder", "lefine_import_locale_files", "lefine_find_similar_key", "lefine_add_key"]));
      expect(requests.every((r) => r.auth === "Bearer lfn_e2e" && r.url === "/v1/mcp")).toBe(true);
      const project = await s.ask({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "lefine_project", arguments: {} } });
      expect(project.result.structuredContent).toMatchObject({ found: true, appId: "app_e2e123" });
      expect(() => s.stdout().split("\n").filter(Boolean).forEach((l) => JSON.parse(l))).not.toThrow();
      expect(s.stderr()).not.toContain("lfn_e2e");
    } finally {
      s.stop();
    }
  });

  it("a newer version in the update cache is said on stderr and added to the initialize instructions; stdout stays JSON-RPC", async () => {
    mkdirSync(join(home, ".lefine"), { recursive: true });
    writeFileSync(join(home, ".lefine", "update-check.json"), JSON.stringify({ "@lefine/mcp": { checkedAt: Date.now(), tags: { latest: "0.2.7", next: "9.0.0-rc.1" } } }));
    const s = run([], { LEFINE_TOKEN: "lfn_e2e", LEFINE_NO_UPDATE_CHECK: "" });
    try {
      const init = await s.ask({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
      expect(init.result.instructions).toContain("a newer Lefine MCP (9.0.0-rc.1) is out");
      expect(s.stderr()).toContain("lefine mcp: 9.0.0-rc.1 is out");
      expect(() => s.stdout().split("\n").filter(Boolean).forEach((l) => JSON.parse(l))).not.toThrow();
    } finally {
      s.stop();
    }
    // The same cache with LEFINE_NO_UPDATE_CHECK=1: silent.
    const quiet = run([], { LEFINE_TOKEN: "lfn_e2e" });
    try {
      const init = await quiet.ask({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
      expect(init.result.instructions).toBeUndefined();
      expect(quiet.stderr()).not.toContain("is out");
    } finally {
      quiet.stop();
      rmSync(join(home, ".lefine", "update-check.json"), { force: true });
    }
  });

  it("--read-only hides the write tools and asks the server for ?level=read", async () => {
    requests.length = 0;
    const s = run(["--read-only"], { LEFINE_TOKEN: "lfn_e2e" });
    try {
      const list = await s.ask({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      const names = list.result.tools.map((t: { name: string }) => t.name);
      expect(names).toContain("lefine_read");
      for (const hidden of ["lefine_write", "lefine_upload_file", "lefine_upload_folder", "lefine_import_locale_files", "lefine_add_key"]) expect(names).not.toContain(hidden);
      expect(requests.every((r) => r.url === "/v1/mcp?level=read")).toBe(true);
    } finally {
      s.stop();
    }
  });

  it("a wrong key gives the sentence that says what to run", async () => {
    const s = run([], { LEFINE_TOKEN: "lfn_wrong" });
    try {
      const reply = await s.ask({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(reply.error.message).toContain("npx @lefine/mcp setup");
    } finally {
      s.stop();
    }
  });

  it("no key at all says how to sign in; a bad flag stops with a message", async () => {
    const s = run([], {});
    try {
      const reply = await s.ask({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      expect(reply.error.message).toContain("npx @lefine/mcp setup");
    } finally {
      s.stop();
    }
    const bad = run(["--toolsets=nope"], { LEFINE_TOKEN: "lfn_e2e" });
    await new Promise((r) => setTimeout(r, 800));
    expect(bad.stderr()).toContain("Unknown toolset nope");
  });
});
