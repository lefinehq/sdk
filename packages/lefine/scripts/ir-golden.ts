// Writes src/strings/__tests__/ir-golden.json: ICU texts and the IR they compile to (or that they are refused).
// The wire format between Lefine's publish (which compiles messages.ir.json with the same parser) and the SDK.
// The publish side tests against this same file.
// Run after a deliberate parser change: `bun scripts/ir-golden.ts`, then review the diff.
import { writeFileSync } from "node:fs";
import { compile } from "../src/strings/compile.ts";
import corpus from "../src/strings/__tests__/landing-corpus.json";

const CASES = [
  "Welcome", "", "It''s '{literal}'", "a '{b}' c", "x '' y", "'<b>' t", "'#' {n, plural, other {'#' #}}",
  "Hello {name}!", "{ name }", "<b>x</b>", "<br/>", "a < b", "Read <b>the {doc}</b>", "<br></br>", "<b>{n, plural, other {#}}</b>",
  "{n, plural, =0 {none} one {# item} other {# items}}", "{n, plural, offset:1 =0 {nobody} one {you and # other} other {you and # others}}",
  "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}", "{g, select, female {She} other {They}}",
  "{n, plural, other {{g, select, other {#}}}}",
  "{p, number}", "{p, number, percent}", "{p, number, integer}", "{p, number, money}", "{p, number, ::currency/EUR .00}", "{p, number, ::compact-short}",
  "{p, number, ::unit/kilometer unit-width-full-name}", "{p, number, ::.0#}", "{p, number, ::@@#}",
  "{d, date}", "{d, date, short}", "{d, date, full}", "{d, time, short}", "{d, date, ::yMMMd}", "{d, time, ::Hmm}", "{d, time, ::hhmma}",
  // refused
  "{n, plural, one {x}}", "{unclosed", "<b>x", "</b>", "{a, foo}", "{p, number, ::scale/100}", "{p, number, ::currency/EURO}", "{h, time, ::jm}",
];

const texts = [...CASES, ...Object.values(corpus.locales.en as Record<string, string>).filter((t) => /[{<]/.test(t))];
const cases = texts.map((text) => {
  try {
    return { text, ir: compile(text) };
  } catch {
    return { text, error: true };
  }
});
const file = new URL("../src/strings/__tests__/ir-golden.json", import.meta.url);
writeFileSync(file, `${JSON.stringify({ format: 1, cases }, null, 1)}\n`);
console.log(`${cases.length} cases, ${cases.filter((c) => "error" in c).length} refused`);
