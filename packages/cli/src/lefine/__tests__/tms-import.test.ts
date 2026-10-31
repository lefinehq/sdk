import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { collectExport } from "../import-command.js";
import { ExportError, pluralToIcu, readExport, readXliff } from "../tms-import.js";

const FIX = join(import.meta.dir, "fixtures", "tms");
const file = (rel: string) => ({ path: rel.split("/").pop()!, content: readFileSync(join(FIX, rel), "utf-8") });
const folder = (rel: string) => {
  const root = join(FIX, rel);
  const out: Array<{ path: string; content: string }> = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push({ path: relative(root, full), content: readFileSync(full, "utf-8") });
    }
  };
  walk(root);
  return out;
};
/** locale → key → "state: text", for short assertions. */
const view = (langs: ReturnType<typeof readExport>) =>
  Object.fromEntries(langs.map((l) => [l.locale, Object.fromEntries([...l.texts].map(([k, v]) => [k, `${v.state}: ${v.text}`]))]));

describe("plurals", () => {
  it("an object or its JSON string becomes one ICU plural on count; anything else is not a plural", () => {
    expect(pluralToIcu({ one: "{count} item", other: "{count} items" })).toBe("{count, plural, one {{count} item} other {{count} items}}");
    expect(pluralToIcu('{"zero":"none","one":"one","other":"many"}')).toBe("{count, plural, =0 {none} one {one} other {many}}");
    expect(pluralToIcu({ one: "x" })).toBeNull(); // no other
    expect(pluralToIcu({ save: "Save" })).toBeNull();
    expect(pluralToIcu("Hello {name}")).toBeNull();
  });
});

describe("Crowdin", () => {
  it("the JSON zip (a folder per language, i18next files): keys by file namespace, i18next plurals left for the server to merge", () => {
    expect(view(readExport("crowdin", folder("crowdin/zip")))).toEqual({
      "de-DE": {
        "common.welcome": "reviewed: Willkommen, {{name}}!",
        "common.nav.save": "reviewed: Speichern",
        "common.nav.cancel": "reviewed: Abbrechen",
        "common.items_one": "reviewed: {{count}} Artikel",
        "common.items_other": "reviewed: {{count}} Artikel",
      },
      en: {
        "common.welcome": "reviewed: Welcome, {{name}}!",
        "common.nav.save": "reviewed: Save",
        "common.nav.cancel": "reviewed: Cancel",
        "common.items_one": "reviewed: {{count}} item",
        "common.items_other": "reviewed: {{count}} items",
      },
    });
  });

  it("an approved-only export lands approved with --state approved", () => {
    const langs = readExport("crowdin", folder("crowdin/zip"), { defaultState: "approved" });
    expect([...langs[0]!.texts.values()].every((t) => t.state === "approved")).toBe(true);
  });

  it("its XLIFF is refused, with what to export instead (its ids are numbers, not keys)", () => {
    expect(() => readExport("crowdin", [file("crowdin/de-DE.xlf")])).toThrow(ExportError);
    expect(() => readExport("crowdin", [file("crowdin/de-DE.xlf")])).toThrow("download the translations as JSON");
  });
});

describe("Lokalise", () => {
  it("nested JSON: dotted keys, a JSON-string plural becomes ICU, no review state (reviewed)", () => {
    expect(view(readExport("lokalise", [file("lokalise/de.json")]))).toEqual({
      de: {
        "common.welcome": "reviewed: Willkommen, {name}!",
        "nav.save": "reviewed: Speichern",
        "nav.cancel": "reviewed: Abbrechen",
        "common.items": "reviewed: {count, plural, one {{count} Artikel} other {{count} Artikel}}",
      },
    });
  });

  it("structured JSON: the translation property; :: nests", () => {
    expect(view(readExport("lokalise", [{ path: "de.json", content: file("lokalise/de.structured.json").content }]))).toEqual({
      de: { "common.welcome": "reviewed: Willkommen, {name}!", "nav.save": "reviewed: Speichern" },
    });
  });

  it("XLIFF: final is approved, translated and needs-review are reviewed, the source comes along, the language from target-language", () => {
    expect(view(readExport("lokalise", [file("lokalise/de.xliff")]))).toEqual({
      en: {
        "common.welcome": "reviewed: Welcome, {name}!",
        "nav.save": "reviewed: Save",
        "nav.cancel": "reviewed: Cancel",
        "common.items": "reviewed: {count, plural, one {{count} item} other {{count} items}}",
      },
      de: {
        "common.welcome": "approved: Willkommen, {name}!",
        "nav.save": "reviewed: Speichern",
        "nav.cancel": "reviewed: Abbrechen",
        "common.items": "reviewed: {count, plural, one {{count} Artikel} other {{count} Artikel}}",
      },
    });
  });
});

describe("Phrase", () => {
  it("Strings JSON: every language in one file, reviewed is approved, translated and unverified are reviewed", () => {
    expect(view(readExport("phrase", [file("phrase/strings.json")]))).toEqual({
      "en-US": { "common.welcome": "approved: Welcome, {name}!" },
      "de-DE": { "common.welcome": "reviewed: Willkommen, {name}!", "common.cancel": "reviewed: Abbrechen" },
    });
  });

  it("simple and nested JSON read the same; plural objects become ICU", () => {
    const simple = view(readExport("phrase", [file("phrase/de.json")]));
    const nested = view(readExport("phrase", [{ path: "de.json", content: file("phrase/nested/de.json").content }]));
    expect(simple).toEqual(nested);
    expect(simple.de!["common.items"]).toBe("reviewed: {count, plural, one {{count} Artikel} other {{count} Artikel}}");
    expect(simple.de!["nav.save"]).toBe("reviewed: Speichern");
  });

  it("XLIFF with translation state: signed-off is approved", () => {
    const langs = view(readExport("phrase", [file("phrase/en-GB.xlf")]));
    expect(langs["en-GB"]).toEqual({
      "common.welcome": "approved: Welcome, {name}!",
      "nav.save": "reviewed: Save",
      "common.items": "reviewed: {count, plural, one {{count} item} other {{count} items}}",
    });
    expect(Object.keys(langs)).toEqual(["de-DE", "en-GB"]);
  });
});

describe("XLIFF rules", () => {
  it("untranslated is left out, never sent as the source text; approved=yes counts", () => {
    const x = readXliff({
      path: "x.xlf",
      content: `<xliff version="1.2"><file source-language="en" target-language="fr"><body>
        <trans-unit id="a"><source>A</source><target state="needs-translation"></target></trans-unit>
        <trans-unit id="b"><source>B</source></trans-unit>
        <trans-unit id="c" approved="yes"><source>C</source><target>Cé &amp; co</target></trans-unit>
      </body></file></xliff>`,
    });
    expect(x.units.map((u) => [u.key, u.state, u.target])).toEqual([
      ["a", "untranslated", null],
      ["b", "untranslated", null],
      ["c", "approved", "Cé & co"],
    ]);
    const fr = readExport("lokalise", [{ path: "x.xlf", content: `<xliff version="1.2"><file source-language="en" target-language="fr"><body><trans-unit id="a"><source>A</source></trans-unit></body></file></xliff>` }]);
    expect(fr.find((l) => l.locale === "fr")).toBeUndefined();
  });

  it("XLIFF 2: final and reviewed are approved, the languages from srcLang / trgLang", () => {
    const x = readXliff({
      path: "x.xlf",
      content: `<xliff version="2.0" srcLang="en" trgLang="de"><file id="f"><unit id="a"><segment state="final"><source>A</source><target>Ä</target></segment></unit><unit id="b"><segment state="translated"><source>B</source><target>Bé</target></segment></unit></file></xliff>`,
    });
    expect([x.source, x.target]).toEqual(["en", "de"]);
    expect(x.units.map((u) => [u.key, u.state])).toEqual([["a", "approved"], ["b", "reviewed"]]);
  });

  it("keys naming __proto__, constructor or prototype are dropped, and nothing reaches Object.prototype", () => {
    const evil = '{"__proto__": {"polluted": "yes"}, "a": {"constructor": {"prototype": {"x": "1"}}}, "ok": "fine", "x.__proto__.y": "no"}';
    const langs = readExport("phrase", [{ path: "de.json", content: evil }]);
    expect([...langs[0]!.texts.keys()]).toEqual(["common.ok"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const xliff = readExport("lokalise", [{ path: "x.xlf", content: '<xliff version="1.2"><file source-language="en" target-language="de"><body><trans-unit id="__proto__::polluted"><source>A</source><target>B</target></trans-unit></body></file></xliff>' }]);
    expect(xliff.every((l) => l.texts.size === 0)).toBe(true);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("a JSON file whose language cannot be told from its name says how to name it", () => {
    expect(() => readExport("phrase", [{ path: "translations.json", content: "{}" }])).toThrow("de/common.json");
  });
});

describe("collectExport", () => {
  it("walks a folder for JSON and XLIFF, with / paths", () => {
    expect(collectExport(join(FIX, "crowdin/zip")).map((f) => f.path)).toEqual(["de-DE/common.json", "en/common.json"]);
    expect(collectExport(join(FIX, "phrase/strings.json")).map((f) => f.path)).toEqual(["strings.json"]);
    expect(() => collectExport(join(FIX, "nope"))).toThrow("Not found");
  });
});

describe("Transifex", () => {
  const de = {
    "nav.save": "reviewed: Speichern",
    "common.welcome": "reviewed: Willkommen, {name}!",
    "nav.files": "reviewed: { file_count, plural, one {Du hast {file_count} Datei.} other {Du hast {file_count} Dateien.} }",
  };
  it("key-value JSON: nested keys, ICU kept as written, no review state (reviewed)", () => {
    expect(view(readExport("transifex", [file("transifex/de.json")]))).toEqual({ de: expect.objectContaining(de) });
  });

  it("structured JSON reads the same texts from its string property", () => {
    const flat = view(readExport("transifex", [file("transifex/de.json")]));
    const structured = view(readExport("transifex", [{ path: "structured/de.json", content: file("transifex/structured/de.json").content }]));
    expect(structured).toEqual(flat);
  });

  it("XLIFF 1.2: approved=yes is approved, no is reviewed, a two-form plural group becomes ICU, untranslated left out", () => {
    const langs = view(readExport("transifex", [file("transifex/de.xlf")]));
    expect(langs.de).toEqual({
      "common.welcome": "approved: Willkommen, {name}!",
      "nav.save": "reviewed: Speichern",
      "common.trial": "reviewed: {count, plural, one {Deine Testphase endet in 1 Tag} other {Deine Testphase endet in {count} Tagen}}",
    });
    expect(langs.en!["nav.cancel"]).toBe("reviewed: Cancel");
  });

  it("XLIFF 2.0 with no trgLang takes the language from its folder or file name, or --locale", () => {
    const fromName = view(readExport("transifex", [{ path: "xliff2/de.xlf", content: file("transifex/xliff2/de.xlf").content }]));
    expect(fromName.de).toEqual({ "common.greeting": "reviewed: Bestätige deine E-Mail-Adresse", "common.farewell": "reviewed: Bis bald & pass auf dich auf" });
    expect(() => readExport("transifex", [{ path: "export.xlf", content: file("transifex/xliff2/de.xlf").content }])).toThrow("--locale");
    expect(Object.keys(view(readExport("transifex", [{ path: "export.xlf", content: file("transifex/xliff2/de.xlf").content }], { locale: "fr" })))).toContain("fr");
  });

  it("PO: the file name beats a wrong Language header; a whole sentence with dots stays one key; two-form plurals become ICU; empty left out", () => {
    expect(view(readExport("transifex", [file("transifex/de.po")]))).toEqual({
      de: {
        "common.{count} file": "reviewed: {count, plural, one {{count} Datei} other {{count} Dateien}}",
        "common.Save. Then close.": "reviewed: Speichern. Dann schließen.",
      },
    });
  });
});

describe("POEditor", () => {
  it("json export: terms are keys, plural definitions become ICU (other alone too), null is missing; the language from the name or --locale", () => {
    const fr = view(readExport("poeditor", [file("poeditor/fr.json")])).fr!;
    expect(fr["singular.1"]).toBe("reviewed:   Texte singulier  ");
    expect(fr["plural.1"]).toBe("reviewed: {count, plural, one {Vous avez un seul plural1 objet} other {Vous avez %d plural1 objets}}");
    expect(fr["common.chinese_ios"]).toMatch(/^reviewed: \{count, plural, other \{%d/);
    expect(fr).not.toHaveProperty("common.missing");
    expect(() => readExport("poeditor", [{ path: "terms.json", content: file("poeditor/fr.json").content }])).toThrow("--locale");
    expect(Object.keys(view(readExport("poeditor", [{ path: "terms.json", content: file("poeditor/fr.json").content }], { locale: "fr-CA" })))).toEqual(["fr-CA"]);
  });

  it("real PO export: the Language header names it; a four-form plural (with an empty form) is left out", () => {
    const report: string[] = [];
    const pl = view(readExport("poeditor", [{ path: "spot.po", content: file("poeditor/pl.po").content }], { report }));
    expect(pl).toEqual({ pl: { "spot.View album": "reviewed: Zobacz album", "spot.Copy link": "reviewed: Skopiuj link" } });
  });

  it("fuzzy (POEditor's needs review) is left out and reported; --include-fuzzy brings it in as reviewed", () => {
    const report: string[] = [];
    const ja = view(readExport("poeditor", [file("poeditor/ja.po")], { report }));
    expect(ja.ja).toEqual({ "common.View album": "reviewed: アルバムを見る" });
    expect(report.join("\n")).toContain("1 fuzzy entry");
    const all = view(readExport("poeditor", [file("poeditor/ja.po")], { includeFuzzy: true }));
    expect(all.ja!["common.More from {}"]).toBe("reviewed: 詳細");
  });

  it("a PO plural with more than two forms is reported, not guessed", () => {
    const report: string[] = [];
    const po = 'msgid ""\nmsgstr "Language: ru\\nPlural-Forms: nplurals=3;\\n"\n\nmsgid "{n} file"\nmsgid_plural "{n} files"\nmsgstr[0] "a"\nmsgstr[1] "b"\nmsgstr[2] "c"\n';
    expect(view(readExport("poeditor", [{ path: "ru.po", content: po }], { report }))).toEqual({});
    expect(report.join("\n")).toContain("has 3 forms");
  });
});
