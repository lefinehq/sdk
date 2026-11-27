/**
 * Flags and tool filtering of the Lefine MCP server (`npx @lefine/mcp`, `lefine mcp`).
 *
 *   --read-only            hide every tool that writes, publishes or launches; the server is also asked for a
 *                          read ceiling (?level=read), so a tool this file misses still cannot write
 *   --toolsets=a,b         only these modules: remote actions of other modules are refused, local tools of
 *                          other modules are hidden (github-mcp-server's --toolsets, same idea)
 *   --allow-dir <dir>      a folder besides the working folder that local tools may read (repeatable)
 *   --tools-ttl <seconds>  how long the server's tool list is kept (default 300)
 *
 * Each also has an environment variable, for configs that cannot pass arguments.
 * Fail closed: a tool this file does not know is hidden under --read-only or --toolsets.
 */

import { delimiter } from "node:path";

/** The module a tool or action belongs to is the part of an action's name before the first dot. */
export const TOOLSETS = ["strings", "content", "studio", "social", "sites", "brain", "integrations"] as const;
export type Toolset = (typeof TOOLSETS)[number];

export interface McpOptions {
  readOnly: boolean;
  /** Null: every module. */
  toolsets: ReadonlySet<string> | null;
  allowDirs: string[];
  toolsTtlMs: number;
}

export const DEFAULT_OPTIONS: McpOptions = { readOnly: false, toolsets: null, allowDirs: [], toolsTtlMs: 300_000 };

export interface RawMcpOptions {
  readOnly?: boolean;
  readonly?: boolean;
  toolsets?: string | string[];
  allowDir?: string | string[];
  toolsTtl?: string | number;
}

const truthy = (v: string | undefined) => v !== undefined && /^(1|true|yes|on)$/i.test(v.trim());

/** Flags over environment over defaults. Throws an Error with a sentence for a value that cannot be used. */
export function resolveMcpOptions(raw: RawMcpOptions = {}, env: Record<string, string | undefined> = process.env): McpOptions {
  const readOnly = raw.readOnly === true || raw.readonly === true || truthy(env.LEFINE_MCP_READ_ONLY);

  const toolsetText = raw.toolsets !== undefined ? [raw.toolsets].flat().join(",") : (env.LEFINE_MCP_TOOLSETS ?? "");
  const names = toolsetText.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  const unknown = names.filter((n) => !(TOOLSETS as readonly string[]).includes(n));
  if (unknown.length > 0) throw new Error(`Unknown toolset ${unknown.join(", ")}. Toolsets: ${TOOLSETS.join(", ")}.`);

  const allow = raw.allowDir !== undefined ? [raw.allowDir].flat() : (env.LEFINE_MCP_ALLOW_DIRS ?? "").split(delimiter).filter(Boolean);

  let toolsTtlMs = DEFAULT_OPTIONS.toolsTtlMs;
  const ttl = raw.toolsTtl ?? env.LEFINE_MCP_TOOLS_TTL;
  if (ttl !== undefined && ttl !== "") {
    const seconds = Number(ttl);
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > 86_400) throw new Error("--tools-ttl is a number of seconds from 0 to 86400.");
    toolsTtlMs = Math.round(seconds * 1000);
  }
  return { readOnly, toolsets: names.length > 0 ? new Set(names) : null, allowDirs: allow, toolsTtlMs };
}

export interface ToolMeta {
  name: string;
  annotations?: { readOnlyHint?: boolean } & Record<string, unknown>;
}

/** Remote tools that only read, by name. Anything else is a read tool only if the server says readOnlyHint. */
const REMOTE_READ_TOOLS = new Set(["lefine_context", "lefine_find", "lefine_lookup", "lefine_read", "lefine_launch_status"]);
/** Remote tools that take an action name (or steps of them) and so can be held to a toolset. */
const ACTION_TOOLS = new Set(["lefine_read", "lefine_write", "lefine_publish"]);
/** Tools that look across modules without writing: kept under --toolsets. */
const ALWAYS_TOOLS = new Set(["lefine_context", "lefine_find", "lefine_lookup", "lefine_read", "lefine_write", "lefine_publish"]);

/** Is a tool the server lists shown to the model? */
export function remoteToolVisible(tool: ToolMeta, options: McpOptions): boolean {
  if (options.readOnly && !(REMOTE_READ_TOOLS.has(tool.name) || tool.annotations?.readOnlyHint === true)) return false;
  if (options.toolsets) {
    if (ALWAYS_TOOLS.has(tool.name)) return true;
    // A page or key edit is Content or Strings work. Launch spans modules; unknown tools are not guessed.
    return tool.name === "lefine_edit" && (options.toolsets.has("content") || options.toolsets.has("strings"));
  }
  return true;
}

/** The sentence to refuse a tools/call with, or null when it may go to the server. */
export function guardRemoteCall(name: string, args: Record<string, unknown>, tool: ToolMeta | undefined, options: McpOptions): string | null {
  const known = tool ?? { name };
  if (!remoteToolVisible(known, options)) {
    return options.readOnly ? `${name} is turned off: this server runs with --read-only.` : `${name} is turned off by --toolsets (${[...(options.toolsets ?? [])].join(", ")}).`;
  }
  if (options.toolsets && ACTION_TOOLS.has(name)) {
    const steps = Array.isArray(args.steps) ? args.steps : [];
    const actions = [args.action, ...steps.map((s) => (s as { action?: unknown } | null)?.action)];
    for (const a of actions) {
      if (typeof a !== "string") continue;
      const module = a.split(".")[0]!;
      if (!options.toolsets.has(module)) return `${a} is in the ${module} toolset, which is off (--toolsets ${[...options.toolsets].join(",")}).`;
    }
  }
  return null;
}

export const MCP_ABOUT = `It passes the Lefine tools through from https://dash.lefine.ai/v1/mcp with your key, and adds tools that
need your disk: lefine_upload_file, lefine_upload_folder, lefine_import_locale_files, lefine_project,
lefine_find_similar_key, lefine_add_key. Local tools read only the folder this server runs in (and --allow-dir).

Sign in:      npx @lefine/mcp setup     (or npx lefine login, or set LEFINE_TOKEN)
Environment:  LEFINE_TOKEN, LEFINE_API_URL, LEFINE_PROFILE, LEFINE_MCP_READ_ONLY=1, LEFINE_MCP_TOOLSETS,
              LEFINE_MCP_ALLOW_DIRS (folders separated by "${delimiter}"), LEFINE_MCP_TOOLS_TTL
Logs go to stderr; stdout carries only MCP messages.`;
