// t.rich for React, on the server and in the browser: every element in a returned list, and in the chunks a
// tag handler gets (nested tags), carries a key, so React does not warn.
import { Fragment, createElement, isValidElement } from "react";
import type { Translator } from "../strings/translator.js";

const keyList = (list: unknown): unknown =>
  Array.isArray(list) ? list.map((part, i) => (isValidElement(part) ? createElement(Fragment, { key: i }, part) : part)) : list;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function keyed<T extends Translator<any, any>>(t: T): T {
  const rich = t.rich;
  t.rich = ((key: string, values?: Record<string, unknown>) => {
    const wrapped: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(values ?? {})) {
      wrapped[name] = typeof value === "function" ? (chunks: unknown[]) => (value as (c: unknown) => unknown)(keyList(chunks)) : value;
    }
    return keyList(rich(key, wrapped as never));
  }) as T["rich"];
  return t;
}
