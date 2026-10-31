/**
 * Text from the server, from translators or from files is printed to a
 * terminal, where ESC, C0 and C1 control characters can rewrite the screen
 * (clear lines, fake a "published" line). Everything not typed by the CLI
 * itself goes through `safeText` first, and JSON through `safeJson`.
 */

// Tab stays. Newline, carriage return, other C0, DEL and C1 become visible escapes,
// so a multi-line text cannot fake extra lines either. Bidi overrides and line
// separators reorder or break lines, so they are shown as escapes too.
// eslint-disable-next-line no-control-regex -- matching control characters is what this does
const UNSAFE = new RegExp("[\\x00-\\x08\\x0a-\\x1f\\x7f-\\x9f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]", "g");

export function safeText(value: unknown): string {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.replace(UNSAFE, (ch) => {
    const code = ch.codePointAt(0)!;
    return code <= 0xff ? `\\x${code.toString(16).padStart(2, "0")}` : `\\u${code.toString(16).padStart(4, "0")}`;
  });
}

// JSON.stringify escapes C0 (\x00-\x1f) but not DEL, C1 or bidi controls: a C1 CSI (\x9b) can still drive a terminal.
const UNSAFE_IN_JSON = new RegExp("[\\x7f-\\x9f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]", "g");

/** JSON.stringify, then DEL, C1 and bidi controls as \\uXXXX: still valid JSON that parses to the same value. */
export function safeJson(value: unknown, indent?: number): string {
  return JSON.stringify(value, null, indent).replace(UNSAFE_IN_JSON, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, "0")}`);
}
