/** The shape every local tool answers with, and what it needs to run. */

import type { OpClient } from "./client.js";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

/** What the server answered to a write sent through its own MCP tool (lefine_write). */
export interface ServerWrite {
  /** True only when the server did the write. */
  ok: boolean;
  /** The server wants a person to approve first: nothing was written. `text` says where. */
  needsApproval: boolean;
  /** The server's own words (its text result), or why it could not be asked. */
  text: string;
  /** The action's output, when the server sent it as data. */
  data?: unknown;
}

export interface LocalCtx {
  /** READS only (list, preview). Every write goes through `write`: this file never calls a write action on /v1/ops. */
  ops: OpClient;
  /** A write through the remote MCP (tools/call lefine_write), so the server's approvals, ledger and read ceiling apply. */
  write: (action: string, input: unknown) => Promise<ServerWrite>;
  /** The folder the server was started in: relative paths mean relative to it. */
  cwd: string;
  /** Real paths files may be read from (mcp-paths.ts allowedRoots). */
  roots: string[];
}

export type ToolArgs = Record<string, unknown>;

export const okResult = (text: string, structured?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text }],
  ...(structured ? { structuredContent: structured } : {}),
});

export const errResult = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** A string argument, trimmed, or undefined when it is missing or not a string. */
export const strArg = (args: ToolArgs, name: string): string | undefined => {
  const v = args[name];
  return typeof v === "string" && v.trim() ? v.trim() : undefined;
};

/** Markdown table cell: no pipes, no line breaks. */
export const cell = (v: unknown): string => String(v ?? "").replace(/[|\r\n]+/g, " ").slice(0, 120);
