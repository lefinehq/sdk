/**
 * Our ICU MessageFormat parser: text -> IR directly (docs/strings-runtime.md §2), no AST, no dependency.
 *
 * The grammar follows ICU 4.8+ as @formatjs/icu-messageformat-parser (MIT) reads it, because that is what
 * next-intl, react-intl and every TMS file our customers have was written against:
 *
 *  - An apostrophe quotes only before a character that needs it: `{` `}` `<` `>`, and `#` inside a plural.
 *    `''` is one apostrophe, inside or outside a quote. A quote runs to the next lone apostrophe.
 *  - `#` is the number only directly inside a plural / selectordinal branch (a tag passes it through, a nested
 *    select does not).
 *  - A tag is `<name>...</name>`, name starting with a letter. `<name/>` and a `<` that starts no name are text.
 *  - Argument and selector names run to the next space or ICU syntax character.
 *  - Plural / select need an `other` branch. A plural `offset:N` is kept as a fourth item: `[name, 2, branches, N]`.
 *  - Number skeletons (`::currency/EUR .00`) and date skeletons (`::yMMMd`) become Intl options here, with the
 *    stems formatjs supports minus `scale`, which Intl cannot express.
 *
 * `__tests__/parser.test.ts` checks this against formatjs on the landing corpus and the edge cases above.
 */

import { DATE, NUMBER, ORDINAL, PLURAL, POUND, SELECT, TAG, TIME, type Branches, type Message, type Node } from "./ir.js";

export class ParseError extends Error {
  readonly offset: number;
  // Plain fields, no parameter properties: lefine's apps/web type-checks a copy with erasableSyntaxOnly.
  constructor(message: string, offset: number) {
    super(`${message} at ${offset}`);
    this.offset = offset;
    this.name = "ParseError";
  }
}

/** ICU's named styles, as intl-messageformat resolves them (so output matches next-intl's). */
const NUMBER_STYLES: Record<string, Intl.NumberFormatOptions> = {
  integer: { maximumFractionDigits: 0 },
  percent: { style: "percent" },
};
const DATE_STYLES: Record<string, Intl.DateTimeFormatOptions> = {
  short: { month: "numeric", day: "numeric", year: "2-digit" },
  medium: { month: "short", day: "numeric", year: "numeric" },
  long: { month: "long", day: "numeric", year: "numeric" },
  full: { weekday: "long", month: "long", day: "numeric", year: "numeric" },
};
const TIME_STYLES: Record<string, Intl.DateTimeFormatOptions> = {
  short: { hour: "numeric", minute: "numeric" },
  medium: { hour: "numeric", minute: "numeric", second: "numeric" },
  long: { hour: "numeric", minute: "numeric", second: "numeric", timeZoneName: "short" },
  full: { hour: "numeric", minute: "numeric", second: "numeric", timeZoneName: "short" },
};

// formatjs' _isWhiteSpace: Pattern_White_Space, not every Unicode space (a no-break space is text).
const SPACE = /[\t-\r \u0085\u200e\u200f\u2028\u2029]/;
/** White_Space and Pattern_Syntax end a name (formatjs' identifier rule). */
const NAME_END = /[\p{White_Space}\p{Pattern_Syntax}]/u;
const TAG_START = /[A-Za-z]/;
// Custom-element name characters (formatjs' _isPotentialElementNameChar).
const TAG_CHAR = /[-.0-9_a-zA-Z\u00b7\u00c0-\u00d6\u00d8-\u00f6\u00f8-\u037d\u037f-\u1fff\u200c-\u200d\u203f\u2040\u2070-\u218f\u2c00-\u2fef\u3001-\ud7ff\uf900-\ufdcf\ufdf0-\ufffd]/;

type Parent = "" | "plural" | "selectordinal" | "select";

class Parser {
  private i = 0;
  private readonly s: string;
  constructor(s: string) {
    this.s = s;
  }

  run(): Node[] {
    const out = this.message(0, "", false);
    if (this.i < this.s.length) this.fail("unexpected }");
    return out;
  }

  private fail(message: string): never {
    throw new ParseError(message, this.i);
  }
  private ch(at = this.i): string {
    return this.s[at] ?? "";
  }
  private spaces(): void {
    while (this.i < this.s.length && SPACE.test(this.ch())) this.i++;
  }
  private eat(text: string): boolean {
    if (!this.s.startsWith(text, this.i)) return false;
    this.i += text.length;
    return true;
  }
  private name(): string {
    const start = this.i;
    while (this.i < this.s.length) {
      const cp = this.s.codePointAt(this.i)!;
      const c = String.fromCodePoint(cp);
      if (NAME_END.test(c)) break;
      this.i += c.length;
    }
    return this.s.slice(start, this.i);
  }

  private message(depth: number, parent: Parent, inTag: boolean): Node[] {
    const out: Node[] = [];
    const push = (node: Node) => {
      if (typeof node === "string" && typeof out[out.length - 1] === "string") out[out.length - 1] += node;
      else out.push(node);
    };
    const counting = parent === "plural" || parent === "selectordinal";
    while (this.i < this.s.length) {
      const c = this.ch();
      if (c === "{") push(this.argument(depth));
      else if (c === "}" && depth > 0) break;
      else if (c === "#" && counting) {
        this.i++;
        push(POUND);
      } else if (c === "<" && this.ch(this.i + 1) === "/") {
        if (inTag) break;
        this.fail("closing tag without an opening tag");
      } else if (c === "<" && TAG_START.test(this.ch(this.i + 1))) push(this.tag(depth, parent));
      else push(this.literal(depth, parent));
    }
    return out;
  }

  private literal(depth: number, parent: Parent): string {
    const counting = parent === "plural" || parent === "selectordinal";
    let text = "";
    while (this.i < this.s.length) {
      const c = this.ch();
      if (c === "'") {
        const next = this.ch(this.i + 1);
        if (next === "'") {
          text += "'";
          this.i += 2;
          continue;
        }
        if (next === "{" || next === "}" || next === "<" || next === ">" || (next === "#" && counting)) {
          // A quote: up to the next lone apostrophe, '' inside is one.
          this.i += 2;
          text += next;
          while (this.i < this.s.length) {
            if (this.ch() === "'") {
              if (this.ch(this.i + 1) === "'") {
                text += "'";
                this.i += 2;
                continue;
              }
              this.i++;
              break;
            }
            text += this.ch();
            this.i++;
          }
          continue;
        }
        text += "'";
        this.i++;
        continue;
      }
      if (c === "{" || (c === "#" && counting) || (c === "}" && depth > 0)) break;
      if (c === "<") {
        const next = this.ch(this.i + 1);
        if (next === "/" || TAG_START.test(next)) break;
        text += "<";
        this.i++;
        continue;
      }
      text += c;
      this.i++;
    }
    return text;
  }

  private tag(depth: number, parent: Parent): Node {
    this.i++; // <
    const start = this.i;
    this.i++;
    while (this.i < this.s.length && TAG_CHAR.test(this.ch())) this.i++;
    const name = this.s.slice(start, this.i);
    this.spaces();
    if (this.eat("/>")) return `<${name}/>`;
    if (!this.eat(">")) this.fail(`invalid tag <${name}`);
    const children = this.message(depth + 1, parent, true);
    if (!this.eat("</")) this.fail(`unclosed tag <${name}>`);
    const closeStart = this.i;
    if (!TAG_START.test(this.ch())) this.fail("invalid closing tag");
    this.i++;
    while (this.i < this.s.length && TAG_CHAR.test(this.ch())) this.i++;
    if (this.s.slice(closeStart, this.i) !== name) this.fail(`</${this.s.slice(closeStart, this.i)}> does not close <${name}>`);
    this.spaces();
    if (!this.eat(">")) this.fail("invalid closing tag");
    return [name, TAG, ...children] as Node;
  }

  private close(): void {
    if (this.ch() !== "}") this.fail("expected }");
    this.i++;
  }

  private argument(depth: number): Node {
    this.i++; // {
    this.spaces();
    if (this.ch() === "}") this.fail("empty argument");
    const name = this.name();
    if (!name) this.fail("argument without a name");
    this.spaces();
    if (this.ch() === "}") {
      this.i++;
      return [name];
    }
    if (!this.eat(",")) this.fail("expected , or }");
    this.spaces();
    const type = this.name();
    this.spaces();
    switch (type) {
      case "number":
      case "date":
      case "time": {
        let style: string | undefined;
        if (this.eat(",")) {
          this.spaces();
          style = this.styleText().trimEnd();
          if (style === "") this.fail("empty style");
        }
        this.close();
        const id = type === "number" ? NUMBER : type === "date" ? DATE : TIME;
        if (style === undefined) return [name, id] as Node;
        if (style.startsWith("::")) {
          const skeleton = style.slice(2).trimStart();
          const options = id === NUMBER ? numberSkeleton(skeleton) : dateSkeleton(skeleton);
          return Object.keys(options).length > 0 ? ([name, id, options] as Node) : ([name, id] as Node);
        }
        const named = id === NUMBER ? NUMBER_STYLES[style] : id === DATE ? DATE_STYLES[style] : TIME_STYLES[style];
        return [name, id, named ?? style] as Node;
      }
      case "plural":
      case "selectordinal":
      case "select": {
        if (!this.eat(",")) this.fail(`expected , after ${type}`);
        this.spaces();
        let offset = 0;
        if (type !== "select" && this.eat("offset:")) {
          this.spaces();
          const start = this.i;
          while (/[0-9]/.test(this.ch())) this.i++;
          if (this.i === start) this.fail("expected a number after offset:");
          offset = Number(this.s.slice(start, this.i));
          this.spaces();
        }
        const branches = this.branches(depth, type);
        this.close();
        const id = type === "select" ? SELECT : type === "plural" ? PLURAL : ORDINAL;
        return (offset ? [name, id, branches, offset] : [name, id, branches]) as Node;
      }
      default:
        this.fail(type ? `unknown argument type "${type}"` : "expected an argument type");
    }
  }

  /** Style text up to the argument's closing brace; braces nest, a quote is kept as written. */
  private styleText(): string {
    const start = this.i;
    let nested = 0;
    while (this.i < this.s.length) {
      const c = this.ch();
      if (c === "'") {
        const end = this.s.indexOf("'", this.i + 1);
        if (end === -1) this.fail("unclosed quote in a style");
        this.i = end + 1;
      } else if (c === "{") {
        nested++;
        this.i++;
      } else if (c === "}") {
        if (nested === 0) break;
        nested--;
        this.i++;
      } else this.i++;
    }
    return this.s.slice(start, this.i);
  }

  private branches(depth: number, parent: Exclude<Parent, "">): Branches {
    const out: Branches = {};
    let other = false;
    let count = 0;
    for (;;) {
      let key: string;
      if (parent !== "select" && this.ch() === "=") {
        const start = this.i;
        this.i++;
        if (this.ch() === "+" || this.ch() === "-") this.i++;
        const digits = this.i;
        while (/[0-9]/.test(this.ch())) this.i++;
        if (this.i === digits) this.fail("expected a number after =");
        key = `=${Number(this.s.slice(start + 1, this.i))}`;
      } else {
        key = this.name();
        if (!key) break;
      }
      if (Object.prototype.hasOwnProperty.call(out, key)) this.fail(`duplicate branch "${key}"`);
      if (key === "other") other = true;
      this.spaces();
      if (!this.eat("{")) this.fail(`expected { after "${key}"`);
      const nodes = this.message(depth + 1, parent, false);
      this.close();
      put(out, key, toMessage(nodes));
      count++;
      this.spaces();
    }
    if (count === 0) this.fail(`${parent} without branches`);
    if (!other) this.fail(`${parent} without an "other" branch`);
    return out;
  }
}

/**
 * Sets an own key on a plain object. Plain, not `Object.create(null)`: React Flight refuses null prototypes, and
 * these trees are props of a Client Component. defineProperty, so a key named `__proto__` stays a key.
 */
export function put<T>(target: Record<string, T>, key: string, value: T): void {
  Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

export const toMessage = (list: Node[]): Message => (list.length === 0 ? "" : list.length === 1 && typeof list[0] === "string" ? list[0] : list);

/** ICU text -> IR. Throws ParseError on text that is not valid ICU. */
export function parseMessage(text: string): Message {
  return toMessage(new Parser(text).run());
}

// \u2500\u2500 skeletons \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

const DATE_FIELD = /(?:[Eec]{1,6}|G{1,5}|[Qq]{1,5}|(?:[yYur]+|U{1,5})|[ML]{1,5}|d{1,2}|D{1,3}|F{1}|[abB]{1,5}|[hkHK]{1,2}|w{1,2}|W{1}|m{1,2}|s{1,2}|[zZOvVxX]{1,4})(?=([^']*'[^']*')*[^']*$)/g;

export function dateSkeleton(skeleton: string): Intl.DateTimeFormatOptions {
  if (!skeleton) throw new ParseError("empty date skeleton", 0);
  // A letter no field takes (j, J, C, ...) would be dropped and print the wrong thing ("23" for ::jm): refuse it.
  const unknown = skeleton.replace(/'[^']*'/g, "").replace(DATE_FIELD, "").match(/[A-Za-z]/);
  if (unknown) throw new ParseError(`date skeleton field "${unknown[0]}" is not supported`, 0);
  const o: Record<string, unknown> = {};
  const two = ["numeric", "2-digit"];
  for (const [field] of skeleton.matchAll(DATE_FIELD)) {
    const n = field.length;
    switch (field[0]) {
      case "G":
        o.era = n === 4 ? "long" : n === 5 ? "narrow" : "short";
        break;
      case "y":
        o.year = n === 2 ? "2-digit" : "numeric";
        break;
      case "M":
      case "L":
        o.month = ["numeric", "2-digit", "short", "long", "narrow"][n - 1];
        break;
      case "d":
        o.day = two[n - 1];
        break;
      case "E":
        o.weekday = n === 4 ? "long" : n === 5 ? "narrow" : "short";
        break;
      case "e":
      case "c":
        if (n < 4) throw new ParseError(`date skeleton "${field}" is not supported`, 0);
        o.weekday = ["short", "long", "narrow", "short"][n - 4];
        break;
      case "a":
        o.hour12 = true;
        break;
      case "h":
      case "H":
      case "K":
      case "k":
        o.hourCycle = { h: "h12", H: "h23", K: "h11", k: "h24" }[field[0]];
        o.hour = two[n - 1];
        break;
      case "m":
        o.minute = two[n - 1];
        break;
      case "s":
        o.second = two[n - 1];
        break;
      case "z":
        o.timeZoneName = n < 4 ? "short" : "long";
        break;
      default:
        throw new ParseError(`date skeleton "${field}" is not supported`, 0);
    }
  }
  return o as Intl.DateTimeFormatOptions;
}

const FRACTION = /^\.(?:(0+)(\*)?|(#+)|(0+)(#+))$/;
const SIGNIFICANT = /^(@+)?(\+|#+)?[rs]?$/;
const MIN_INTEGER = /^(0+)$/;
const SIGNS: Record<string, Intl.NumberFormatOptions> = {
  "sign-auto": { signDisplay: "auto" },
  "sign-accounting": { currencySign: "accounting" },
  "()": { currencySign: "accounting" },
  "sign-always": { signDisplay: "always" },
  "+!": { signDisplay: "always" },
  "sign-accounting-always": { signDisplay: "always", currencySign: "accounting" },
  "()!": { signDisplay: "always", currencySign: "accounting" },
  "sign-except-zero": { signDisplay: "exceptZero" },
  "+?": { signDisplay: "exceptZero" },
  "sign-accounting-except-zero": { signDisplay: "exceptZero", currencySign: "accounting" },
  "()?": { signDisplay: "exceptZero", currencySign: "accounting" },
  "sign-never": { signDisplay: "never" },
  "+_": { signDisplay: "never" },
};
const STEMS: Record<string, Record<string, unknown>> = {
  percent: { style: "percent" },
  "%": { style: "percent" },
  "group-off": { useGrouping: false },
  ",_": { useGrouping: false },
  "precision-integer": { maximumFractionDigits: 0 },
  ".": { maximumFractionDigits: 0 },
  "compact-short": { notation: "compact", compactDisplay: "short" },
  K: { notation: "compact", compactDisplay: "short" },
  "compact-long": { notation: "compact", compactDisplay: "long" },
  KK: { notation: "compact", compactDisplay: "long" },
  "notation-simple": { notation: "standard" },
  "unit-width-narrow": { currencyDisplay: "narrowSymbol", unitDisplay: "narrow" },
  "unit-width-short": { currencyDisplay: "code", unitDisplay: "short" },
  "unit-width-full-name": { currencyDisplay: "name", unitDisplay: "long" },
  "unit-width-iso-code": { currencyDisplay: "symbol" },
  "rounding-mode-floor": { roundingMode: "floor" },
  "rounding-mode-ceiling": { roundingMode: "ceil" },
  "rounding-mode-down": { roundingMode: "trunc" },
  "rounding-mode-up": { roundingMode: "expand" },
  "rounding-mode-half-even": { roundingMode: "halfEven" },
  "rounding-mode-half-down": { roundingMode: "halfTrunc" },
  "rounding-mode-half-up": { roundingMode: "halfExpand" },
};

function significant(text: string): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  if (text.endsWith("r")) o.roundingPriority = "morePrecision";
  else if (text.endsWith("s")) o.roundingPriority = "lessPrecision";
  const m = SIGNIFICANT.exec(text);
  const [, at = "", rest] = m ?? [];
  if (rest === undefined) {
    o.minimumSignificantDigits = at.length;
    o.maximumSignificantDigits = at.length;
  } else if (rest === "+") o.minimumSignificantDigits = at.length;
  else if (at === "") o.maximumSignificantDigits = rest.length;
  else {
    o.minimumSignificantDigits = at.length;
    o.maximumSignificantDigits = at.length + rest.length;
  }
  return o;
}

export function numberSkeleton(skeleton: string): Intl.NumberFormatOptions {
  const tokens = skeleton.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) throw new ParseError("empty number skeleton", 0);
  let o: Record<string, unknown> = {};
  for (const token of tokens) {
    const [stem = "", ...options] = token.split("/");
    if (options.some((x) => x === "")) throw new ParseError(`number skeleton "${token}" is malformed`, 0);
    const fixed = STEMS[stem] ?? SIGNS[stem];
    if (fixed) {
      o = { ...o, ...fixed };
      continue;
    }
    if (stem === "currency" || stem === "unit" || stem === "measure-unit") {
      if (!options[0]) throw new ParseError(`"${stem}" needs a value`, 0);
      o = stem === "currency" ? { ...o, style: "currency", currency: options[0] } : { ...o, style: "unit", unit: options[0].replace(/^(.*?)-/, "") };
      continue;
    }
    if (stem === "scientific" || stem === "engineering") {
      o.notation = stem;
      for (const opt of options) Object.assign(o, SIGNS[opt] ?? {});
      continue;
    }
    if (MIN_INTEGER.test(stem)) {
      o.minimumIntegerDigits = stem.length;
      continue;
    }
    const f = FRACTION.exec(stem);
    if (f) {
      const [, zeros, star, hashes, minZeros, extra] = f;
      if (star) o.minimumFractionDigits = zeros!.length;
      else if (hashes) o.maximumFractionDigits = hashes.length;
      else if (minZeros && extra) {
        o.minimumFractionDigits = minZeros.length;
        o.maximumFractionDigits = minZeros.length + extra.length;
      } else {
        o.minimumFractionDigits = zeros!.length;
        o.maximumFractionDigits = zeros!.length;
      }
      if (options[0] === "w") o.trailingZeroDisplay = "stripIfInteger";
      else if (options[0]) Object.assign(o, significant(options[0]));
      continue;
    }
    if (stem.startsWith("@") || stem.startsWith("#")) {
      if (SIGNIFICANT.test(stem)) {
        Object.assign(o, significant(stem));
        continue;
      }
    }
    const concise = /^(EE?)(\+!|\+\?)?(0+)$/.exec(stem);
    if (concise) {
      o.notation = concise[1] === "EE" ? "engineering" : "scientific";
      if (concise[2]) o.signDisplay = concise[2] === "+!" ? "always" : "exceptZero";
      o.minimumIntegerDigits = concise[3]!.length;
      continue;
    }
    // scale, %x100, integer-width and anything unknown: Intl cannot say it, so the text is refused, not misprinted.
    throw new ParseError(`number skeleton "${stem}" is not supported`, 0);
  }
  try {
    new Intl.NumberFormat("en", o); // a currency or unit Intl does not know (EURO, foo) fails here, not on the page
  } catch {
    throw new ParseError(`number skeleton "${skeleton}" names a currency or unit Intl does not know`, 0);
  }
  return o as Intl.NumberFormatOptions;
}
