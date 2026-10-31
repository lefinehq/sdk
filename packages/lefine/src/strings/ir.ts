/**
 * The compiled form of an ICU message (docs/strings-runtime.md §2). Plain JSON, so it crosses the
 * React Server Component bridge and can be served from the CDN. Same family as next-intl's
 * icu-minify (MIT), with our own ids and an explicit id for tags.
 */

export const POUND = 0;
export const SELECT = 1;
export const PLURAL = 2;
export const ORDINAL = 3;
export const NUMBER = 4;
export const DATE = 5;
export const TIME = 6;
export const TAG = 7;

/** A format name from `formats`, or the Intl options themselves. */
export type NumberStyle = string | Intl.NumberFormatOptions;
export type DateTimeStyle = string | Intl.DateTimeFormatOptions;

export type Branches = { [key: string]: Message };

export type Node =
  | string
  | typeof POUND
  | [name: string]
  | [name: string, type: typeof SELECT | typeof PLURAL | typeof ORDINAL, branches: Branches, offset?: number]
  | [name: string, type: typeof NUMBER, style?: NumberStyle]
  | [name: string, type: typeof DATE | typeof TIME, style?: DateTimeStyle]
  | TagNode;

/**
 * `[name, TAG, ...children]`. An interface, not a variadic tuple (`[string, typeof TAG, ...Node[]]`): TanStack
 * Start checks a server function's result type, and on that tuple its check recursed until TypeScript gave up
 * ("Type instantiation is excessively deep", TS2589) on a fresh app's `strings().load(...)` (2026-10-28).
 */
export interface TagNode extends Array<Node | typeof TAG> {
  0: string;
  1: typeof TAG;
}

/** A plain text stays a string; anything with an argument is a list of nodes. */
export type Message = string | Node[];

/** `{ namespace: { key: message } }`, dotted keys nested, as the CDN serves texts. */
export interface MessageTree {
  [name: string]: Message | MessageTree;
}

/** Version of the shapes above, written into a compiled file. A reader uses only formats it knows. */
export const IR_FORMAT = 1;

/**
 * `v/{version}/{locale}/messages.ir.json` on the Lefine edge, written at publish next to translations.json
 * `sha256` is the translations.json it was compiled from.
 */
export interface IrFile {
  format: typeof IR_FORMAT;
  sha256: string;
  messages: MessageTree;
}
