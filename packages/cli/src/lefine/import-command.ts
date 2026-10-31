/**
 * `lefine import <file|folder> --from crowdin|lokalise|phrase|transifex|poeditor`: a team moves in from another translation tool in one
 * command. The export is read here (tms-import.ts: keys, texts per language, review state), then each language goes
 * through the same preview, question and import as `lefine strings push`, the source language first. A target
 * language arrives in up to two imports, one per state (reviewed, approved), so what was signed off stays signed off.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { confirm } from "@inquirer/prompts";
import { dim, yellow } from "../utils/colors.js";
import { fail, out } from "./auth-commands.js";
import { safeText as s } from "./safe-text.js";
import { canonicalLocale, openSession, pushOne, resolveTarget, type Ask, type PushResult, type StringsOptions } from "./strings-commands.js";
import { type ExportFile, ExportError, type ImportState, readExport, TOOLS, type Tool } from "./tms-import.js";

export interface ImportOptions extends StringsOptions {
  from?: string;
  /** Namespace for keys with no dot (default common). */
  namespace?: string;
  /** What a format without review state lands as: reviewed (default) or approved (an "approved only" export). */
  state?: string;
  /** The language of a file that does not say (POEditor JSON, an XLIFF without a target language). */
  locale?: string;
  /** PO entries marked fuzzy come in as reviewed instead of being left out. */
  includeFuzzy?: boolean;
}

const MAX_FILES = 500;
const MAX_BYTES = 50_000_000;

/** The export's JSON and XLIFF files: one file, or a folder walked (no node_modules, no dot folders). */
export function collectExport(path: string): ExportFile[] {
  const root = resolve(path);
  const stat = statSync(root, { throwIfNoEntry: false });
  if (!stat) throw new Error(`Not found: ${s(path)}.`);
  const files: ExportFile[] = [];
  let bytes = 0;
  const take = (full: string, rel: string) => {
    if (!/\.(json|xlf|xliff|po)$/i.test(full)) return;
    if (files.length >= MAX_FILES) throw new Error(`More than ${MAX_FILES} files in ${s(path)}. Import one export at a time.`);
    const content = readFileSync(full, "utf-8");
    bytes += content.length;
    if (bytes > MAX_BYTES) throw new Error(`${s(path)} is over ${MAX_BYTES / 1_000_000} MB. Import one export at a time.`);
    files.push({ path: rel.split(/[\\/]/).join("/"), content });
  };
  if (stat.isFile()) {
    take(root, root.split(/[\\/]/).pop()!);
    return files;
  }
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      if (name.startsWith(".") || name === "node_modules") continue;
      const full = join(dir, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (st.isFile()) take(full, relative(root, full));
    }
  };
  walk(root);
  return files;
}

/** `{ "nav.save": text }` → `{ nav: { save: text } }` by the first dot: the import takes one namespace per file. */
function byNamespace(texts: Map<string, string>): Record<string, Record<string, string>> {
  // No prototype on any of them, and readExport already dropped __proto__ / constructor / prototype segments: an
  // export's key can only ever be a plain property.
  const out: Record<string, Record<string, string>> = Object.create(null);
  for (const [key, text] of texts) {
    const dot = key.indexOf(".");
    const ns = key.slice(0, dot);
    const space = Object.hasOwn(out, ns) ? out[ns]! : (out[ns] = Object.create(null) as Record<string, string>);
    space[key.slice(dot + 1)] = text;
  }
  return out;
}

export async function importCommand(path: string, options: ImportOptions, ask: Ask = confirm): Promise<void> {
  try {
    const tool = options.from as Tool;
    if (!TOOLS.includes(tool)) throw new Error(`--from takes ${TOOLS.join(", ")}.`);
    if (options.state && options.state !== "reviewed" && options.state !== "approved") throw new Error("--state takes reviewed or approved.");
    const files = collectExport(path);
    if (files.length === 0) throw new Error(`No JSON, XLIFF or PO file in ${s(path)}.`);
    const report: string[] = [];
    const languages = readExport(tool, files, {
      defaultState: (options.state as ImportState | undefined) ?? "reviewed",
      namespace: options.namespace,
      ...(options.locale ? { locale: canonicalLocale(options.locale) } : {}),
      includeFuzzy: options.includeFuzzy === true,
      report,
    });
    if (languages.length === 0) throw new Error(`${s(path)} holds no translated text.`);

    const session = await openSession(options, await resolveTarget(options));
    const appSource = canonicalLocale(session.app.sourceLocale);
    const appLocales = [appSource, ...session.app.targetLocales.map(canonicalLocale)];
    const lower = (l: string) => l.toLowerCase();
    /** The app's language for an export language: exact, else its base language (de-DE → de) when the app has that. */
    const matchLocale = (raw: string): string | null => {
      const tag = canonicalLocale(raw);
      const exact = appLocales.find((l) => lower(l) === lower(tag));
      if (exact) return exact;
      const base = tag.split("-")[0]!;
      return appLocales.find((l) => lower(l) === lower(base)) ?? null;
    };

    const skipped: string[] = [];
    const notes: string[] = [];
    const plan: Array<{ locale: string; files: string[]; byState: Map<ImportState, Map<string, string>> }> = [];
    for (const lang of languages) {
      const locale = matchLocale(lang.locale);
      if (!locale) {
        skipped.push(lang.locale);
        continue;
      }
      if (lower(locale) !== lower(canonicalLocale(lang.locale))) notes.push(`${lang.locale} → ${locale}`);
      let entry = plan.find((p) => p.locale === locale);
      if (!entry) plan.push((entry = { locale, files: [], byState: new Map() }));
      entry.files.push(...lang.files.filter((f) => !entry!.files.includes(f)));
      for (const [key, { text, state }] of lang.texts) {
        const st: ImportState = locale === appSource ? "approved" : state;
        if (!entry.byState.has(st)) entry.byState.set(st, new Map());
        entry.byState.get(st)!.set(key, text);
      }
    }
    plan.sort((a, b) => Number(b.locale === appSource) - Number(a.locale === appSource));

    if (!options.json) {
      console.log();
      console.log(`  ${s(tool)} export: ${files.length} file${files.length === 1 ? "" : "s"}, ${languages.length} language${languages.length === 1 ? "" : "s"}.`);
      for (const n of notes) console.log(dim(`  ${s(n)}: the app has the language, not that region.`));
      for (const line of report) console.log(yellow(`  ${s(line)}`));
      if (skipped.length > 0) console.log(yellow(`  Skipped ${skipped.map(s).join(", ")}: not a language of this app. Add one with \`lefine strings languages add <locale>\`.`));
      if (!plan.some((p) => p.locale === appSource)) console.log(yellow(`  No ${s(appSource)} (the app's source language) in the export: new keys would come with no source text.`));
    }

    const results: Array<PushResult & { state: ImportState }> = [];
    for (const entry of plan) {
      for (const state of ["approved", "reviewed"] as const) {
        const texts = entry.byState.get(state);
        if (!texts || texts.size === 0) continue;
        const label = entry.locale === appSource ? `${entry.files.join(", ")}` : `${entry.files.join(", ")} (${state})`;
        const result = await pushOne(session, { locale: entry.locale, messages: byNamespace(texts) as never, path: label }, null, options, ask, state);
        results.push({ ...result, state });
        if (result.bad.length > 0) break;
      }
      if (results.some((r) => r.bad.length > 0)) break;
    }
    const bad = results.some((r) => r.bad.length > 0);
    out(options.json, { applied: !bad && results.some((r) => r.applied), languages: results.map(({ bad: _, ...r }) => r), skipped, mapped: notes, leftOut: report }, () => {});
    if (bad) process.exit(1);
  } catch (err) {
    fail(err instanceof ExportError ? new Error(err.message) : err, options.json);
  }
}
