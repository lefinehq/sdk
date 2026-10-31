/**
 * Locales and the fallback chain. The chain is the one Lefine uses at publish:
 * the language, its parents (pt-BR -> pt), then the project's fallback language. Only languages that exist appear, never twice.
 */

import { cdnLocale } from "../locale.js";

/** "pt-latn-br" gives "pt-latn", "pt". */
function parents(locale: string): string[] {
  const parts = locale.split("-");
  const out: string[] = [];
  while (parts.length > 1) {
    parts.pop();
    out.push(parts.join("-"));
  }
  return out;
}

/**
 * The languages to read, in order: `locale` first, then its parents, then `fallbackLocale`, each kept only when `available`
 * has it. All lowercase. `fallbackLocale` null or undefined: parents only.
 */
export function localeChain(
  locale: string,
  available: readonly string[],
  fallbackLocale?: string | null,
): string[] {
  const has = new Set(available.map(cdnLocale));
  const first = cdnLocale(locale);
  const chain: string[] = [];
  for (const candidate of [
    first,
    ...parents(first),
    ...(fallbackLocale ? [cdnLocale(fallbackLocale)] : []),
  ]) {
    if (has.has(candidate) && !chain.includes(candidate)) chain.push(candidate);
  }
  return chain;
}
