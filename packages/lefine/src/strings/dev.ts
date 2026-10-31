import type { FormatError } from "./format.js";

const seen = new Set<string>();

/**
 * The default onError outside production: one console line per missing key, value or format, with what to do.
 * In production it is undefined (and a bundler drops this), so nothing is logged unless the app asks.
 */
export function devOnError(locale: string): ((error: FormatError) => void) | undefined {
  if (process.env.NODE_ENV === "production") return undefined;
  return (error) => {
    const id = `${locale}|${error.code}|${error.name}`;
    if (seen.has(id)) return;
    seen.add(id);
    const what: Record<FormatError["code"], string> = {
      MISSING_MESSAGE: `no text for "${error.name}" in ${locale}. Add the key in Lefine (or lefine strings push); on the client, also name its namespace in <lefine.Provider namespaces>.`,
      MISSING_VALUE: `"${error.name}" was not passed to t(). Pass it in the values.`,
      INVALID_VALUE: `"${error.name}" has a value its format cannot use (a number or a date?).`,
      MISSING_FORMAT: `no format named "${error.name}". Add it to createLefine({ formats }).`,
      INVALID_FORMAT: `Intl refused the options for "${error.name}" (locale, time zone, currency or unit).`,
      MISSING_INTL: `this runtime has no ${error.name} (Hermes on React Native), so plurals use one/other only. Add @formatjs/intl-pluralrules (docs/framework-support.md).`,
    };
    console.warn(`lefine: ${what[error.code]}`);
  };
}
