"use client";
import { m } from "@/paraglide/messages";
import type { Locale } from "@/paraglide/runtime";
import keys from "./keys.json";
import { VALUES } from "./values";

// Paraglide's guide: pass the route locale to every message function.
const messages = m as unknown as Record<string, (inputs: object, options: { locale: Locale }) => string>;

export function Texts({ locale }: { locale: Locale }) {
  return <main>{keys.map((k) => <p key={k}>{messages[k]!(VALUES, { locale })}</p>)}</main>;
}
