/**
 * Two tools `lefine mcp` adds next to the server's, so a coding agent adds strings the way a careful person
 * would (oss SDK audit, idea C): look for an existing key first, and refuse the mistakes agents make. The
 * reference incident: an agent made 1005 phantom keys by creating in the wrong namespace instead of updating.
 */

import { createOpClient, type OpClient } from "./client.js";
import { icuArgs } from "./icu-args.js";
import type { BridgeAuth } from "./mcp-bridge.js";

interface KeyItem {
  namespace: string;
  key: string;
  translations?: Record<string, { text?: string } | undefined>;
}

export const LOCAL_TOOLS = [
  {
    name: "lefine_find_similar_key",
    description:
      "Find keys of a Lefine app whose name or source text is like the one you want to add. ALWAYS call this before lefine_add_key: " +
      "reuse an existing key instead of adding a duplicate. Give the app id (app_...) and the source text, the key, or both. " +
      "Returns up to 10 keys with their namespace and source text, closest first.",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string", description: "The app id, app_... (lefine.ts in the project has it)." },
        text: { type: "string", description: "The source-language text you want to show." },
        key: { type: "string", description: "The key name you had in mind, e.g. checkout.coupon_applied." },
      },
      required: ["appId"],
    },
  },
  {
    name: "lefine_add_key",
    description:
      "Add ONE new key with its source text to a Lefine app. It refuses, and says why, when: the key already exists in any namespace " +
      "(edit it in Lefine instead); a key with the same source text exists (reuse it, or pass reuse: false after checking); the namespace " +
      "does not exist yet (pass newNamespace: true only if a new namespace is really meant); the text is not valid ICU. " +
      "A new key is not live: a person publishes it. Call lefine_find_similar_key first.",
    inputSchema: {
      type: "object",
      properties: {
        appId: { type: "string", description: "The app id, app_..." },
        namespace: { type: "string", description: "An existing namespace, e.g. checkout. Check with lefine_find_similar_key." },
        key: { type: "string", description: "The key inside the namespace, e.g. coupon_applied (dots make groups)." },
        sourceText: { type: "string", description: "The text in the app's source language. ICU: {name}, {n, plural, one {# item} other {# items}}." },
        description: { type: "string", description: "Where it shows and what it means, for translators." },
        newNamespace: { type: "boolean", description: "true only to create a namespace that does not exist." },
        reuse: { type: "boolean", description: "Default true: refuse when the same text already has a key. false only after you checked it is different." },
      },
      required: ["appId", "namespace", "key", "sourceText"],
    },
  },
] as const;

const norm = (s: string) => s.toLowerCase().replace(/\{[^}]*\}/g, "{}").replace(/[^\p{L}\p{N}{}]+/gu, " ").trim();
const words = (s: string) => new Set(norm(s).split(" ").filter(Boolean));

/** 1 for the same text (case, punctuation and argument names aside), else the share of words in common. */
export function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (norm(a) === norm(b)) return 1;
  const x = words(a);
  const y = words(b);
  const common = [...x].filter((w) => y.has(w)).length;
  return common / Math.max(x.size, y.size, 1);
}

const text = (body: string, isError = false) => ({ content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}) });

async function sourceOf(ops: OpClient, appId: string): Promise<{ sourceLocale: string; namespaces: string[] }> {
  const got = await ops.callOp<{ app: { sourceLocale: string }; namespaces: Array<{ name: string }> }>("strings.app.get", { appId });
  return { sourceLocale: got.app.sourceLocale, namespaces: got.namespaces.map((n) => n.name) };
}

async function search(ops: OpClient, appId: string, locale: string, query: string): Promise<KeyItem[]> {
  if (!query.trim()) return [];
  const page = await ops.callOp<{ items: KeyItem[] }>("strings.keys.list", { appId, locale, search: query.trim().slice(0, 200), limit: 50 });
  return page.items ?? [];
}

/** Keys the server finds for the text, the key, or the text's longer words (it matches substrings, not meaning). */
async function candidates(ops: OpClient, appId: string, locale: string, text: string, key = ""): Promise<KeyItem[]> {
  const pool = new Map<string, KeyItem>();
  const queries = [text, key, ...[...words(text)].filter((w) => w.length > 3).slice(0, 4)];
  for (const q of queries) for (const item of await search(ops, appId, locale, q)) pool.set(`${item.namespace}:${item.key}`, item);
  return [...pool.values()];
}

type Args = Record<string, unknown>;

export async function findSimilar(ops: OpClient, args: Args) {
  const appId = String(args.appId ?? "");
  const want = typeof args.text === "string" ? args.text : "";
  const key = typeof args.key === "string" ? args.key : "";
  if (!want && !key) return text("Give text, key, or both.", true);
  const { sourceLocale } = await sourceOf(ops, appId);
  const scored = (await candidates(ops, appId, sourceLocale, want, key))
    .map((item) => {
      const source = item.translations?.[sourceLocale]?.text ?? "";
      const score = Math.max(similarity(want, source), key ? similarity(key.replace(/[._]/g, " "), item.key.replace(/[._]/g, " ")) : 0);
      return { namespace: item.namespace, key: item.key, sourceText: source, score: Math.round(score * 100) / 100 };
    })
    .filter((s) => s.score > 0.3)
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);
  return text(scored.length === 0 ? "No similar key. A new one is fine." : JSON.stringify(scored, null, 1));
}

export async function addKey(ops: OpClient, args: Args) {
  const appId = String(args.appId ?? "");
  const namespace = String(args.namespace ?? "").trim();
  const key = String(args.key ?? "").trim();
  const sourceText = String(args.sourceText ?? "");
  if (!namespace || !key || !sourceText.trim()) return text("namespace, key and sourceText are needed.", true);
  if (icuArgs(sourceText) === null) return text(`"${sourceText}" is not valid ICU. Check the braces: {name}, {n, plural, one {# x} other {# xs}}.`, true);

  const { sourceLocale, namespaces } = await sourceOf(ops, appId);
  if (!namespaces.includes(namespace) && args.newNamespace !== true) {
    return text(`Namespace "${namespace}" does not exist. Namespaces: ${namespaces.join(", ") || "none"}. Use one of them, or pass newNamespace: true if a new one is meant.`, true);
  }
  const sameKey = (await search(ops, appId, sourceLocale, key)).filter((k) => k.key === key);
  if (sameKey.length > 0) {
    const where = sameKey.map((k) => `${k.namespace}.${k.key}`).join(", ");
    return text(`The key already exists: ${where}. Edit its text in Lefine instead of adding it again.`, true);
  }
  if (args.reuse !== false) {
    const same = (await candidates(ops, appId, sourceLocale, sourceText)).filter((k) => similarity(sourceText, k.translations?.[sourceLocale]?.text ?? "") === 1);
    if (same.length > 0) {
      return text(`This text already has a key: ${same.map((k) => `${k.namespace}.${k.key}`).join(", ")}. Use it in code. If yours means something else, call again with reuse: false.`, true);
    }
  }
  await ops.callOp("strings.keys.create", {
    appId,
    namespace,
    key,
    sourceText,
    ...(typeof args.description === "string" && args.description.trim() ? { description: args.description.trim() } : {}),
  });
  const typed = Object.keys(icuArgs(sourceText) ?? {});
  return text(
    `Added ${namespace}.${key}. It is not live until someone publishes in Lefine. Run \`npx lefine strings types\` so the editor knows it${typed.length ? ` (arguments: ${typed.join(", ")})` : ""}.`,
  );
}

/** A tools/call for one of LOCAL_TOOLS, answered here; null for the server's tools. */
export async function callLocalTool(auth: BridgeAuth, name: string, args: Args) {
  const ops = createOpClient(auth.apiUrl, auth.token);
  try {
    if (name === "lefine_find_similar_key") return await findSimilar(ops, args);
    if (name === "lefine_add_key") return await addKey(ops, args);
    return null;
  } catch (err) {
    return text(`Lefine refused: ${err instanceof Error ? err.message : String(err)}`, true);
  }
}
