/**
 * The Lefine MCP bridge: stdio on one side, Lefine's remote MCP server (POST /v1/mcp) on the other.
 * For clients that only start local servers (Claude Desktop config, some IDEs). It adds the access key
 * and forwards each message as it is; the server holds every tool and every rule, so the bridge never
 * needs a release when an action is added.
 *
 * Both MCP eras pass through. A modern (2026-07-28) message names its version in `_meta`, and the bridge
 * mirrors it in the MCP-Protocol-Version, Mcp-Method and Mcp-Name headers the server checks. A legacy
 * message gets the version the `initialize` answer agreed on.
 *
 * Two tools are answered here, not by the server: lefine_find_similar_key and lefine_add_key (mcp-tools.ts).
 * They are added to the first page of tools/list.
 *
 * stdout carries only JSON-RPC, one message per line; anything for people goes to stderr.
 */

import { LOCAL_TOOLS, callLocalTool } from "./mcp-tools.js";

export interface BridgeAuth {
  token: string;
  apiUrl: string;
}

export interface BridgeDeps {
  /** Null when there is no key: every request is answered with how to sign in. */
  auth: BridgeAuth | null;
  fetch: typeof fetch;
  /** One JSON-RPC message, already serialized, for stdout. */
  write: (line: string) => void;
  log: (line: string) => void;
  clientVersion: string;
}

type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown>; result?: Record<string, unknown> };

const NO_KEY =
  "Lefine is not signed in. Run `npx lefine login`, or set LEFINE_TOKEN to a key from Settings > API keys (tick Content or Studio there if the agent needs them).";

/** Header-safe ASCII, or the `=?base64?...?=` sentinel the spec defines for other values. */
function headerValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  return `=?base64?${Buffer.from(bytes).toString("base64")}?=`;
}

export function createBridge(deps: BridgeDeps) {
  /** The legacy version `initialize` agreed on; sent on every later legacy request. */
  let legacyVersion: string | undefined;

  const reply = (id: unknown, code: number, message: string) => {
    if (id === undefined || id === null) return;
    deps.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  };

  async function handle(line: string): Promise<void> {
    const text = line.trim();
    if (!text) return;
    let msg: Message;
    try {
      msg = JSON.parse(text) as Message;
    } catch {
      deps.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "The message is not JSON." } }));
      return;
    }
    // A response from the client (to a server request) has no method; this server never sends requests.
    if (typeof msg.method !== "string") return;
    if (!deps.auth) {
      reply(msg.id, -32001, NO_KEY);
      return;
    }

    if (msg.method === "tools/call" && LOCAL_TOOLS.some((t) => t.name === msg.params?.name)) {
      const result = await callLocalTool(deps.auth, String(msg.params?.name), (msg.params?.arguments ?? {}) as Record<string, unknown>);
      deps.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }));
      return;
    }

    const meta = (msg.params?._meta ?? {}) as Record<string, unknown>;
    const modernVersion = typeof meta["io.modelcontextprotocol/protocolVersion"] === "string" ? (meta["io.modelcontextprotocol/protocolVersion"] as string) : undefined;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${deps.auth.token}`,
      "user-agent": `lefine-mcp/${deps.clientVersion}`,
    };
    if (modernVersion) {
      headers["mcp-protocol-version"] = modernVersion;
      headers["mcp-method"] = msg.method;
      const name = msg.params?.name ?? msg.params?.uri;
      if (typeof name === "string") headers["mcp-name"] = headerValue(name);
    } else if (legacyVersion && msg.method !== "initialize") {
      headers["mcp-protocol-version"] = legacyVersion;
    }

    let res: Response;
    try {
      res = await deps.fetch(`${deps.auth.apiUrl}/v1/mcp`, { method: "POST", headers, body: text });
    } catch {
      reply(msg.id, -32603, `Could not reach Lefine at ${deps.auth.apiUrl}. Check the connection and try again.`);
      return;
    }
    if (res.status === 202) return;
    const body = await res.text();
    let parsed: Message | null = null;
    try {
      parsed = body ? (JSON.parse(body) as Message) : null;
    } catch {
      parsed = null;
    }
    if (!parsed) {
      reply(msg.id, -32603, `Lefine answered HTTP ${res.status} without a JSON-RPC message.`);
      return;
    }
    if (msg.method === "initialize" && typeof parsed.result?.protocolVersion === "string") legacyVersion = parsed.result.protocolVersion;
    if (res.status === 401) deps.log("lefine-mcp: the key was refused. Run `npx lefine login` again or check LEFINE_TOKEN.");
    // The server answers some refusals (no key, bad JSON) before it reads the id; the client is waiting for its own.
    if (parsed.id === null && msg.id !== undefined && msg.id !== null) parsed = { ...parsed, id: msg.id };
    const tools = parsed.result?.tools;
    if (msg.method === "tools/list" && Array.isArray(tools) && !msg.params?.cursor) parsed = { ...parsed, result: { ...parsed.result, tools: [...tools, ...LOCAL_TOOLS] } };
    deps.write(JSON.stringify(parsed));
  }

  return { handle };
}

/** Reads newline-delimited JSON-RPC from a stream and handles each message; messages may run concurrently. */
export async function runBridge(input: AsyncIterable<string | Buffer>, deps: BridgeDeps): Promise<void> {
  const bridge = createBridge(deps);
  const pending = new Set<Promise<void>>();
  let buffer = "";
  for await (const chunk of input) {
    buffer += chunk.toString();
    let at: number;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      const p = bridge.handle(line).finally(() => pending.delete(p));
      pending.add(p);
    }
  }
  if (buffer.trim()) pending.add(bridge.handle(buffer));
  await Promise.all(pending);
}
