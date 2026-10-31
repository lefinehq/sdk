import { TYPE, parse, type MessageFormatElement } from "@formatjs/icu-messageformat-parser";
import { describe, expect, it } from "vitest";
import type { Branches, Message, Node } from "../ir.js";
import { parseMessage } from "../parser.js";
import corpus from "./landing-corpus.json";

/**
 * The oracle: formatjs' parser (devDependency only, never shipped) turned into our IR the way the first
 * version of compile.ts did. Our parser must give the same IR, or refuse what formatjs refuses.
 */
const NUMBER_STYLES: Record<string, object> = { integer: { maximumFractionDigits: 0 }, percent: { style: "percent" } };
const DATE_STYLES: Record<string, object> = {
  short: { month: "numeric", day: "numeric", year: "2-digit" },
  medium: { month: "short", day: "numeric", year: "numeric" },
  long: { month: "long", day: "numeric", year: "numeric" },
  full: { weekday: "long", month: "long", day: "numeric", year: "numeric" },
};
const TIME_STYLES: Record<string, object> = {
  short: { hour: "numeric", minute: "numeric" },
  medium: { hour: "numeric", minute: "numeric", second: "numeric" },
  long: { hour: "numeric", minute: "numeric", second: "numeric", timeZoneName: "short" },
  full: { hour: "numeric", minute: "numeric", second: "numeric", timeZoneName: "short" },
};
type Style = string | { parsedOptions: object } | null | undefined;
const style = (v: Style, named: Record<string, object>) =>
  !v ? undefined : typeof v === "string" ? (named[v] ?? v) : Object.keys(v.parsedOptions).length > 0 ? v.parsedOptions : undefined;
function nodes(elements: MessageFormatElement[]): Node[] {
  const out: Node[] = [];
  for (const e of elements) {
    const n = element(e);
    if (typeof n === "string" && typeof out[out.length - 1] === "string") out[out.length - 1] += n;
    else out.push(n);
  }
  return out;
}
const msg = (l: Node[]): Message => (l.length === 0 ? "" : l.length === 1 && typeof l[0] === "string" ? l[0] : l);
function branches(o: Record<string, { value: MessageFormatElement[] }>): Branches {
  const out: Branches = {};
  for (const [k, v] of Object.entries(o)) out[k] = msg(nodes(v.value));
  return out;
}
function element(e: MessageFormatElement): Node {
  switch (e.type) {
    case TYPE.literal:
      return e.value;
    case TYPE.argument:
      return [e.value];
    case TYPE.pound:
      return 0;
    case TYPE.number: {
      const s = style(e.style as Style, NUMBER_STYLES);
      return (s === undefined ? [e.value, 4] : [e.value, 4, s]) as Node;
    }
    case TYPE.date:
    case TYPE.time: {
      const t = e.type === TYPE.date ? 5 : 6;
      const s = style(e.style as Style, t === 5 ? DATE_STYLES : TIME_STYLES);
      return (s === undefined ? [e.value, t] : [e.value, t, s]) as Node;
    }
    case TYPE.select:
      return [e.value, 1, branches(e.options)];
    case TYPE.plural: {
      const id = e.pluralType === "ordinal" ? 3 : 2;
      return (e.offset ? [e.value, id, branches(e.options), e.offset] : [e.value, id, branches(e.options)]) as Node;
    }
    case TYPE.tag:
      return [e.value, 7, ...nodes(e.children)] as Node;
    default:
      throw new Error("unknown");
  }
}
const oracle = (text: string): Message => msg(nodes(parse(text, { shouldParseSkeletons: true, requiresOtherClause: true })));

/** Same IR, or both refuse. Branch objects compare by content (ours have no prototype). */
function same(text: string): void {
  let expected: Message | Error;
  try {
    expected = oracle(text);
  } catch (err) {
    expected = err as Error;
  }
  if (expected instanceof Error) {
    expect(() => parseMessage(text), `formatjs refuses ${JSON.stringify(text)}`).toThrow();
    return;
  }
  expect(JSON.parse(JSON.stringify(parseMessage(text))), JSON.stringify(text)).toEqual(expected);
}

describe("our parser gives formatjs' IR", () => {
  it("on every text of the landing corpus, in six languages", () => {
    let n = 0;
    for (const messages of Object.values(corpus.locales as Record<string, Record<string, string>>)) {
      for (const text of Object.values(messages)) {
        same(text);
        n++;
      }
    }
    expect(n).toBeGreaterThan(500);
  });

  const cases = [
    // quoting
    "a '{b}' c", "it's", "x '' y", "'<b>' t", "'{'", "a'b{c}'d", "'}'", "'' '{a''b}'", "a'", "'", "''", "'>' x", "don't '{'",
    "'#' {n, plural, other {'#' #}}", "{n, plural, other {it''s # '{x}'}}",
    // tags
    "<b>x</b>", "<br/>", "<br />", "a < b", "a <1> b", "<a-b>x</a-b>", "<b>{n, plural, other {#}}</b>", "<b><i>x</i></b>", "<b>x</i>", "<b>x", "</b>",
    "<b>{name}</b> and <i>more</i>", "<b >x</b >", "<B>x</B>",
    // arguments
    "{ name }", "{name}", "{n,number}", "{ n , number , percent }", "{n, number, integer}", "{n, number, money}", "{}", "{ }", "{a b}", "{a, foo}",
    "{d, date}", "{d, date, short}", "{d, date, medium}", "{d, date, long}", "{d, date, full}", "{d, time, short}", "{d, time, full}", "{d, date, custom}",
    // plural / select
    "{n, plural, one {# item} other {# items}}", "{n, plural, =0 {none} =1 {one} other {#}}", "{n, plural, =-1 {neg} other {x}}",
    "{n, plural, other {{g, select, other {#}}}}", "{n, plural, other {<b>#</b>}}", "{n,plural,one{a}other{b}}", "{n, plural, one {x}}",
    "{n, plural, one {a} one {b} other {c}}", "{g, select, a {x} b {y} other {z}}", "{g, select, =1 {x} other {y}}", "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}",
    "{n, plural, offset:1 =0 {nobody} one {you and # other} other {you and # others}}", "{n, plural, offset: 2 other {#}}", "{n, plural,}", "{n, plural, other x}", "a } b", "{a}}", "{{a}}",
    // skeletons
    "{n, number, ::currency/EUR}", "{n, number, ::currency/EUR .00}", "{n, number, ::percent}", "{n, number, ::%}", "{n, number, ::.00}", "{n, number, ::.0#}",
    "{n, number, ::.##}", "{n, number, ::.00*}", "{n, number, ::@@}", "{n, number, ::@@#}", "{n, number, ::@#}", "{n, number, ::compact-short}", "{n, number, ::K}",
    "{n, number, ::compact-long}", "{n, number, ::unit/kilometer}", "{n, number, ::measure-unit/length-meter unit-width-full-name}", "{n, number, ::sign-always}",
    "{n, number, ::+!}", "{n, number, ::group-off}", "{n, number, ::,_}", "{n, number, ::000}", "{n, number, ::scientific}", "{n, number, ::engineering/sign-always}",
    "{n, number, ::E0}", "{n, number, ::EE+!00}", "{n, number, ::precision-integer}", "{n, number, ::rounding-mode-floor .0}", "{n, number, ::currency/USD unit-width-narrow}",
    "{n, number, ::.00/w}", "{d, date, ::yMMMd}", "{d, date, ::yyyyMMdd}", "{d, date, ::EEEE}", "{d, time, ::Hmm}", "{d, time, ::hhmma}", "{d, date, ::GGGGy}",
    "{d, time, ::Hmmz}", "{d, date, ::MMMMd 'at' Hm}",
  ];
  for (const text of cases) it(JSON.stringify(text), () => same(text));
});

describe("what we refuse on purpose (Intl cannot say it; formatjs would drop it and print the wrong thing)", () => {
  for (const text of ["{n, number, ::scale/100}", "{n, number, ::%x100}", "{n, number, ::integer-width/*000}", "{h, time, ::jm}", "{h, time, ::Jmm}", "{h, date, ::Cd}"]) {
    it(text, () => expect(() => parseMessage(text)).toThrow());
  }
});
