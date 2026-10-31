/**
 * `t(key, values)` over a compiled tree, for one locale and namespace. Client-safe (no parser).
 * Keys and arguments are typed when the app registers its messages; `lefine strings types` writes this:
 *
 *   declare module "lefine/strings" { interface StringsConfig { Messages: LefineMessages; Args: LefineArgs } }
 *
 * `Args` maps "namespace.key" to its ICU arguments (`{ count: number }`); a key with arguments needs them.
 */

import { format, type FormatOptions, type TagHandler, type Values } from "./format.js";
import type { Message, MessageTree } from "./ir.js";

/** Filled in by the app (see above); empty means any string is a key. */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface StringsConfig {}

export type AppMessages = StringsConfig extends { Messages: infer M } ? M : Record<string, unknown>;
type AppArgs = StringsConfig extends { Args: infer A } ? A : object;

/** "a" | "a.b" for every leaf under T. */
type Leaves<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? `${P}${K}` : Leaves<T[K], `${P}${K}.`>;
}[keyof T & string];
type Groups<T, P extends string = ""> = {
  [K in keyof T & string]: T[K] extends string ? never : `${P}${K}` | Groups<T[K], `${P}${K}.`>;
}[keyof T & string];
type At<T, P extends string> = P extends `${infer H}.${infer R}` ? (H extends keyof T ? At<T[H], R> : never) : P extends keyof T ? T[P] : never;

/** Namespaces (and nested groups) of the app's messages. */
export type Namespace = Record<string, unknown> extends AppMessages ? string : Groups<AppMessages>;
/** Keys under a namespace (all keys with no namespace). */
export type KeyOf<N extends string | undefined> = Record<string, unknown> extends AppMessages
  ? string
  : N extends string
    ? Leaves<At<AppMessages, N>>
    : Leaves<AppMessages>;

type Full<N extends string | undefined, K extends string> = N extends string ? `${N}.${K}` : K;
type ArgsOf<P extends string> = P extends keyof AppArgs ? AppArgs[P] : never;
/** A key with arguments needs them; one without takes none (or any, when nothing is registered). */
type Rest<P extends string, Extra> = [ArgsOf<P>] extends [never] ? [values?: Values & Extra] : [values: ArgsOf<P> & Values & Extra];

export interface Translator<K extends string = string, N extends string | undefined = undefined> {
  /** The text as a string; tags without a handler print their content. */
  <Key extends K>(key: Key, ...values: Rest<Full<N, Key>, unknown>): string;
  /** With tag handlers (`{ b: (chunks) => <b>{chunks}</b> }`): a string or an array of strings and elements. */
  rich<T, Key extends K = K>(key: Key, ...values: Rest<Full<N, Key>, Record<string, TagHandler<T> | Values[string]>>): string | T | Array<string | T>;
  has(key: K): boolean;
}

export interface TranslatorConfig extends FormatOptions {
  locale: string;
  messages: MessageTree;
  namespace?: string;
}

function lookup(tree: MessageTree, path: string): Message | undefined {
  let node: unknown = tree;
  for (const part of path.split(".")) {
    if (!node || typeof node !== "object" || Array.isArray(node)) return undefined;
    node = (node as MessageTree)[part];
  }
  return typeof node === "string" || Array.isArray(node) ? (node as Message) : undefined;
}

export function createTranslator<N extends Namespace | undefined = undefined>(config: TranslatorConfig & { namespace?: N }): Translator<KeyOf<N>, N> {
  const { locale, messages, namespace, ...options } = config;
  const full = (key: string) => (namespace ? `${namespace}.${key}` : key);
  const run = (key: string, values?: Values) => {
    const message = lookup(messages, full(key));
    if (message === undefined) {
      options.onError?.({ code: "MISSING_MESSAGE", name: full(key) });
      return full(key);
    }
    return format(message, locale, values, options);
  };
  const t = ((key: string, values?: Values) => {
    const out = run(key, values);
    return typeof out === "string" ? out : (out as unknown[]).filter((x) => typeof x === "string").join("");
  }) as Translator<KeyOf<N>, N>;
  t.rich = run as Translator<KeyOf<N>, N>["rich"];
  t.has = (key) => lookup(messages, full(key)) !== undefined;
  return t;
}
