/**
 * Reading exports from other translation tools for `lefine import --from crowdin|lokalise|phrase` (one command to
 * move in). Pure: files in, per-language texts with a review state out. What each tool's export holds comes from its
 * official docs (researched 2026-10-30):
 *
 *   Crowdin   JSON / i18next JSON per language (no review state). Its XLIFF names strings by numeric ids, not keys,
 *             so it cannot be imported: export JSON instead. support.crowdin.com/file-formats/{json,i18next-json,xliff}
 *   Lokalise  flat or nested JSON (no review state; `::` nests; plurals as a JSON string {"one":..}), structured JSON
 *             ({ key: { translation } }), XLIFF 1.2 (trans-unit id = key; target@state). docs.lokalise.com/en/articles/
 *             1400771, 1400773, 3229161, 1400816
 *   Phrase    Strings JSON (per translation: locale_code and state untranslated|unverified|translated|reviewed), simple
 *             / nested / i18next JSON (no state), XLIFF 1.2 (target@state new|translated|signed-off when exported with
 *             include_translation_state). support.phrase.com/hc/en-us/articles/20038313421468, 6111346248860,
 *             6111330881692, 6111346587292
 *
 *   Transifex key-value JSON (ICU strings) and structured JSON ({ "string": ..., "context"?, "developer_comment"? }),
 *             no review state; XLIFF 1.2 (approved="yes|no"), XLIFF 2.0 (no state), PO. Language codes like pt_BR. An
 *             approved-only export is `tx pull --mode onlyproofread` (then --state approved). help.transifex.com/en/
 *             articles/6220899, 6220806, 6222996, 16942119, 6220794
 *   POEditor  `json` export: [ { term, definition (text, or { one, other } for plurals, null when missing), ... } ],
 *             no review state and no language in the file; PO with `#, fuzzy` (POEditor's "needs review").
 *             poeditor.com/docs/api (export), poeditor.com/kb/fuzzy-translations
 *
 * Review state lands in Lefine as: approved (signed off: XLIFF approved="yes", final, signed-off; XLIFF 2 reviewed or
 * final; Phrase reviewed) or reviewed (a person's translation not signed off). Untranslated is left out, never sent
 * as the source text. A format without review state lands as reviewed, or as approved with --state approved (for an
 * export made with the tool's "approved only" filter).
 */

export type Tool = "crowdin" | "lokalise" | "phrase" | "transifex" | "poeditor";
export type ImportState = "reviewed" | "approved";
export const TOOLS: Tool[] = ["crowdin", "lokalise", "phrase", "transifex", "poeditor"];

export interface ExportFile {
  /** The path as found, relative to what was given, with / separators. */
  path: string;
  content: string;
}

/** One language's texts from an export: key (dotted, namespace first) → text and state. */
export interface LocaleTexts {
  locale: string;
  /** Where they came from, for the preview. */
  files: string[];
  texts: Map<string, { text: string; state: ImportState }>;
  /** True for the language the strings were written in (XLIFF source-language). */
  source?: boolean;
}

export class ExportError extends Error {}

const LOCALE = /^[a-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/i;
/** "de", "de-DE", "pt_BR", "zh-hans": a file or folder name that is a language. */
export const isLocaleName = (name: string) => LOCALE.test(name);
const PLURAL_FORMS = ["zero", "one", "two", "few", "many", "other"];

/** {"one": "...", "other": "..."} (an object, or that object as a JSON string) as one ICU plural on `count`. */
export function pluralToIcu(value: unknown): string | null {
  let forms = value;
  if (typeof value === "string" && value.trim().startsWith("{\"")) {
    try {
      forms = JSON.parse(value);
    } catch {
      return null;
    }
  }
  if (!forms || typeof forms !== "object" || Array.isArray(forms)) return null;
  const entries = Object.entries(forms as Record<string, unknown>);
  if (entries.length === 0 || !entries.every(([k, v]) => PLURAL_FORMS.includes(k) && typeof v === "string") || !Object.hasOwn(forms, "other")) return null;
  const branches = PLURAL_FORMS.filter((f) => Object.hasOwn(forms, f)).map((f) => `${f === "zero" ? "=0" : f} {${(forms as Record<string, string>)[f]}}`);
  return `{count, plural, ${branches.join(" ")}}`;
}

/** A JSON value's leaves as dotted keys. Plural objects become one ICU text; `::` (Lokalise nesting) becomes a dot. */
function flatten(value: unknown, prefix: string, out: Map<string, string>): void {
  if (typeof value === "string") {
    out.set(prefix, pluralToIcu(value) ?? value);
    return;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    out.set(prefix, String(value));
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const plural = pluralToIcu(value);
  if (plural && prefix) {
    out.set(prefix, plural);
    return;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const key = k.split(":::").join(".").split("::").join(".");
    flatten(v, prefix ? `${prefix}.${key}` : key, out);
  }
}

const parseJson = (file: ExportFile): unknown => {
  try {
    return JSON.parse(file.content);
  } catch {
    throw new ExportError(`${file.path} is not valid JSON.`);
  }
};

const decodeXml = (text: string) =>
  text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&amp;/g, "&");
const attr = (attrs: string, name: string) => new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`).exec(attrs)?.[1] ?? new RegExp(`(?:^|\\s)${name}\\s*=\\s*'([^']*)'`).exec(attrs)?.[1];
const inner = (body: string, tag: string) => {
  const m = new RegExp(`<${tag}(\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(body);
  return m ? { attrs: m[1] ?? "", text: m[2] ?? "" } : null;
};

/** XLIFF 1.2 trans-units or XLIFF 2 units: key, source, target, state. */
export function readXliff(file: ExportFile): { source: string | null; target: string | null; units: Array<{ key: string; source: string | null; target: string | null; state: ImportState | "untranslated" }> } {
  const text = file.content.replace(/<!--[\s\S]*?-->/g, "");
  const root = /<xliff(\s[^>]*)?>/.exec(text);
  if (!root) throw new ExportError(`${file.path} is not XLIFF: there is no <xliff> element.`);
  const version2 = /version\s*=\s*["']2/.test(root[1] ?? "");
  const fileAttrs = /<file(\s[^>]*)?>/.exec(text)?.[1] ?? "";
  const source = (version2 ? attr(root[1] ?? "", "srcLang") : attr(fileAttrs, "source-language")) ?? null;
  const target = (version2 ? attr(root[1] ?? "", "trgLang") : attr(fileAttrs, "target-language")) ?? null;
  const units: Array<{ key: string; source: string | null; target: string | null; state: ImportState | "untranslated" }> = [];
  const unitRe = version2 ? /<unit(\s[^>]*)?>([\s\S]*?)<\/unit>/g : /<trans-unit(\s[^>]*)?>([\s\S]*?)<\/trans-unit>/g;
  for (const m of text.matchAll(unitRe)) {
    const attrs = m[1] ?? "";
    const body = m[2] ?? "";
    const key = attr(attrs, "resname") ?? attr(attrs, "id") ?? "";
    const src = inner(body, "source");
    const tgt = inner(body, "target");
    const targetText = tgt && tgt.text.trim() !== "" ? decodeXml(tgt.text) : null;
    let state: ImportState | "untranslated";
    if (version2) {
      const segState = attr(inner(body, "segment")?.attrs ?? /<segment(\s[^>]*)?>/.exec(body)?.[1] ?? "", "state");
      state = targetText === null || segState === "initial" ? (targetText === null ? "untranslated" : "reviewed") : segState === "final" || segState === "reviewed" ? "approved" : "reviewed";
    } else {
      const s = tgt ? attr(tgt.attrs, "state") : undefined;
      if (targetText === null || s === "needs-translation") state = "untranslated";
      else if (attr(attrs, "approved") === "yes" || s === "final" || s === "signed-off") state = "approved";
      else state = "reviewed";
    }
    units.push({ key: key.split("::").join("."), source: src ? decodeXml(src.text) : null, target: targetText, state });
  }
  return { source, target, units: collapsePluralGroups(units) };
}

/**
 * XLIFF plural groups (Crowdin, Transifex: units `4[0]`, `4[1]`) as one ICU plural. The index order follows the
 * file's own plural formula, so only the two-form case (one, other) is mapped; more forms stay as they are and the
 * caller reports them.
 */
function collapsePluralGroups<T extends { key: string; source: string | null; target: string | null; state: ImportState | "untranslated" }>(units: T[]): T[] {
  const out: T[] = [];
  const groups = new Map<string, T[]>();
  for (const u of units) {
    const m = /^(.+)\[(\d+)\]$/.exec(u.key);
    if (!m) {
      out.push(u);
      continue;
    }
    if (!groups.has(m[1]!)) groups.set(m[1]!, []);
    groups.get(m[1]!)![Number(m[2])] = u;
  }
  for (const [key, forms] of groups) {
    const list = forms.filter(Boolean);
    if (list.length !== 2) {
      out.push(...list);
      continue;
    }
    const [one, other] = list as [T, T];
    const icu = (a: string | null, b: string | null) => (a !== null && b !== null ? `{count, plural, one {${a}} other {${b}}}` : null);
    const untranslated = one.state === "untranslated" || other.state === "untranslated";
    const state = untranslated ? "untranslated" : one.state === "approved" && other.state === "approved" ? "approved" : "reviewed";
    out.push({ ...one, key, source: icu(one.source, other.source), target: untranslated ? null : icu(one.target, other.target), state } as T);
  }
  return out;
}

/** One gettext PO file: header language and plural count, entries with their forms and fuzzy flag. */
export function readPo(file: ExportFile): { language: string | null; nplurals: number | null; entries: Array<{ context: string | null; id: string; forms: string[]; plural: boolean; fuzzy: boolean }> } {
  const unquote = (raw: string) =>
    raw.replace(/\\(n|t|r|"|\\)/g, (_, c: string) => ({ n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" })[c] ?? c);
  const entries: Array<{ context: string | null; id: string; forms: string[]; plural: boolean; fuzzy: boolean }> = [];
  let header: string | null = null;
  for (const block of file.content.replace(/\r\n?/g, "\n").split(/\n\s*\n/)) {
    const lines = block.split("\n").filter((l) => l.trim() !== "");
    if (lines.length === 0 || lines.every((l) => l.startsWith("#~") || l.startsWith("#"))) continue;
    const fuzzy = lines.some((l) => /^#,.*\bfuzzy\b/.test(l));
    const fields = new Map<string, string>();
    let current: string | null = null;
    for (const line of lines) {
      if (line.startsWith("#")) continue;
      const m = /^(msgctxt|msgid_plural|msgid|msgstr(?:\[\d+\])?)\s+"(.*)"\s*$/.exec(line);
      if (m) {
        current = m[1]!;
        fields.set(current, unquote(m[2]!));
        continue;
      }
      const more = /^"(.*)"\s*$/.exec(line);
      if (more && current) fields.set(current, fields.get(current)! + unquote(more[1]!));
    }
    if (!fields.has("msgid")) continue;
    const id = fields.get("msgid")!;
    if (id === "" && !fields.has("msgctxt")) {
      header = fields.get("msgstr") ?? "";
      continue;
    }
    const plural = fields.has("msgid_plural");
    const forms = plural
      ? [...fields.keys()].filter((k) => /^msgstr\[\d+\]$/.test(k)).sort((a, b) => Number(a.slice(7, -1)) - Number(b.slice(7, -1))).map((k) => fields.get(k)!)
      : [fields.get("msgstr") ?? ""];
    entries.push({ context: fields.get("msgctxt") ?? null, id, forms, plural, fuzzy });
  }
  const language = header ? (/^Language:\s*(\S+)/m.exec(header)?.[1] ?? null) : null;
  const n = header ? /nplurals\s*=\s*(\d+)/.exec(header)?.[1] : undefined;
  return { language, nplurals: n ? Number(n) : null, entries };
}

const baseName = (path: string) => path.split("/").pop()!.replace(/\.(json|xlf|xliff|po)$/i, "");
const parentName = (path: string) => path.split("/").slice(-2, -1)[0] ?? "";

/**
 * The language and namespace a JSON file is for, from its place: `de.json` / `de-DE.json` (keys start with their
 * namespace), `de/common.json` (i18next layout: the file is the namespace), `locale/de.json`.
 */
function placeOf(path: string): { locale: string; namespace: string | null } | null {
  const base = baseName(path).replace(/\.(i18next|structured)$/i, "");
  if (isLocaleName(base)) return { locale: base, namespace: null };
  const parent = parentName(path);
  if (isLocaleName(parent)) return { locale: parent, namespace: base.replace(/-[a-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/i, "") || base };
  return null;
}

/** Key segments that name JavaScript's object machinery: never a translation key, and unsafe to build objects with. */
const UNSAFE_SEGMENT = new Set(["__proto__", "constructor", "prototype"]);
export const isSafeKey = (key: string) => !key.startsWith(".") && key.split(".").every((part) => !UNSAFE_SEGMENT.has(part));

const add = (byLocale: Map<string, LocaleTexts>, locale: string, file: string, key: string, text: string, state: ImportState, source = false) => {
  if (!isSafeKey(key)) return;
  const canonical = locale.replace(/_/g, "-");
  const found: LocaleTexts = byLocale.get(canonical.toLowerCase()) ?? { locale: canonical, files: [], texts: new Map(), ...(source ? { source: true } : {}) };
  if (!found.files.includes(file)) found.files.push(file);
  found.texts.set(key, { text, state });
  byLocale.set(canonical.toLowerCase(), found);
};

/** Is this a Phrase Strings JSON: { name: { key: {...}, translations: [ { locale_code, content, state } ] } }? */
const isPhraseStringsJson = (value: unknown) =>
  !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).some((v) => v && typeof v === "object" && Array.isArray((v as { translations?: unknown }).translations));

const TX_LEAF_KEYS = new Set(["string", "context", "developer_comment", "character_limit"]);
/** A Transifex structured JSON leaf: { "string": "...", "context"?, "developer_comment"?, "character_limit"? }. */
const isTxLeaf = (v: unknown) => !!v && typeof v === "object" && !Array.isArray(v) && typeof (v as { string?: unknown }).string === "string" && Object.keys(v).every((k) => TX_LEAF_KEYS.has(k));
const isTransifexStructured = (value: unknown): boolean => {
  const walk = (v: unknown): boolean => isTxLeaf(v) || (!!v && typeof v === "object" && !Array.isArray(v) && Object.values(v).some(walk));
  return !!value && typeof value === "object" && Object.values(value).some((v) => isTxLeaf(v) || walk(v));
};
function flattenStructured(value: unknown, prefix: string, out: Map<string, string>): void {
  if (isTxLeaf(value)) {
    out.set(prefix, (value as { string: string }).string);
    return;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) flattenStructured(v, prefix ? `${prefix}.${k}` : k, out);
}

/** Is this a Lokalise structured JSON: { key: { translation, notes?, ... } }? */
const isStructuredJson = (value: unknown) =>
  !!value && typeof value === "object" && !Array.isArray(value) && Object.values(value).length > 0 && Object.values(value).every((v) => v && typeof v === "object" && !Array.isArray(v) && "translation" in (v as object));

/**
 * Every language's texts in an export of `tool`. `defaultState` is what a format without review state lands as.
 * Throws an ExportError that says what to export instead when a file cannot be read.
 */
export function readExport(
  tool: Tool,
  files: ExportFile[],
  options: {
    defaultState?: ImportState;
    namespace?: string;
    /** The language of a file that does not say (POEditor's JSON, an XLIFF with no target language). */
    locale?: string;
    /** PO entries marked fuzzy (POEditor: "needs review") come in as reviewed instead of being left out. */
    includeFuzzy?: boolean;
    /** What was left out and why, for the caller to show. */
    report?: string[];
  } = {},
): LocaleTexts[] {
  const report = options.report ?? [];
  const fallback = options.defaultState ?? "reviewed";
  const byLocale = new Map<string, LocaleTexts>();
  const withNamespace = (key: string, namespace: string | null) => (namespace ? `${namespace}.${key}` : key.includes(".") ? key : `${options.namespace ?? "common"}.${key}`);
  for (const file of files) {
    if (/\.(xlf|xliff)$/i.test(file.path) || /^\s*(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<xliff/i.test(file.content)) {
      if (tool === "crowdin") {
        throw new ExportError(`${file.path}: Crowdin's XLIFF names strings by number, not by key, so the keys cannot be recovered. In Crowdin, download the translations as JSON (or i18next JSON) and import that folder.`);
      }
      const x = readXliff(file);
      const targetLocale = x.target ?? placeOf(file.path)?.locale ?? options.locale;
      if (!targetLocale) throw new ExportError(`${file.path}: the XLIFF names no target language (target-language / trgLang). Say which: --locale <code>.`);
      const namespace = null;
      for (const u of x.units) {
        if (!u.key) continue;
        const key = withNamespace(u.key, namespace);
        // The tool's base language: reviewed here; if it is the app's source language, Lefine makes it approved itself.
        if (x.source && u.source !== null) add(byLocale, x.source, file.path, key, pluralToIcu(u.source) ?? u.source, "reviewed", true);
        if (/\[\d+\]$/.test(u.key)) {
          report.push(`${file.path}: plural ${u.key.replace(/\[\d+\]$/, "")} has more than two forms; left out (its form order follows the file's plural formula).`);
          continue;
        }
        if (u.state === "untranslated" || u.target === null) continue;
        add(byLocale, targetLocale, file.path, key, pluralToIcu(u.target) ?? u.target, u.state);
      }
      continue;
    }
    if (/\.po$/i.test(file.path)) {
      const po = readPo(file);
      const place = placeOf(file.path.replace(/\.po$/i, ".json"));
      const locale = place?.locale ?? po.language ?? options.locale;
      if (!locale) throw new ExportError(`${file.path}: no language in its name or its Language header. Say which: --locale <code>.`);
      // Gettext keys are often whole sentences, dots included: one namespace per file, the msgid kept whole.
      const namespace = place?.namespace ?? (isLocaleName(baseName(file.path)) ? null : baseName(file.path)) ?? options.namespace ?? "common";
      const seen = new Set<string>();
      let fuzzy = 0;
      for (const e of po.entries) {
        if (e.fuzzy && !options.includeFuzzy) {
          fuzzy++;
          continue;
        }
        let text: string | null;
        if (!e.plural) text = e.forms[0] ?? "";
        else if (e.forms.some((f) => f === "")) text = "";
        else if (e.forms.length === 1) text = `{count, plural, other {${e.forms[0]}}}`;
        else if (e.forms.length === 2) text = `{count, plural, one {${e.forms[0]}} other {${e.forms[1]}}}`;
        else {
          report.push(`${file.path}: plural "${e.id}" has ${e.forms.length} forms; left out (their order follows the file's Plural-Forms formula).`);
          continue;
        }
        if (!text) continue;
        let name = e.id;
        if (seen.has(name) && e.context) name = `${e.id} [${e.context}]`;
        seen.add(name);
        add(byLocale, locale, file.path, `${namespace}.${name}`, text, "reviewed");
      }
      if (fuzzy > 0) report.push(`${file.path}: ${fuzzy} fuzzy ${fuzzy === 1 ? "entry" : "entries"} (needs review in the tool) left out; --include-fuzzy brings them in as reviewed.`);
      continue;
    }
    if (!/\.json$/i.test(file.path)) continue;
    const value = parseJson(file);
    if (tool === "poeditor" && Array.isArray(value)) {
      const place = placeOf(file.path);
      const locale = place?.locale ?? options.locale;
      if (!locale) throw new ExportError(`${file.path}: POEditor's JSON export does not say its language. Name the file for it (fr.json) or pass --locale <code>.`);
      for (const term of value as Array<{ term?: unknown; definition?: unknown }>) {
        if (typeof term?.term !== "string" || term.term === "") continue;
        const text = typeof term.definition === "string" ? term.definition : pluralToIcu(term.definition);
        if (!text) continue;
        add(byLocale, locale, file.path, withNamespace(term.term, place?.namespace ?? null), text, fallback);
      }
      continue;
    }
    if (tool === "phrase" && isPhraseStringsJson(value)) {
      for (const [name, entry] of Object.entries(value as Record<string, { translations: Array<{ locale_code?: string; locale?: string; content?: unknown; state?: string }> }>)) {
        for (const t of entry.translations ?? []) {
          const locale = t.locale_code ?? (isLocaleName(t.locale ?? "") ? t.locale : undefined);
          if (!locale || t.state === "untranslated") continue;
          const text = typeof t.content === "string" ? t.content : pluralToIcu(t.content);
          if (text === null || text === undefined || text === "") continue;
          add(byLocale, locale, file.path, withNamespace(name, null), text, t.state === "reviewed" ? "approved" : "reviewed");
        }
      }
      continue;
    }
    const place = placeOf(file.path) ?? (options.locale ? { locale: options.locale, namespace: null } : null);
    if (!place) throw new ExportError(`${file.path}: cannot tell its language from the name. Name it de.json, de-DE.json or de/common.json (the tool's export does this), or pass --locale <code>.`);
    const texts = new Map<string, string>();
    if (tool === "transifex" && isTransifexStructured(value)) {
      flattenStructured(value, "", texts);
    } else if (tool === "lokalise" && isStructuredJson(value)) {
      for (const [k, v] of Object.entries(value as Record<string, { translation: unknown }>)) flatten(v.translation, k.split("::").join("."), texts);
    } else {
      flatten(value, "", texts);
    }
    for (const [key, text] of texts) if (text !== "") add(byLocale, place.locale, file.path, withNamespace(key, place.namespace), text, fallback);
  }
  return [...byLocale.values()];
}
