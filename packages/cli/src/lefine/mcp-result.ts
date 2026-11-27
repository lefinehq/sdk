/** The shape every local tool answers with, and what it needs to run. */

import type { OpClient } from "./client.js";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface LocalCtx {
  ops: OpClient;
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
