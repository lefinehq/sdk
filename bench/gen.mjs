// One source of 200 texts in 3 languages, written into each library's own format. Deterministic: same output on
// every run. Mix: 140 plain, 30 with a variable, 20 plurals, 10 dates (all ICU MessageFormat).
//
//   node bench/gen.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const LOCALES = ["en", "de", "tr"];
const pad = (i) => String(i).padStart(3, "0");

const WORDS = {
  en: { plain: (i) => `Feature ${i} keeps your team in sync across every project`, var: (i) => `Hello {name}, welcome to section ${i}`, one: "file", other: "files", folder: (i) => `in folder ${i}`, date: (i) => `Updated on {d, date, medium} (report ${i})` },
  de: { plain: (i) => `Funktion ${i} hält Ihr Team in jedem Projekt synchron`, var: (i) => `Hallo {name}, willkommen in Abschnitt ${i}`, one: "Datei", other: "Dateien", folder: (i) => `in Ordner ${i}`, date: (i) => `Aktualisiert am {d, date, medium} (Bericht ${i})` },
  tr: { plain: (i) => `Özellik ${i} ekibinizi her projede uyumlu tutar`, var: (i) => `Merhaba {name}, ${i}. bölüme hoş geldiniz`, one: "dosya", other: "dosya", folder: (i) => `klasör ${i} içinde`, date: (i) => `{d, date, medium} tarihinde güncellendi (rapor ${i})` },
};

/** { k001: "…ICU…", … } for one locale. */
export function textsOf(locale) {
  const w = WORDS[locale];
  const out = {};
  for (let i = 1; i <= 200; i++) {
    const id = `k${pad(i)}`;
    if (i <= 140) out[id] = w.plain(i);
    else if (i <= 170) out[id] = w.var(i);
    else if (i <= 190)
      out[id] = locale === "tr" ? `{count, plural, other {${w.folder(i)} # ${w.other}}}` : `{count, plural, one {# ${w.one} ${w.folder(i)}} other {# ${w.other} ${w.folder(i)}}}`;
    else out[id] = w.date(i);
  }
  return out;
}

export const KEYS = Object.keys(textsOf("en"));

function write(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
}

const po = (locale) =>
  [`msgid ""`, `msgstr ""`, `"Language: ${locale}\\n"`, ``, ...Object.entries(textsOf(locale)).flatMap(([id, text]) => [`#. js-lingui-explicit-id`, `msgid "${id}"`, `msgstr "${text.replace(/"/g, '\\"')}"`, ``])].join("\n");

export function generate() {
  const apps = join(here, "apps");
  for (const app of ["baseline", "lefine", "lefine-snapshot", "next-intl", "paraglide", "lingui"]) write(join(apps, app, "src", "keys.json"), JSON.stringify(KEYS));
  for (const locale of LOCALES) {
    const texts = textsOf(locale);
    // next-intl and lefine: one namespace, "page".
    write(join(apps, "next-intl", "messages", `${locale}.json`), JSON.stringify({ page: texts }, null, 1));
    write(join(here, "edge-data", `${locale}.json`), JSON.stringify({ page: texts }));
    // Paraglide: flat ICU1 JSON (inlang ICU1 plugin).
    write(join(apps, "paraglide", "messages", `${locale}.json`), JSON.stringify(texts, null, 1));
    // Lingui: PO catalogs with explicit ids (the js-lingui-explicit-id flag), compiled by @lingui/loader.
    write(join(apps, "lingui", "src", "locales", `${locale}.po`), po(locale));
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  generate();
  console.log(`wrote 200 keys x ${LOCALES.length} locales for 4 apps`);
}
