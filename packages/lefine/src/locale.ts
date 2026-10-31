/** The edge's spelling of a locale: trimmed, lowercase, dashes. `pt_BR`, `pt-BR` and ` PT-br` are one language. */
export function cdnLocale(locale: string): string {
  return locale.trim().replace(/_/g, "-").toLowerCase();
}
