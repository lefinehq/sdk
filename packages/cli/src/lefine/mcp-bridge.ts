/**
 * The Lefine MCP bridge: stdio on one side, Lefine's remote MCP server (POST /v1/mcp) on the other.
 * For clients that only start local servers (Claude Desktop config, some IDEs). It adds the access key
 * and forwards each message as it is; the server holds every remote tool and every rule, so the bridge
 * never needs a release when an action is added.
 *
 * Both MCP eras pass through. A modern (2026-07-28) message names its version in `_meta`, and the bridge
 * mirrors it in the MCP-Protocol-Version, Mcp-Method and Mcp-Name headers the server checks. A legacy
 * message gets the version the `initialize` answer agreed on.
 *
 * What it adds on top of a plain proxy:
 *  - tools/list comes from the server (all pages), is kept for `toolsTtlMs`, and is served stale when the
 *    server cannot be reached; the local tools (mcp-local.ts) are appended.
 *  - tools/call of a local tool is answered here (it needs your disk); every other call is forwarded.
 *  - --read-only and --toolsets (mcp-config.ts) hide tools and refuse calls; --read-only also asks the
 *    server for a read ceiling, so a tool this file does not know still cannot write.
 *  - a 401 becomes one clear sentence: run `npx @lefine/mcp setup`.
 *
 * stdout carries only JSON-RPC, one message per line; anything for people goes to stderr.
 */

import { type McpOptions, DEFAULT_OPTIONS, guardRemoteCall, remoteToolVisible } from "./mcp-config.js";
import { callLocal, isLocalTool, localToolDefs } from "./mcp-local.js";
import { allowedRoots } from "./mcp-paths.js";
import { createOpClient } from "./client.js";
import { errResult } from "./mcp-result.js";

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
  /** Flags (mcp-config.ts). Default: everything on, nothing filtered. */
  options?: McpOptions;
  /** The folder local tools read from. Default: process.cwd(). */
  cwd?: string;
  /** Test seam for the tool list's age. */
  now?: () => number;
}

type Message = { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown>; result?: Record<string, unknown> };
type RemoteTool = { name?: unknown; annotations?: { readOnlyHint?: boolean } } & Record<string, unknown>;

export const NO_KEY =
  "Lefine is not signed in. Run `npx @lefine/mcp setup` (or `npx lefine login`), or set LEFINE_TOKEN to a key from Settings > API keys (tick Content or Studio there if the agent needs them).";
export const KEY_REFUSED =
  "Lefine refused the key (401): it is wrong, revoked or expired. Run `npx @lefine/mcp setup` to sign in again, or check LEFINE_TOKEN.";

/** Header-safe ASCII, or the `=?base64?...?=` sentinel the spec defines for other values. */
function headerValue(value: string): string {
  if (/^[\x20-\x7e]*$/.test(value)) return value;
  const bytes = new TextEncoder().encode(value);
  return `=?base64?${Buffer.from(bytes).toString("base64")}?=`;
}

const MAX_PAGES = 10;

export function createBridge(deps: BridgeDeps) {
  const options = deps.options ?? DEFAULT_OPTIONS;
  const now = deps.now ?? Date.now;
  const cwd = deps.cwd ?? process.cwd();
  /** The legacy version `initialize` agreed on; sent on every later legacy request. */
  let legacyVersion: string | undefined;
  /** The server's tool list (unfiltered), when it was read, and the rest of the result (resultType and the like). */
  let cache: { at: number; tools: RemoteTool[]; rest: Record<string, unknown> } | null = null;
  let roots: string[] | null = null;

  const getRoots = (): string[] => {
    if (roots) return roots;
    try {
      roots = allowedRoots(cwd, options.allowDirs);
    } catch (err) {
      deps.log(`lefine-mcp: ${err instanceof Error ? err.message : String(err)} Local tools read only ${cwd}.`);
      roots = allowedRoots(cwd, []);
    }
    return roots;
  };

  const reply = (id: unknown, code: number, message: string) => {
    if (id === undefined || id === null) return;
    deps.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
  };
  const result = (id: unknown, value: unknown) => deps.write(JSON.stringify({ jsonrpc: "2.0", id, result: value }));

  type Sent = { kind: "net" } | { kind: "http"; status: number; parsed: Message | null };

  /** POSTs a message to the server with the headers its era needs. */
  async function send(auth: BridgeAuth, msg: Message, body: string): Promise<Sent> {
    const meta = (msg.params?._meta ?? {}) as Record<string, unknown>;
    const modernVersion = typeof meta["io.modelcontextprotocol/protocolVersion"] === "string" ? (meta["io.modelcontextprotocol/protocolVersion"] as string) : undefined;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${auth.token}`,
      "user-agent": `lefine-mcp/${deps.clientVersion}`,
    };
    if (modernVersion) {
      headers["mcp-protocol-version"] = modernVersion;
      headers["mcp-method"] = String(msg.method);
      const name = msg.params?.name ?? msg.params?.uri;
      if (typeof name === "string") headers["mcp-name"] = headerValue(name);
    } else if (legacyVersion && msg.method !== "initialize") {
      headers["mcp-protocol-version"] = legacyVersion;
    }
    let res: Response;
    try {
      // --read-only: the server holds a read ceiling for this connection (?level=read), whatever this file hides.
      res = await deps.fetch(`${auth.apiUrl}/v1/mcp${options.readOnly ? "?level=read" : ""}`, { method: "POST", headers, body });
    } catch {
      return { kind: "net" };
    }
    if (res.status === 202) return { kind: "http", status: 202, parsed: null };
    const text = await res.text();
    let parsed: Message | null = null;
    try {
      parsed = text ? (JSON.parse(text) as Message) : null;
    } catch {
      parsed = null;
    }
    return { kind: "http", status: res.status, parsed };
  }

  /** Fails the request for the client: a network error, a 401, or an answer that is not JSON-RPC. True when it did. */
  function failed(auth: BridgeAuth, msg: Message, sent: Sent): boolean {
    if (sent.kind === "net") {
      reply(msg.id, -32603, `Could not reach Lefine at ${auth.apiUrl}. Check the connection and try again.`);
      return true;
    }
    if (sent.status === 401) {
      cache = null;
      deps.log(`lefine-mcp: ${KEY_REFUSED}`);
      reply(msg.id, -32001, KEY_REFUSED);
      return true;
    }
    if (sent.status !== 202 && !sent.parsed) {
      reply(msg.id, -32603, `Lefine answered HTTP ${sent.status} without a JSON-RPC message.`);
      return true;
    }
    return false;
  }

  /** The server's whole tool list (all pages), from the cache while it is fresh. Null when it could not be read (the error is sent). */
  async function remoteTools(auth: BridgeAuth, msg: Message): Promise<{ tools: RemoteTool[]; rest: Record<string, unknown> } | null> {
    if (cache && now() - cache.at < options.toolsTtlMs) return cache;
    const tools: RemoteTool[] = [];
    let rest: Record<string, unknown> = {};
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const paged: Message = { ...msg, params: { ...(msg.params ?? {}), ...(cursor ? { cursor } : {}) } };
      if (!cursor) delete paged.params!.cursor;
      const sent = await send(auth, paged, JSON.stringify(paged));
      if (sent.kind === "net" || (sent.kind === "http" && sent.status !== 200)) {
        // Stale beats nothing: a dropped connection should not empty the model's tool list.
        if (cache && sent.kind === "net") {
          deps.log("lefine-mcp: Lefine is not reachable; the tool list is the last one read.");
          return cache;
        }
        // An error from the server (403, a JSON-RPC error body) goes to the client as the server said it.
        if (!failed(auth, msg, sent) && sent.kind === "http" && sent.parsed) deps.write(JSON.stringify(sent.parsed.id === null ? { ...sent.parsed, id: msg.id } : sent.parsed));
        return null;
      }
      if (failed(auth, msg, sent)) return null;
      const r = (sent as { parsed: Message }).parsed.result;
      if (!r || !Array.isArray(r.tools)) {
        const err = (sent as { parsed: Message }).parsed as { error?: { code?: number; message?: string } };
        reply(msg.id, err.error?.code ?? -32603, err.error?.message ?? "Lefine answered tools/list without a list of tools.");
        return null;
      }
      tools.push(...(r.tools as RemoteTool[]));
      const { tools: _t, nextCursor, ...others } = r as Record<string, unknown>;
      rest = others;
      if (typeof nextCursor !== "string" || nextCursor === "") break;
      cursor = nextCursor;
    }
    cache = { at: now(), tools, rest };
    return cache;
  }

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
    const auth = deps.auth;

    if (msg.method === "tools/list") {
      const remote = await remoteTools(auth, msg);
      if (!remote) return;
      const local = localToolDefs(options);
      const localNames = new Set(local.map((t) => t.name));
      const shown = remote.tools.filter((t) => !localNames.has(String(t.name)) && remoteToolVisible({ name: String(t.name), annotations: t.annotations }, options));
      result(msg.id, { ...remote.rest, tools: [...shown, ...local] });
      return;
    }

    if (msg.method === "tools/call") {
      const name = String(msg.params?.name ?? "");
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      if (isLocalTool(name)) {
        const out = await callLocal(name, args, { ops: createOpClient(auth.apiUrl, auth.token), cwd, roots: getRoots() }, options);
        result(msg.id, out);
        return;
      }
      const known = cache?.tools.find((t) => t.name === name);
      const refusal = guardRemoteCall(name, args, known ? { name, annotations: known.annotations } : undefined, options);
      if (refusal) {
        result(msg.id, errResult(refusal));
        return;
      }
    }

    const sent = await send(auth, msg, text);
    if (failed(auth, msg, sent)) return;
    if (sent.kind !== "http" || sent.status === 202 || !sent.parsed) return;
    let parsed = sent.parsed;
    if (msg.method === "initialize" && typeof parsed.result?.protocolVersion === "string") legacyVersion = parsed.result.protocolVersion;
    // The server answers some refusals (no key, bad JSON) before it reads the id; the client is waiting for its own.
    if (parsed.id === null && msg.id !== undefined && msg.id !== null) parsed = { ...parsed, id: msg.id };
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
