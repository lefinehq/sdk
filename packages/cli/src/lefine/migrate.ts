/**
 * `lefine migrate`: moves next-intl / @better-i18n code to lefine (docs/strings-migration.md). Text rewrites of the
 * calls that map one to one; everything that needs a person (a locale to pass, a provider, t.raw) is listed, not
 * guessed. Dry run unless --write.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { glob } from "glob";

const CLIENT = /import\s*\{([^}]*)\}\s*from\s*["'](?:next-intl|use-intl|@better-i18n\/use-intl)["'];?/g;
const SERVER = /import\s*\{([^}]*)\}\s*from\s*["']next-intl\/server["'];?/g;

export interface FileResult {
  file: string;
  changed: boolean;
  todo: string[];
}

/** One file's text, rewritten. `lefineImport` is where the app's lefine.ts is imported from. */
export function migrateSource(source: string, lefineImport = "@/lefine"): { text: string; todo: string[] } {
  const todo: string[] = [];
  let text = source.replace(CLIENT, (all, names: string) => {
    const list = names.split(",").map((n) => n.trim()).filter(Boolean);
    const rest = list.filter((n) => n !== "useTranslations");
    for (const n of rest) todo.push(`${n} from next-intl has no lefine equivalent: see "Not one to one" in docs/strings-migration.md.`);
    if (!list.includes("useTranslations")) return all;
    return `import { useStrings } from "lefine/react";${rest.length ? `\nimport { ${rest.join(", ")} } from "next-intl"; // TODO lefine` : ""}`;
  });
  text = text.replace(/\buseTranslations\(/g, "useStrings(");

  let usesServer = false;
  text = text.replace(SERVER, (all, names: string) => {
    const list = names.split(",").map((n) => n.trim()).filter(Boolean);
    if (!list.includes("getTranslations")) return all;
    usesServer = true;
    const rest = list.filter((n) => n !== "getTranslations");
    for (const n of rest) todo.push(`${n} from next-intl/server: see "Not one to one" in docs/strings-migration.md.`);
    return `import { lefine } from "${lefineImport}";${rest.length ? `\nimport { ${rest.join(", ")} } from "next-intl/server"; // TODO lefine` : ""}`;
  });
  if (usesServer) {
    // getTranslations({ locale, namespace: "x" }) and getTranslations("x"): lefine needs the locale explicitly.
    text = text.replace(/getTranslations\(\s*\{\s*locale(?:\s*:\s*([\w.]+))?\s*,\s*namespace\s*:\s*(["'][^"']+["'])\s*\}\s*\)/g, (_a, l: string | undefined, ns: string) => `lefine.getStrings(${l ?? "locale"}, ${ns})`);
    text = text.replace(/getTranslations\(\s*(["'][^"']+["'])?\s*\)/g, (_a, ns: string | undefined) => {
      todo.push("getTranslations() without a locale became lefine.getStrings(locale, ...): make sure `locale` is the [locale] param there.");
      return `lefine.getStrings(locale${ns ? `, ${ns}` : ""})`;
    });
  }
  if (/\bNextIntlClientProvider\b/.test(text)) todo.push("NextIntlClientProvider: replace with <lefine.Provider locale={locale} namespaces={[...]}> in app/[locale]/layout.tsx.");
  if (/\bt\.raw\(/.test(text)) todo.push("t.raw is not supported: keep long or HTML text in lefine/content, or split it into keys.");
  if (/["']@better-i18n\/next["']/.test(text)) todo.push("@better-i18n/next (createI18n, middleware, request config): replace with lefine.ts from `npx lefine init` and proxy.ts.");
  return { text, todo: [...new Set(todo)] };
}

export async function migrateCommand(dir: string | undefined, options: { write?: boolean; lefineImport?: string }): Promise<void> {
  const root = resolve(dir || process.cwd());
  const files = await glob("**/*.{ts,tsx,js,jsx}", { cwd: root, ignore: ["**/node_modules/**", "**/.next/**", "**/dist/**"], absolute: true });
  const results: FileResult[] = [];
  for (const file of files) {
    const source = readFileSync(file, "utf-8");
    if (!/next-intl|use-intl|@better-i18n\//.test(source)) continue;
    const { text, todo } = migrateSource(source, options.lefineImport);
    if (options.write && text !== source) writeFileSync(file, text);
    results.push({ file: relative(root, file), changed: text !== source, todo });
  }
  for (const r of results) {
    console.log(`${r.changed ? (options.write ? "rewrote" : "would rewrite") : "check  "} ${r.file}`);
    for (const t of r.todo) console.log(`    TODO ${t}`);
  }
  console.log(results.length === 0 ? "Nothing uses next-intl or @better-i18n here." : options.write ? "" : "Dry run. Run again with --write to change the files.");
}
