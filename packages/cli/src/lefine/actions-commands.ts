/**
 * `lefine actions [words]` and `lefine run <action>` (one Lefine CLI for every module): the
 * shared action list, from the terminal. Every module's actions (Strings, Content, Studio, Social, Brain, connected
 * apps) under the same names as the MCP tools and /v1/ops, without a hand-written command for each.
 *
 * `actions` asks the server's own search (the MCP tool lefine_find): it lists only what this key may run, with each
 * action's input. `run` posts to /v1/ops/<action>; the server checks scope, module, input and app limits, and an
 * action that asks first waits for a person's approval in Lefine, as every other command does.
 */

import { readFileSync } from "node:fs";
import { bold, cyan, dim, yellow } from "../utils/colors.js";
import { fail, openInBrowser, out, type GlobalOptions } from "./auth-commands.js";
import { callWithApproval, createOpClient, LefineError } from "./client.js";
import { resolveLefineAuth } from "./credentials.js";
import { safeJson, safeText as s } from "./safe-text.js";

/** The MCP era the CLI speaks for one stateless request (no initialize needed). */
const MCP_VERSION = "2026-07-28";

export interface FoundAction {
  action: string;
  module: string;
  summary: string;
  runWith: string;
  asksFirst: boolean;
  inputSchema: { properties?: Record<string, { type?: unknown; description?: unknown }>; required?: string[] };
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function authOrFail(options: GlobalOptions) {
  const auth = resolveLefineAuth(options);
  if (!auth) throw new LefineError("UNAUTHORIZED", "no key");
  return auth;
}

/** One tools/call of lefine_find on /v1/mcp. */
export async function findActions(
  auth: { token: string; apiUrl: string },
  args: { query?: string; module?: string; limit?: number },
  fetcher: FetchLike = (i, init) => fetch(i, init),
): Promise<FoundAction[]> {
  const body = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lefine_find", arguments: args, _meta: { "io.modelcontextprotocol/protocolVersion": MCP_VERSION } } };
  let res: Response;
  try {
    res = await fetcher(`${auth.apiUrl}/v1/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${auth.token}`,
        "mcp-protocol-version": MCP_VERSION,
        "mcp-method": "tools/call",
        "mcp-name": "lefine_find",
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new LefineError("NETWORK", err instanceof Error ? err.message : String(err));
  }
  if (res.status === 401) throw new LefineError("UNAUTHORIZED", "invalid key");
  const text = await res.text();
  // A streamed answer carries the JSON-RPC message on its data: line.
  const json = (res.headers.get("content-type") ?? "").includes("event-stream") ? (/^data: (.+)$/m.exec(text)?.[1] ?? "") : text;
  let msg: { result?: { structuredContent?: { items?: FoundAction[] }; isError?: boolean; content?: Array<{ text?: string }> }; error?: { message?: string } };
  try {
    msg = JSON.parse(json);
  } catch {
    throw new LefineError("INTERNAL", `HTTP ${res.status}`);
  }
  if (msg.error) throw new LefineError("INTERNAL", s(msg.error.message ?? "the search failed"));
  if (msg.result?.isError) throw new LefineError("BAD_INPUT", s(msg.result.content?.[0]?.text ?? "the search failed"));
  return msg.result?.structuredContent?.items ?? [];
}

/** "appId*, locale" from an input schema: the fields, required ones marked. */
export function inputFields(schema: FoundAction["inputSchema"]): string {
  const required = new Set(schema.required ?? []);
  const names = Object.keys(schema.properties ?? {});
  return names.length === 0 ? "no input" : names.map((n) => (required.has(n) ? `${n}*` : n)).join(", ");
}

// ── lefine actions [words] ────────────────────────────────────────────

export interface ActionsOptions extends GlobalOptions {
  module?: string;
  limit?: string;
}

export async function actionsCommand(words: string[], options: ActionsOptions, fetcher?: FetchLike): Promise<void> {
  try {
    const limit = options.limit === undefined ? 10 : Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new Error("--limit takes 1 to 10.");
    const query = words.join(" ").trim();
    if (query.length > 100) throw new Error("Search with 100 characters at most.");
    const items = await findActions(authOrFail(options), { ...(query ? { query } : {}), ...(options.module ? { module: options.module } : {}), limit }, fetcher);
    out(options.json, { items }, () => {
      console.log();
      if (items.length === 0) console.log("  Nothing matched. Try other words, or only --module strings|content|studio|social|integrations.");
      for (const a of items) {
        console.log(`  ${cyan(s(a.action))}  ${dim(s(a.module))}${a.asksFirst ? `  ${yellow("asks a person first")}` : ""}`);
        console.log(`    ${s(a.summary)}`);
        console.log(dim(`    input: ${s(inputFields(a.inputSchema))}`));
      }
      console.log(dim(`\n  Run one: lefine run <action> --input '{"appId":"app_..."}'   (* = required)`));
      console.log();
    });
  } catch (err) {
    fail(err, options.json);
  }
}

// ── lefine run <action> ───────────────────────────────────────────────

export interface RunOptions extends GlobalOptions {
  /** JSON, `@file.json`, or `-` for stdin. */
  input?: string;
  approval?: string;
}

const ACTION = /^[a-z][a-z0-9]*(\.[a-zA-Z0-9_-]+){1,5}$/;

/** The input as an object: inline JSON, @file, or - (stdin). */
export function readInput(raw: string | undefined, readStdin: () => string = () => readFileSync(0, "utf-8")): Record<string, unknown> {
  if (raw === undefined || raw.trim() === "") return {};
  const text = raw === "-" ? readStdin() : raw.startsWith("@") ? readFileSync(raw.slice(1), "utf-8") : raw;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error(`--input is not JSON. Give an object, for example --input '{"appId":"app_..."}', or @file.json, or - for stdin.`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("--input must be a JSON object.");
  return value as Record<string, unknown>;
}

interface Approvals {
  openBrowser?: (url: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  approvalWaitMs?: number;
  readStdin?: () => string;
}

export async function runCommand(action: string, options: RunOptions, deps: Approvals = {}): Promise<void> {
  try {
    if (!ACTION.test(action)) throw new Error(`"${s(action)}" is not an action name. Find one with \`lefine actions <words>\`.`);
    const input = readInput(options.input, deps.readStdin);
    const auth = authOrFail(options);
    const ops = createOpClient(auth.apiUrl, auth.token);
    const data = await (options.approval
      ? ops.callOp<unknown>(action, input, { approval: options.approval })
      : callWithApproval<unknown>(ops, action, input, {
          why: "This action asks first",
          openBrowser: deps.openBrowser ?? openInBrowser,
          say: (line: string) => (options.json ? console.error(line) : console.log(line)),
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
          ...(deps.now ? { now: deps.now } : {}),
          ...(deps.approvalWaitMs !== undefined ? { waitMs: deps.approvalWaitMs } : {}),
        })
    ).catch((err: unknown) => {
      if (err instanceof LefineError && err.code === "APPROVAL_PENDING" && err.approval) {
        throw new Error(`Once a person approves ${err.approval.url} , run it again with --approval ${err.approval.id} (same --input).`);
      }
      // Not Strings' "check the app name" hint: here a name is an action, or the thing the input points at.
      if (err instanceof LefineError && err.code === "NOT_FOUND") throw new Error(`Not found: ${s(err.message).replace(/[.\s]+$/, "")}. See what you can run with \`lefine actions <words>\`.`);
      throw err;
    });
    // safeJson: C0, DEL, C1 and bidi controls from the server are \uXXXX escapes, never raw bytes on the terminal.
    out(options.json, { action, data }, () => {
      console.log(`${bold(s(action))}`);
      console.log(safeJson(data, 2));
    });
  } catch (err) {
    fail(err, options.json);
  }
}
