import { IntlMessageFormat } from "intl-messageformat";
import { describe, expect, it } from "vitest";
import { compile, compileMessages } from "../compile.js";
import { format, type Values } from "../format.js";
import type { Message, Node } from "../ir.js";
import corpus from "./landing-corpus.json";

describe("compile", () => {
  it("a plain text stays the same string", () => {
    expect(compile("Welcome")).toBe("Welcome");
    expect(compile("")).toBe("");
    // ICU escaping is resolved at compile time.
    expect(compile("It''s '{literal}'")).toBe("It's {literal}");
  });

  it("writes the IR of docs/strings-runtime.md §2", () => {
    expect(compile("Hello {name}!")).toEqual(["Hello ", ["name"], "!"]);
    expect(compile("{n, plural, =0 {none} one {# item} other {# items}}")).toEqual([
      ["n", 2, { "=0": "none", one: [0, " item"], other: [0, " items"] }],
    ]);
    expect(compile("{n, selectordinal, one {#st} other {#th}}")).toEqual([["n", 3, { one: [0, "st"], other: [0, "th"] }]]);
    expect(compile("{g, select, female {She} other {They}}")).toEqual([["g", 1, { female: "She", other: "They" }]]);
    expect(compile("{p, number, percent}")).toEqual([["p", 4, { style: "percent" }]]);
    expect(compile("{p, number, ::currency/EUR}")).toEqual([["p", 4, { style: "currency", currency: "EUR" }]]);
    expect(compile("{p, number, money}")).toEqual([["p", 4, "money"]]);
    expect(compile("{d, date, short}")).toEqual([["d", 5, { month: "numeric", day: "numeric", year: "2-digit" }]]);
    expect(compile("{d, time}")).toEqual([["d", 6]]);
    expect(compile("Read <b>the {doc}</b>")).toEqual(["Read ", ["b", 7, "the ", ["doc"]]]);
    expect(compile("<br></br>")).toEqual([["br", 7]]);
  });

  it("keeps a plural offset as a fourth item", () => {
    expect(compile("{n, plural, offset:1 =0 {none} other {# more}}")).toEqual([["n", 2, { "=0": "none", other: [0, " more"] }, 1]]);
  });

  it("refuses what the runtime does not do", () => {
    expect(() => compile("{h, time, ::jm}")).toThrow('field "j"');
    expect(() => compile("{n, plural, one {x}}")).toThrow();
    expect(() => compile("{unclosed")).toThrow();
  });

  it("compileMessages keeps a broken text as written and reports its key", () => {
    const errors: string[] = [];
    const tree = compileMessages({ a: { ok: "Hi {n}", bad: "Hi {n" }, skip: 3 }, (e) => errors.push(e.key));
    expect(tree).toEqual({ a: { ok: ["Hi ", ["n"]], bad: "Hi {n" } });
    expect(errors).toEqual(["a.bad"]);
  });
});

/** Values for every argument of a message: numbers for plurals and numbers, the first branch for selects. */
function valuesFor(message: Message, values: Values = {}): Values {
  if (typeof message === "string") return values;
  for (const node of message as Node[]) {
    if (!Array.isArray(node)) continue;
    const [name, type] = node;
    if (type === undefined) values[name] ??= "X";
    else if (type === 1) {
      values[name] ??= Object.keys(node[2] as object)[0]!;
      for (const b of Object.values(node[2] as object)) valuesFor(b as Message, values);
    } else if (type === 2 || type === 3) {
      values[name] ??= 3;
      for (const b of Object.values(node[2] as object)) valuesFor(b as Message, values);
    } else if (type === 4) values[name] ??= 1234.5;
    else if (type === 7) {
      values[name] ??= (chunks: unknown[]) => `<${name}>${chunks.join("")}</${name}>`;
      valuesFor(node.slice(2) as Node[], values);
    }
  }
  return values;
}

describe("same output as intl-messageformat (next-intl / react-intl) on real texts", () => {
  // The Lefine landing on the Better i18n CDN: every text with an argument or a tag, and a sample of plain ones.
  for (const [locale, messages] of Object.entries(corpus.locales as Record<string, Record<string, string>>)) {
    it(`${locale}: ${Object.keys(messages).length} texts`, () => {
      let compared = 0;
      for (const [key, text] of Object.entries(messages)) {
        let reference: IntlMessageFormat;
        try {
          reference = new IntlMessageFormat(text, locale);
        } catch {
          // Not valid ICU for the reference either: ours must refuse it too.
          expect(() => compile(text), key).toThrow();
          continue;
        }
        const ir = compile(text);
        const values = valuesFor(ir);
        const expected = reference.format(values);
        const actual = format(ir, locale, values);
        expect(Array.isArray(actual) ? actual.join("") : actual, key).toBe(Array.isArray(expected) ? expected.join("") : expected);
        compared++;
      }
      expect(compared).toBeGreaterThan(70);
    });
  }
});

describe("plural rules come from Intl, checked against intl-messageformat", () => {
  const cases: Array<[string, string]> = [
    ["ar", "{n, plural, zero {zero} one {one} two {two} few {few #} many {many #} other {other #}}"],
    ["ru", "{n, plural, one {# файл} few {# файла} many {# файлов} other {# файла}}"],
    ["pl", "{n, plural, one {# plik} few {# pliki} many {# plików} other {# pliku}}"],
    ["cy", "{n, plural, zero {zero} one {one} two {two} few {few} many {many} other {other}}"],
    ["en", "{n, selectordinal, one {#st} two {#nd} few {#rd} other {#th}}"],
    ["en", "{n, plural, =0 {nothing} =1 {exactly one} other {# things}}"],
    ["de", "{n, plural, one {# Datei} other {# Dateien}} in <b>{folder}</b>"],
    ["en", "{n, plural, offset:1 =0 {nobody} =1 {you} one {you and # other} other {you and # others}}"],
  ];
  for (const [locale, text] of cases) {
    it(`${locale} ${text.slice(0, 32)}…`, () => {
      const reference = new IntlMessageFormat(text, locale);
      const ir = compile(text);
      for (const n of [0, 1, 2, 3, 4, 5, 11, 12, 21, 22, 23, 100, 101, 1.5, 1000000]) {
        const values = { n, folder: "Docs", b: (c: unknown[]) => `*${c.join("")}*` };
        const expected = reference.format(values);
        const actual = format(ir, locale, values);
        expect(Array.isArray(actual) ? actual.join("") : actual, `n=${n}`).toBe(Array.isArray(expected) ? (expected as unknown[]).join("") : expected);
      }
    });
  }
});
