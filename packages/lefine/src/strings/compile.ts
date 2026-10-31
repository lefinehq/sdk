/**
 * ICU text -> IR (docs/strings-runtime.md §2). Server and build only (`lefine/compile`): this entry holds the
 * parser (`parser.ts`, ours, no dependency); the client entry never imports it.
 */

import type { Message, MessageTree } from "./ir.js";
import { parseMessage, put } from "./parser.js";

/** One ICU text to IR. Throws on text that is not valid ICU. */
export function compile(text: string): Message {
  return parseMessage(text);
}

export interface CompileError {
  /** "namespace.dotted.key" */
  key: string;
  message: string;
}

/**
 * A whole `{ namespace: { key: text } }` tree. A text that does not compile is kept as a plain string (shown as
 * written, never a crash) and reported, so one bad translation cannot take a page down.
 */
export function compileMessages(tree: unknown, onError?: (error: CompileError) => void): MessageTree {
  const walk = (node: unknown, path: string): MessageTree => {
    const out: MessageTree = {};
    if (!node || typeof node !== "object" || Array.isArray(node)) return out;
    for (const [name, value] of Object.entries(node)) {
      const key = path ? `${path}.${name}` : name;
      if (typeof value === "string") {
        try {
          put(out, name, compile(value));
        } catch (err) {
          put(out, name, value);
          onError?.({ key, message: err instanceof Error ? err.message : String(err) });
        }
      } else if (value && typeof value === "object" && !Array.isArray(value)) {
        put(out, name, walk(value, key));
      }
    }
    return out;
  };
  return walk(tree, "");
}
