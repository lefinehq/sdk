/**
 * The runtime: walks the IR with the platform Intl APIs (docs/strings-runtime.md §3). This file and
 * `translator.ts` are the client bundle; `size.test.ts` keeps them under 2 KB gzip. It never throws:
 * problems go to `onError` and a readable fallback is printed instead.
 */

import { DATE, NUMBER, ORDINAL, PLURAL, POUND, SELECT, TAG, type Branches, type DateTimeStyle, type Message, type Node, type NumberStyle } from "./ir.js";

/** A tag handler gets its formatted children and returns anything (a React element, a string). */
export type TagHandler<T = unknown> = (chunks: Array<string | T>) => T;
export type Value = string | number | bigint | boolean | Date | null | undefined | TagHandler;
export type Values = Record<string, Value>;

export interface Formats {
  number?: Record<string, Intl.NumberFormatOptions>;
  dateTime?: Record<string, Intl.DateTimeFormatOptions>;
}

export interface FormatError {
  /**
   * INVALID_FORMAT: Intl refused the locale, time zone, currency or unit; the argument prints as `{name}`.
   * MISSING_INTL: the runtime has no Intl.PluralRules (Hermes, React Native): plurals pick `one` for 1, else `other`.
   */
  code: "MISSING_MESSAGE" | "MISSING_VALUE" | "INVALID_VALUE" | "MISSING_FORMAT" | "INVALID_FORMAT" | "MISSING_INTL";
  /** The key, or the argument name. */
  name: string;
}

export interface FormatOptions {
  formats?: Formats;
  /** Used for dates unless the style has its own. Pass the same on server and client. */
  timeZone?: string;
  onError?: (error: FormatError) => void;
}

const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat | Intl.PluralRules>();

/**
 * Creating Intl objects is the slow part; one per locale and options. A locale Intl refuses (`en_US`, a cookie
 * value) falls back to the runtime's; bad options (a currency `EURO`, a time zone typo) still throw, for the
 * caller to report.
 */
function intl<T>(C: new (locale?: string, options?: object) => T, kind: string, locale: string, options?: object): T {
  const id = kind + locale + JSON.stringify(options);
  let hit = cache.get(id) as T | undefined;
  if (!hit) {
    try {
      hit = new C(locale, options);
    } catch {
      hit = new C(undefined, options);
    }
    cache.set(id, hit as never);
  }
  return hit;
}

type Out = Array<string | unknown>;

/**
 * Own entries only. Branches and values can come from JSON (the CDN) or the app, where `branches["constructor"]` or
 * `values["toString"]` would be Object.prototype's function and the walk would throw (the formatter never throws).
 */
const own = <T>(record: Record<string, T>, key: string): T | undefined => (Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined);
/** A branch that is a message, else `other`, else nothing. */
const branch = (branches: Branches, key: string): Message => {
  const hit = own(branches, key);
  if (typeof hit === "string" || Array.isArray(hit)) return hit;
  const other = own(branches, "other");
  return typeof other === "string" || Array.isArray(other) ? other : "";
};

/** Format one compiled message. A string, unless a tag handler returned something else. */
export function format<T = string>(message: Message, locale: string, values: Values = {}, options: FormatOptions = {}): string | T | Array<string | T> {
  if (typeof message === "string") return message;
  return join(walk(message, locale, values, options, undefined)) as string | T | Array<string | T>;
}

/** Adjacent strings into one; a single string unwrapped. */
function join(out: Out): string | Out {
  const list: Out = [];
  for (const item of out) {
    if (typeof item === "string" && typeof list[list.length - 1] === "string") list[list.length - 1] += item;
    else list.push(item);
  }
  return list.length === 0 ? "" : list.length === 1 && typeof list[0] === "string" ? list[0] : list;
}

function walk(nodes: Message, locale: string, values: Values, options: FormatOptions, count: number | undefined): Out {
  if (typeof nodes === "string") return [nodes];
  const out: Out = [];
  for (const node of nodes) out.push(...one(node, locale, values, options, count));
  return out;
}

function one(node: Node, locale: string, values: Values, options: FormatOptions, count: number | undefined): Out {
  if (typeof node === "string") return [node];
  if (node === POUND) return [count === undefined ? "#" : intl(Intl.NumberFormat, "n", locale).format(count)];
  if (!Array.isArray(node)) return [String(node)]; // IR from a newer format: show it, do not crash
  const [name, type] = node;
  try {
    return argument(node, name, type, locale, values, options, count);
  } catch {
    // Intl refused this argument's options: the rest of the message still shows.
    options.onError?.({ code: "INVALID_FORMAT", name });
    return [`{${name}}`];
  }
}

function argument(node: Extract<Node, unknown[]>, name: string, type: Extract<Node, unknown[]>[1], locale: string, values: Values, options: FormatOptions, count: number | undefined): Out {
  const value = own(values, name);
  const problem = (code: FormatError["code"]): Out => {
    options.onError?.({ code, name });
    return [`{${name}}`];
  };
  if (type === TAG) {
    const children = walk(node.slice(2) as Node[], locale, values, options, count);
    // No handler: the text without the tag, never the markup.
    if (typeof value !== "function") {
      if (value === undefined) options.onError?.({ code: "MISSING_VALUE", name });
      return children;
    }
    const inner = join(children);
    return [value(Array.isArray(inner) ? inner : [inner])];
  }
  if (value === undefined || value === null) return problem("MISSING_VALUE");
  if (type === undefined) return [String(value)];
  if (type === SELECT || type === PLURAL || type === ORDINAL) {
    const branches = node[2] as Branches;
    if (type === SELECT) return walk(branch(branches, String(value)), locale, values, options, count);
    const n = Number(value);
    if (Number.isNaN(n)) return problem("INVALID_VALUE");
    // ICU: `=N` matches the value; the category and `#` use the value minus the offset.
    const shown = n - ((node[3] as number | undefined) ?? 0);
    let key: string;
    if (own(branches, `=${n}`) !== undefined) key = `=${n}`;
    else if (typeof Intl.PluralRules === "function") key = intl(Intl.PluralRules, "p", locale, { type: type === ORDINAL ? "ordinal" : "cardinal" }).select(shown);
    else {
      // Hermes (React Native) has no Intl.PluralRules. `one`/`other` is right for 1 and most counts in English-like
      // languages, and a missing `one` falls back to `other`; framework-support.md says how to add the real rules.
      options.onError?.({ code: "MISSING_INTL", name: "Intl.PluralRules" });
      key = type === PLURAL && shown === 1 ? "one" : "other";
    }
    return walk(branch(branches, key), locale, values, options, shown);
  }
  const style = node[2] as NumberStyle | DateTimeStyle | undefined;
  const table = (type === NUMBER ? options.formats?.number : options.formats?.dateTime) ?? {};
  const named = typeof style === "string" ? own<object>(table, style) : style;
  if (typeof style === "string" && !named) options.onError?.({ code: "MISSING_FORMAT", name: style });
  if (type === NUMBER) {
    // API data often brings numbers as strings ("1234"); formatjs formats those too.
    const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    if ((typeof n !== "number" && typeof n !== "bigint") || Number.isNaN(n)) return problem("INVALID_VALUE");
    return [intl(Intl.NumberFormat, "n", locale, named as Intl.NumberFormatOptions | undefined).format(n)];
  }
  const date = value instanceof Date ? value : typeof value === "number" ? new Date(value) : null;
  if (!date || Number.isNaN(date.getTime())) return problem("INVALID_VALUE");
  const base = (named as Intl.DateTimeFormatOptions | undefined) ?? (type === DATE ? {} : { hour: "numeric", minute: "numeric" });
  return [intl(Intl.DateTimeFormat, "d", locale, { timeZone: options.timeZone, ...base }).format(date)];
}
