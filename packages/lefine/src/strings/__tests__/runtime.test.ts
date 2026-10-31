import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { compile, compileMessages } from "../compile.js";
import { createTranslator, format } from "../index.js";
import type { FormatError } from "../format.js";

describe("format never throws", () => {
  it("a missing value prints {name} and is reported", () => {
    const errors: FormatError[] = [];
    expect(format(compile("Hi {name}"), "en", {}, { onError: (e) => errors.push(e) })).toBe("Hi {name}");
    expect(format(compile("{n, plural, other {#}}"), "en", { n: "x" }, { onError: (e) => errors.push(e) })).toBe("{n}");
    expect(format(compile("{d, date}"), "en", { d: "soon" }, { onError: (e) => errors.push(e) })).toBe("{d}");
    expect(errors).toEqual([
      { code: "MISSING_VALUE", name: "name" },
      { code: "INVALID_VALUE", name: "n" },
      { code: "INVALID_VALUE", name: "d" },
    ]);
  });

  it("IR from JSON: a select value or argument named like an Object.prototype member is just a value", () => {
    // The CDN's IR is plain JSON: its branch objects have a prototype.
    const ir = JSON.parse(JSON.stringify(compile("{g, select, female {She} other {They}} {n, plural, one {#} other {# x}}")));
    for (const g of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(format(ir, "en", { g, n: 2 })).toBe("They 2 x");
    }
    expect(format(compile("{toString} <constructor>x</constructor>"), "en", {})).toBe("{toString} x");
    expect(format(compile("{p, number, constructor}"), "en", { p: 1.5 })).toBe("1.5");
  });

  it("Intl refusing a locale, currency, unit or time zone never throws (audit #3)", () => {
    const errors: FormatError[] = [];
    const onError = (e: FormatError) => void errors.push(e);
    // A locale Intl does not accept (en_US, from a cookie) formats with the runtime's.
    expect(() => format(compile("{n, number} {n, plural, one {#} other {# x}}"), "en_US", { n: 2 }, { onError })).not.toThrow();
    // An unknown currency or unit is refused at compile time; if IR still carries one, the rest of the text shows.
    expect(() => compile("{p, number, ::currency/EURO}")).toThrow("Intl does not know");
    expect(() => compile("{p, number, ::unit/foo}")).toThrow("Intl does not know");
    expect(format(["Pay ", ["p", 4, { style: "currency", currency: "EURO" }], " now"], "en", { p: 5 }, { onError })).toBe("Pay {p} now");
    expect(format([["d", 4, { style: "unit", unit: "foo" }], " left"], "en", { d: 5 }, { onError })).toBe("{d} left");
    expect(format(compile("At {t, time, short}"), "en", { t: new Date(0) }, { timeZone: "Mars/Olympus", onError })).toBe("At {t}");
    expect(errors.map((e) => `${e.code}:${e.name}`)).toEqual(["INVALID_FORMAT:p", "INVALID_FORMAT:d", "INVALID_FORMAT:t"]);
  });

  it("a number that arrives as a string is formatted (audit #9)", () => {
    expect(format(compile("{n, number}"), "en", { n: "1234.5" })).toBe("1,234.5");
    expect(format(compile("{n, number}"), "en", { n: "abc" })).toBe("{n}");
    expect(format(compile("{n, number}"), "en", { n: " " })).toBe("{n}");
  });

  it("an IR node it does not know is shown, not thrown (a newer format)", () => {
    const odd = JSON.parse('[ "a ", {"x": 1}, 42, ["n", 99], ["m", 4, {"style": "nope"}], "b" ]');
    expect(() => format(odd, "en", { n: 1, m: 2 })).not.toThrow();
  });

  it("a tag without a handler prints its text, never the markup", () => {
    expect(format(compile("<b>Bold</b> text"), "en")).toBe("Bold text");
  });

  it("a tag handler can return elements; strings around them stay strings", () => {
    const out = format(compile("Read <a>the docs</a> now"), "en", { a: (chunks) => ({ link: chunks }) });
    expect(out).toEqual(["Read ", { link: ["the docs"] }, " now"]);
  });

  it("dates use the given time zone, so server and client print the same", () => {
    const d = new Date(Date.UTC(2026, 0, 2, 23, 30));
    expect(format(compile("{d, time, short}"), "en", { d }, { timeZone: "UTC" })).toBe("11:30 PM");
    expect(format(compile("{d, time, short}"), "en", { d }, { timeZone: "Asia/Istanbul" })).toBe("2:30 AM");
    expect(format(compile("{d, date, medium}"), "tr", { d }, { timeZone: "UTC" })).toBe(new Intl.DateTimeFormat("tr", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(d));
  });

  it("named formats come from the app; an unknown one is reported and falls back to the default", () => {
    const errors: FormatError[] = [];
    const ir = compile("{p, number, money}");
    expect(format(ir, "en", { p: 5 }, { formats: { number: { money: { style: "currency", currency: "EUR" } } } })).toBe("€5.00");
    expect(format(ir, "en", { p: 5 }, { onError: (e) => errors.push(e) })).toBe("5");
    expect(errors).toEqual([{ code: "MISSING_FORMAT", name: "money" }]);
  });
});

describe("createTranslator", () => {
  const messages = compileMessages({
    common: { hello: "Hello {name}", items: "{n, plural, one {# item} other {# items}}" },
    billing: { trial: { ends: "Ends <b>{when}</b>" } },
  });

  it("reads keys under a namespace, nested by dots", () => {
    const t = createTranslator({ locale: "en", messages, namespace: "common" });
    expect(t("hello", { name: "Ada" })).toBe("Hello Ada");
    expect(t("items", { n: 1 })).toBe("1 item");
    expect(t.has("hello")).toBe(true);
    expect(t.has("nope")).toBe(false);
    const all = createTranslator({ locale: "en", messages });
    expect(all("billing.trial.ends", { when: "soon" })).toBe("Ends soon");
  });

  it("an unknown key prints the key and is reported", () => {
    const errors: FormatError[] = [];
    const t = createTranslator({ locale: "en", messages, namespace: "common", onError: (e) => errors.push(e) });
    expect(t("nope")).toBe("common.nope");
    // A group is not a text.
    expect(createTranslator({ locale: "en", messages })("billing.trial")).toBe("billing.trial");
    expect(errors).toEqual([{ code: "MISSING_MESSAGE", name: "common.nope" }]);
  });

  it("t.rich keeps elements; t keeps only text", () => {
    const t = createTranslator({ locale: "en", messages, namespace: "billing" });
    const b = (chunks: unknown[]) => ({ b: chunks });
    expect(t.rich("trial.ends", { when: "Friday", b })).toEqual(["Ends ", { b: ["Friday"] }]);
    expect(t("trial.ends", { when: "Friday", b })).toBe("Ends ");
  });
});

describe("bundle size", () => {
  it("the client entry (formatter + translator) is under 2 KB gzip", () => {
    // An entry that uses both exports: bundling index.ts itself lets the bundler drop them (sideEffects: false).
    const dir = mkdtempSync(join(tmpdir(), "lefine-strings-size-"));
    const entry = join(dir, "entry.ts");
    writeFileSync(entry, `import { createTranslator, format } from ${JSON.stringify(fileURLToPath(new URL("../index.ts", import.meta.url)))};\nglobalThis.x = [createTranslator, format];\n`);
    const code = execFileSync("bun", ["build", entry, "--minify", "--target=browser", "--format=esm"], { encoding: "utf-8" });
    rmSync(dir, { recursive: true, force: true });
    expect(code).toContain("PluralRules");
    const gzip = gzipSync(code, { level: 9 }).length;
    console.log(`lefine/strings client entry: ${code.length} B minified, ${gzip} B gzip`);
    expect(code).not.toContain("icu-messageformat-parser");
    expect(gzip).toBeLessThan(2048);
  });
});

describe("a runtime without Intl.PluralRules (Hermes, React Native; seen in Expo Go on iOS 2026-10-27)", () => {
  it("picks one for 1 and other otherwise, never prints {n}, and reports MISSING_INTL", () => {
    const real = Intl.PluralRules;
    (Intl as { PluralRules?: unknown }).PluralRules = undefined;
    try {
      const errors: string[] = [];
      const msg = compile("{n, plural, one {# message} other {# messages}}");
      const f = (n: number) => format(msg, "en", { n }, { onError: (e) => errors.push(e.code) });
      expect([f(1), f(3), f(0)]).toEqual(["1 message", "3 messages", "0 messages"]);
      expect(format(compile("{n, plural, =0 {none} other {#}}"), "en", { n: 0 })).toBe("none");
      // A language with no `one` branch (Japanese) takes `other`.
      expect(format(compile("{n, plural, other {#件}}"), "ja", { n: 1 })).toBe("1件");
      expect(new Set(errors)).toEqual(new Set(["MISSING_INTL"]));
    } finally {
      Intl.PluralRules = real;
    }
  });
});
