"use client";
// What useStrings (and lefine/next's Link) read: compiled messages, their formatting, and in Next the routing.

import { createContext, useContext, useEffect, type ReactNode } from "react";
import { startDevOverlay } from "./dev-overlay.js";
import { type LiveStrings, watchPublishes } from "./dev-toast.js";
import type { Formats } from "../strings/format.js";
import type { MessageTree } from "../strings/ir.js";
import type { Routing } from "../next/routing.js";

export interface LefineContext {
  locale: string;
  messages: MessageTree;
  /** Set by lefine.Provider in Next, for Link. */
  routing?: Routing;
  timeZone: string;
  formats?: Formats;
  /** Development only: where the app's manifest is and the revision rendered, for the "strings updated" toast. */
  live?: LiveStrings;
}

const Context = createContext<LefineContext | null>(null);

export function StringsProvider({ children, ...value }: LefineContext & { children?: ReactNode }) {
  // Development only (a production build drops it): badges on texts with a problem.
  if (process.env.NODE_ENV !== "production") {
    useEffect(startDevOverlay, []);
    // "N strings updated in Lefine · Reload" when a publish lands while you work (dev-toast.ts).
    useEffect(() => watchPublishes(value.live, value.locale), [value.live?.base, value.live?.revision, value.locale]);
  }
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useLefine(): LefineContext {
  const value = useContext(Context);
  if (!value) throw new Error("lefine: put <StringsProvider> (or <lefine.Provider> in Next) above this component.");
  return value;
}
