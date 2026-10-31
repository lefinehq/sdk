/**
 * `lefine strings pull | push | check | publish | status`.
 *
 * Everything that changes data goes through the shared actions
 * (`strings.*` at `POST /v1/ops/:name`). `pull` reads the public CDN and
 * reuses the existing v2 pull (manifest, sha256, never writes `{}`).
 */

import { randomUUID } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { confirm } from "@inquirer/prompts";
import type { Issue, ProjectContext } from "../analyzer/types.js";
import { pullCommand } from "../commands/pull.js";
import { detectProjectContext } from "../context/detector.js";
import { bold, cyan, dim, green, red, yellow } from "../utils/colors.js";
import { getSummary } from "../utils/key-comparison.js";
import type { RemoteTranslations } from "../utils/json-keys.js";
import { fail, openInBrowser, out, type GlobalOptions } from "./auth-commands.js";
import { callWithApproval, LefineError, createOpClient, getMe, type OpClient } from "./client.js";
import { DEFAULT_CDN_URL, resolveLefineAuth } from "./credentials.js";
import { githubActionsAuth } from "./github-oidc.js";
import { safeText } from "./safe-text.js";
import { detectBinding, fetchSourceKeys, renderStringsTypes, type TypesBinding } from "./strings-types.js";
import {
  NOTHING_TO_PUBLISH,
  itemsOf,
  type AppSummary,
  type ChangeItem,
  type CheckPage,
  type DeliveryChecks,
  type ImportFileInput,
  type ImportPreview,
  type ReleasePreview,
  type Run,
  type RunOutput,
} from "./types.js";

export interface StringsOptions extends GlobalOptions {
  project?: string;
  dir?: string;
  yes?: boolean;
}

// ── Shared plumbing ────────────────────────────────────────────────────

export interface Target {
  /** The app's id: what --project and lefine.ts name. Never changes. */
  appId?: string;
  /** The name alias (workspace/app slugs, from --project or i18n.config.ts): checked against the key's workspace. */
  workspace: string;
  app: string;
  context: ProjectContext | null;
  rootDir: string;
}

const APP_ID = /^app_[a-z0-9]{3,64}$/;

/** The app id `npx lefine init` wrote into lefine.ts (or src/lefine.ts), if any. */
function appIdFromLefineFile(rootDir: string): string | undefined {
  for (const file of ["lefine.ts", "src/lefine.ts"]) {
    const path = resolve(rootDir, file);
    if (!existsSync(path)) continue;
    const id = /project:\s*["'](app_[a-z0-9]{3,64})["']/.exec(readFileSync(path, "utf-8"))?.[1];
    if (id) return id;
  }
  return undefined;
}

/** The app: --project (its id, or the workspace/app alias), else lefine.ts, else i18n.config.ts. */
export async function resolveTarget(options: StringsOptions): Promise<Target> {
  const rootDir = resolve(options.dir || process.cwd());
  if (options.project) {
    const context = await detectProjectContext(rootDir, false);
    if (APP_ID.test(options.project)) return { appId: options.project, workspace: "", app: options.project, context, rootDir };
    const [workspace, app, ...rest] = options.project.split("/");
    if (!workspace || !app || rest.length > 0) {
      throw new Error(`Invalid project "${s(options.project)}". Use the app id (app_..., see \`lefine apps\`), or workspace/app as an alias.`);
    }
    return { workspace, app, context, rootDir };
  }
  const context = await detectProjectContext(rootDir, false);
  const fromFile = appIdFromLefineFile(rootDir);
  if (fromFile) return { appId: fromFile, workspace: "", app: fromFile, context, rootDir };
  if (!context) {
    throw new Error("No app found. Run `npx lefine init`, or pass --project with the app id (see `lefine apps`).");
  }
  return { workspace: context.workspaceId, app: context.projectSlug, context, rootDir };
}

/** How a command names the app it works on: the name, and the id that never changes. */
export const appLabel = (session: Session): string => `${session.app.name} (${session.app.id})`;

export interface Session {
  ops: OpClient;
  /** The app's id in the key's workspace. */
  appId: string;
  app: AppSummary;
}

/**
 * The key decides the workspace on the server, the config only names one. Before
 * anything is read or written, check they are the same, then find the app.
 */
export async function openSession(options: StringsOptions, target: Target): Promise<Session> {
  // No key given: in GitHub Actions, the run's own OIDC token signs in to the app it names (no stored secret).
  const auth = resolveLefineAuth(options) ?? (target.appId ? await githubActionsAuth(target.appId, options) : null);
  if (!auth) throw new LefineError("UNAUTHORIZED", "no key");
  if (target.appId) {
    // An id names one app: the key's own app list says whether this key reaches it.
    const ops = createOpClient(auth.apiUrl, auth.token);
    const app = itemsOf<AppSummary>(await ops.callOp("strings.apps.list", {})).find((a) => a.id === target.appId);
    if (!app) throw new LefineError("NOT_FOUND", `no app ${target.appId} for this key (see \`lefine apps\`, or \`lefine login\` for another workspace)`);
    return { ops, appId: app.id, app };
  }
  const me = await getMe(auth.apiUrl, auth.token);
  if (target.workspace !== me.workspace.slug && target.workspace !== me.workspace.id) {
    throw new Error(
      `Your key is for workspace ${safeText(me.workspace.slug)}, but this project is ${safeText(target.workspace)}/${safeText(target.app)}. Run \`lefine login\` and pick ${safeText(target.workspace)}.`,
    );
  }
  const ops = createOpClient(auth.apiUrl, auth.token);
  const apps = itemsOf<AppSummary>(await ops.callOp("strings.apps.list", {}));
  const app = apps.find((a) => a.slug === target.app);
  if (!app) {
    throw new LefineError("NOT_FOUND", `no app "${target.app}" in workspace ${me.workspace.slug}`);
  }
  return { ops, appId: app.id, app };
}

export type Ask = (config: { message: string; default?: boolean }) => Promise<boolean>;

/** Ask in a terminal; refuse in CI where nobody can answer. */
export async function confirmOrExplain(question: string, options: StringsOptions, ask: Ask = confirm): Promise<boolean> {
  if (options.yes) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY || options.json) {
    throw new Error("This changes your workspace and needs confirmation. Run it again with --yes.");
  }
  return ask({ message: question, default: false });
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const s = safeText;
/** A count from the server, printed as a number or not at all. */
const num = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

export interface SourceFileOptions {
  /** Source locale file; default `<pull.output or ./locales>/<defaultLocale>.json`. */
  file?: string;
  locale?: string;
}

/** "zh-hans" or "pt_br" as the canonical BCP 47 tag the API takes ("zh-Hans", "pt-BR"). */
export function canonicalLocale(tag: string): string {
  const raw = tag.trim().replace(/_/g, "-");
  try {
    return Intl.getCanonicalLocales(raw)[0] ?? raw;
  } catch {
    throw new Error(`"${s(tag)}" is not a language tag. Use one like en, de, pt-BR or zh-Hans.`);
  }
}

function readSource(target: Target, options: SourceFileOptions): { locale: string; messages: RemoteTranslations; path: string } {
  const locale = canonicalLocale(options.locale || target.context?.defaultLocale || "en");
  // Files are named in lower case, as the CDN serves them (zh-hans.json); the API takes the
  // canonical tag (zh-Hans).
  const path = options.file
    ? resolve(options.file)
    : resolve(target.rootDir, target.context?.pull?.output || "./locales", `${locale.toLowerCase()}.json`);
  if (!existsSync(path)) {
    throw new Error(`Source file not found: ${path}. Pass --file, or run \`lefine strings pull\` first.`);
  }
  let messages: unknown;
  try {
    messages = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    throw new Error(`${path} is not valid JSON.`);
  }
  if (!messages || typeof messages !== "object" || Array.isArray(messages)) {
    throw new Error(`${path} must be a JSON object of namespaces.`);
  }
  return { locale, messages: messages as RemoteTranslations, path };
}

// ── pull ───────────────────────────────────────────────────────────────

export interface PullStringsOptions extends StringsOptions {
  output?: string;
  locales?: string;
  cdnUrl?: string;
  since?: string;
  verbose?: boolean;
}

export async function stringsPullCommand(options: PullStringsOptions): Promise<void> {
  try {
    const rootDir = resolve(options.dir || process.cwd());
    const context = options.project ? null : await detectProjectContext(rootDir, false);
    await pullCommand({
      ...options,
      cdnUrl: options.cdnUrl || process.env.LEFINE_CDN_URL || context?.cdnBaseUrl || DEFAULT_CDN_URL,
    });
  } catch (err) {
    fail(err, options.json);
  }
}

// ── push ───────────────────────────────────────────────────────────────

export interface PushOptions extends StringsOptions, SourceFileOptions {
  /** For a YAML, XLIFF, Android XML or .properties file: the namespace it goes into (default: the file's name). */
  namespace?: string;
  /** Push every language file in this folder (true: `<pull.output or ./locales>`), the source first. */
  all?: string | boolean;
}

/** Files Lefine reads besides JSON (#77). The CLI sends them as they are; the API's own parsers read them. */
const OTHER_FORMATS = /\.(ya?ml|xml|xlf|xliff|properties)$/i;

/**
 * A non-JSON source file as one import: the whole file, under one namespace. The namespace is --namespace, else the
 * file's name (`common.yaml` -> common); a file named for its language (`de.xml`) needs --namespace.
 */
function otherFormatInput(target: Target, options: PushOptions, appId: string): ImportFileInput | null {
  if (!options.file || !OTHER_FORMATS.test(options.file)) return null;
  const path = resolve(options.file);
  if (!existsSync(path)) throw new Error(`Source file not found: ${path}.`);
  const locale = canonicalLocale(options.locale || target.context?.defaultLocale || "en");
  const fileName = path.split(/[\\/]/).pop()!;
  const base = fileName.replace(OTHER_FORMATS, "");
  const named = /^[a-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/i.test(base) && canonicalLocale(base).toLowerCase() === base.replace(/_/g, "-").toLowerCase();
  const namespace = options.namespace ?? (named ? null : base);
  if (!namespace) throw new Error(`${fileName} is named for a language. Say which namespace it goes into: --namespace <name>.`);
  return { appId, locale, namespace, fileName, content: readFileSync(path, "utf-8") };
}

interface NamespacePlan {
  namespace: string;
  input: ImportFileInput;
  preview: ImportPreview;
}

export interface PushSource {
  locale: string;
  messages: RemoteTranslations;
  path: string;
}

export interface PushResult {
  locale: string;
  applied: boolean;
  tally: { created: number; updated: number; skipped: number; dropped: number };
  runs: Run[];
  /** Runs that did not finish cleanly. */
  bad: Run[];
}

export async function stringsPushCommand(options: PushOptions, ask: Ask = confirm): Promise<void> {
  try {
    const target = await resolveTarget(options);
    const session = await openSession(options, target);
    if (options.all !== undefined) return await pushAll(target, session, options, ask);
    const other = otherFormatInput(target, options, session.appId);
    const source = other ? { locale: other.locale, messages: {} as RemoteTranslations, path: resolve(options.file!) } : readSource(target, options);
    const result = await pushOne(session, source, other, options, ask);
    out(options.json, { applied: result.applied, tally: result.tally, ...(result.runs.length ? { runs: result.runs } : {}) }, () => {});
    if (result.bad.length > 0) process.exit(1);
  } catch (err) {
    fail(err, options.json);
  }
}

/** A file or folder name that is a language tag: `de`, `pt-br`, `pt_BR`, `zh-hans`. */
function localeName(name: string): string | null {
  if (!/^[a-z]{2,3}([-_][A-Za-z0-9]{2,8})*$/i.test(name)) return null;
  try {
    return canonicalLocale(name);
  } catch {
    return null;
  }
}

/**
 * Every language file in a folder, as push reads them: `de.json` holding `{ namespace: { key: text } }` (what pull
 * writes, and next-intl's `messages/de.json`), or i18next's `de/common.json`, one file per namespace.
 */
export function readLocaleFolder(folder: string): PushSource[] {
  if (!existsSync(folder) || !statSync(folder).isDirectory()) throw new Error(`Folder not found: ${folder}. Pass it: --all <folder>.`);
  const found = new Map<string, PushSource>();
  const asObject = (file: string): Record<string, unknown> => {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(file, "utf-8"));
    } catch {
      throw new Error(`${s(file)} is not valid JSON.`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${s(file)} must be a JSON object.`);
    return value as Record<string, unknown>;
  };
  for (const entry of readdirSync(folder).sort()) {
    const full = join(folder, entry);
    if (entry.endsWith(".json") && statSync(full).isFile()) {
      const locale = localeName(entry.slice(0, -5));
      if (!locale) continue;
      if (found.has(locale)) throw new Error(`Two files for ${s(locale)} in ${s(folder)}. Keep one.`);
      found.set(locale, { locale, messages: asObject(full) as RemoteTranslations, path: full });
    } else if (statSync(full).isDirectory()) {
      const locale = localeName(entry);
      if (!locale) continue;
      if (found.has(locale)) throw new Error(`Two files for ${s(locale)} in ${s(folder)}. Keep one.`);
      const messages: Record<string, unknown> = {};
      for (const file of readdirSync(full).sort()) {
        if (file.endsWith(".json") && statSync(join(full, file)).isFile()) messages[file.slice(0, -5)] = asObject(join(full, file));
      }
      if (Object.keys(messages).length > 0) found.set(locale, { locale, messages: messages as RemoteTranslations, path: full });
    }
  }
  return [...found.values()];
}

/**
 * `push --all`: the source language first, so the keys exist, then each language of the app that has a file. Each
 * language is shown and confirmed on its own; a file for a language the app does not have is skipped with a note.
 */
async function pushAll(target: Target, session: Session, options: PushOptions, ask: Ask): Promise<void> {
  if (options.file || options.locale) throw new Error("--all reads every language file in a folder; leave out --file and --locale.");
  const folder = resolve(typeof options.all === "string" ? options.all : resolve(target.rootDir, target.context?.pull?.output || "./locales"));
  const files = readLocaleFolder(folder);
  const sourceLocale = canonicalLocale(session.app.sourceLocale);
  const lower = (l: string) => l.toLowerCase();
  const source = files.find((f) => lower(f.locale) === lower(sourceLocale));
  if (!source) throw new Error(`No ${s(sourceLocale)} file in ${s(folder)}. The source language goes first: it makes the keys the others translate.`);
  const targets = new Set(session.app.targetLocales.map((l) => lower(canonicalLocale(l))));
  const skipped = files.filter((f) => f !== source && !targets.has(lower(f.locale))).map((f) => f.locale);
  const order = [source, ...files.filter((f) => f !== source && targets.has(lower(f.locale)))];
  if (!options.json && skipped.length > 0) {
    console.log();
    console.log(yellow(`  Skipped ${skipped.map(s).join(", ")}: not a language of this app. Add one with \`lefine strings languages add <locale>\`.`));
  }
  const results: PushResult[] = [];
  for (const file of order) {
    const result = await pushOne(session, { ...file, locale: file === source ? sourceLocale : file.locale }, null, options, ask);
    results.push(result);
    if (result.bad.length > 0) break;
  }
  const bad = results.some((r) => r.bad.length > 0);
  out(
    options.json,
    { applied: !bad && results.some((r) => r.applied), locales: results.map(({ bad: _, ...r }) => r), skipped },
    () => {},
  );
  if (bad) process.exit(1);
}

/** Preview one language file, show it, ask, apply. Prints its own lines; the caller prints the --json result. */
export async function pushOne(session: Session, source: PushSource, other: ImportFileInput | null, options: PushOptions, ask: Ask, state?: "reviewed" | "approved"): Promise<PushResult> {
  const isSource = canonicalLocale(source.locale).toLowerCase() === canonicalLocale(session.app.sourceLocale).toLowerCase();
  // The import takes one namespace per call: top-level keys of a JSON file, or the whole of another format's file.
  const plans: NamespacePlan[] = [];
  if (other) plans.push({ namespace: other.namespace, input: other, preview: await session.ops.callOp<ImportPreview>("strings.import.preview", other) });
  for (const [namespace, value] of Object.entries(source.messages)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${path(source.path)}: "${namespace}" must be an object of keys (the file is { namespace: { key: text } }).`);
    }
    const input: ImportFileInput = {
      appId: session.appId,
      locale: source.locale,
      namespace,
      fileName: `${namespace}.json`,
      content: JSON.stringify(value),
      // A target language moving in from another tool keeps what was signed off there (lefine import).
      ...(state && !isSource ? { state } : {}),
    };
    plans.push({ namespace, input, preview: await session.ops.callOp<ImportPreview>("strings.import.preview", input) });
  }

  const total = { created: 0, updated: 0, skipped: 0, dropped: 0 };
  for (const { preview } of plans) {
    total.created += num(preview.tally.created);
    total.updated += num(preview.tally.updated);
    total.skipped += num(preview.tally.skipped);
    total.dropped += num(preview.tally.dropped);
  }
  const nothing = total.created + total.updated === 0;
  const result = (applied: boolean, runs: Run[] = []): PushResult => ({
    locale: source.locale,
    applied,
    tally: total,
    runs,
    bad: runs.filter((r) => r.status !== "succeeded"),
  });

  if (!options.json) {
    console.log();
    console.log(`  ${bold(s(appLabel(session)))} ${isSource ? "" : `${bold(s(source.locale))} `}${dim(`from ${s(source.path)}`)}`);
    const sample: ChangeItem[] = [];
    for (const { namespace, preview } of plans) {
      const t = preview.tally;
      console.log(
        `    ${cyan(s(namespace))}${preview.newNamespace ? dim(" (new)") : ""}: ${green(`${num(t.created)} new`)}, ${yellow(`${num(t.updated)} changed`)}, ${dim(`${num(t.skipped)} same`)}${num(t.dropped) ? `, ${red(`${num(t.dropped)} dropped`)}` : ""}`,
      );
      for (const d of preview.dropped.slice(0, 5)) console.log(`      ${red("-")} ${s(d.key)}: ${s(d.reason)}`);
      if (preview.alreadyImported) console.log(dim(`      This exact file was already imported at ${s(preview.alreadyImported.at)}.`));
      for (const l of preview.changes.locales) if (l.locale === source.locale) sample.push(...l.items);
    }
    for (const item of sample.slice(0, 5)) {
      console.log(`    ${cyan(s(`${item.namespace}.${item.key}`))} ${dim(s(item.kind))}`);
      if (item.before !== null) console.log(`      ${red("-")} ${s(item.before)}`);
      if (item.after !== null) console.log(`      ${green("+")} ${s(item.after)}`);
    }
    if (sample.length > 5) console.log(dim(`    ...and ${sample.length - 5} more`));
    // A language file makes the keys it names, like the source does, but they have no source text yet.
    if (!isSource && total.created > 0) {
      console.log(yellow(`  ${plural(total.created, "key")} in this file ${total.created === 1 ? "is" : "are"} not in Lefine yet: ${total.created === 1 ? "it" : "they"} would be added with only the ${s(source.locale)} text.`));
    }
    console.log(
      nothing
        ? "  Nothing to push. Lefine already has these texts."
        : `  Total: ${plural(total.created, "new text")}, ${plural(total.updated, "changed text")}${isSource ? "" : ` in ${s(source.locale)}`}.`,
    );
    console.log();
  }

  if (nothing) return result(false);

  if (!(await confirmOrExplain(isSource ? "Apply these changes?" : `Apply the ${s(source.locale)} changes?`, options, ask))) {
    if (!options.json) console.log("  Cancelled. Nothing was changed.");
    return result(false);
  }

  // What was shown is what is applied. The server takes one namespace per apply, and each apply
  // moves the app's marker, so the digests of the other previews go stale. Before each apply we
  // preview that namespace again: if the plan is still the one shown, it is applied with the fresh
  // digest; if anything in it changed, we stop (a stale digest is a CONFLICT and writes nothing).
  const runs: Run[] = [];
  for (const { namespace, input, preview } of plans) {
    if (preview.tally.created + preview.tally.updated === 0) continue;
    const fresh = runs.length === 0 ? preview : await session.ops.callOp<ImportPreview>("strings.import.preview", input);
    if (!samePlan(preview, fresh)) {
      throw new Error(
        `"${s(namespace)}" changed in Lefine while pushing, so it was not applied. ${plural(runs.length, "namespace")} before it were pushed. Run push again to see what is left.`,
      );
    }
    const { run } = await session.ops.callOp<RunOutput>("strings.import.apply", { ...input, digest: fresh.digest });
    runs.push(run);
  }
  const done = result(true, runs);
  if (!options.json) {
    if (done.bad.length === 0) console.log(`  ${green("✓")} Pushed ${plural(total.created + total.updated, "text")}${isSource ? "" : ` in ${s(source.locale)}`}.`);
    else {
      console.log(red(`  ${plural(done.bad.length, "namespace")} did not finish cleanly:`));
      for (const r of done.bad) for (const step of r.steps) console.log(`    ${s(step.name)}: ${s(step.status)} ${dim(s(step.detail))}`);
      if (done.bad[0]?.failure) console.log(red(`  ${s(done.bad[0].failure.reason)} ${s(done.bad[0].failure.fixAction)}`));
    }
  }
  done.applied = done.bad.length === 0;
  return done;
}

const path = (p: string) => s(p);

/** The same changes as shown, ignoring the digest (it also covers the app's marker, which every apply moves). */
export function samePlan(shown: ImportPreview, fresh: ImportPreview): boolean {
  const content = (p: ImportPreview) => JSON.stringify([p.tally, p.dropped, p.newNamespace, p.changes]);
  return content(shown) === content(fresh);
}

// ── check ──────────────────────────────────────────────────────────────

export async function loadAnalyzer(command = "lefine strings check") {
  try {
    const [{ collectFiles }, { analyzeFile }] = await Promise.all([import("../analyzer/file-collector.js"), import("../analyzer/index.js")]);
    return { collectFiles, analyzeFile };
  } catch (err) {
    if (String(err).includes("typescript")) throw new Error(`\`${command}\` reads your code with TypeScript. Add it: npm i -D typescript`);
    throw err;
  }
}

export interface CheckStringsOptions extends StringsOptions, SourceFileOptions {
  verbose?: boolean;
}

interface Problem {
  key: string;
  source: "server" | "code";
  locale?: string;
  message: string;
}

export async function stringsCheckCommand(options: CheckStringsOptions): Promise<void> {
  try {
    const target = await resolveTarget(options);
    const session = await openSession(options, target);
    const problems: Problem[] = [];

    // A big app is checked page by page.
    let cursor: string | undefined;
    do {
      const page = await session.ops.callOp<CheckPage>("strings.check", { appId: session.appId, ...(cursor ? { cursor } : {}) });
      for (const p of page.problems) {
        problems.push({ key: `${p.namespace}/${p.key}`, source: "server", locale: p.locale, message: p.message });
      }
      cursor = page.nextCursor ?? undefined;
    } while (cursor);

    // Local scan: keys the code uses that the source file does not have. Loaded here, not at start:
    // it needs TypeScript, which the lefine package only has as an optional peer.
    const { collectFiles, analyzeFile } = await loadAnalyzer();
    const files = await collectFiles({
      rootDir: target.rootDir,
      include: target.context?.lint?.include,
      exclude: target.context?.lint?.exclude,
    });
    const issues: Issue[] = [];
    for (const file of files) {
      try {
        const { issues: found } = await analyzeFile(file, target.context?.lint, false);
        issues.push(...found.filter((i) => i.type === "string-variable" && i.severity === "info"));
      } catch {
        /* a file that does not parse is not a string problem */
      }
    }
    const source = readSource(target, options);
    const metrics = getSummary(issues, source.messages, false);
    for (const [ns, entries] of Object.entries(metrics.missing)) {
      for (const entry of entries) {
        problems.push({
          key: entry.key,
          source: "code",
          message: `used in code but missing from ${source.path}${ns ? ` (${ns})` : ""}`,
        });
      }
    }

    const byKey = new Map<string, Problem[]>();
    for (const p of problems) byKey.set(p.key, [...(byKey.get(p.key) ?? []), p]);

    out(options.json, { problems, ok: problems.length === 0 }, () => {
      console.log();
      if (problems.length === 0) {
        console.log(`  ${green("✓")} No problems. Checked ${plural(files.length, "file")} and the server rules.`);
      } else {
        for (const [key, list] of byKey) {
          console.log(`  ${cyan(s(key))}`);
          for (const p of list) {
            console.log(`    ${red("-")} ${p.locale ? `[${s(p.locale)}] ` : ""}${s(p.message)} ${dim(`(${p.source})`)}`);
          }
        }
        console.log();
        console.log(red(`  ${plural(problems.length, "problem")} in ${plural(byKey.size, "key")}.`));
      }
      console.log();
    });
    if (problems.length > 0) process.exit(1);
  } catch (err) {
    fail(err, options.json);
  }
}

// ── publish ────────────────────────────────────────────────────────────

export interface PublishDeps {
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  ask?: Ask;
  /** How long to wait for the CDN, ms. */
  verifyTimeoutMs?: number;
  /** Opens the approval page; replaceable so tests do not open a browser. */
  openBrowser?: (url: string) => void;
  /** How long to wait for the person's approval in Lefine, ms. */
  approvalWaitMs?: number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Checks of the release this publish made: not the previous live one, and all `ok`. */
function judge(delivery: DeliveryChecks, priorVersion: string | null): "verified" | "failed" | "pending" {
  if (delivery.checks.length === 0 || delivery.version === priorVersion) return "pending";
  return delivery.checks.every((c) => c.status === "ok") ? "verified" : "failed";
}

export async function stringsPublishCommand(options: StringsOptions, deps: PublishDeps = {}): Promise<void> {
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;
  try {
    const target = await resolveTarget(options);
    const session = await openSession(options, target);
    const { ops, appId } = session;

    const preview = await ops.callOp<ReleasePreview>("strings.releases.preview", { appId });
    const changed = preview.locales.reduce((n, l) => n + num(l.added) + num(l.edited) + num(l.removed), 0);
    if (!options.json) {
      console.log();
      console.log(`  ${bold(s(appLabel(session)))}`);
      for (const l of preview.locales) {
        console.log(
          `    ${bold(s(l.locale).padEnd(6))} ${green(`+${num(l.added)}`)} ${yellow(`~${num(l.edited)}`)} ${red(`-${num(l.removed)}`)} ${dim(`serves ${num(l.willServe)}${num(l.draftsExcluded) ? `, ${num(l.draftsExcluded)} AI drafts held back` : ""}`)}`,
        );
      }
      console.log();
    }
    if (preview.blocker === NOTHING_TO_PUBLISH || (!preview.blocker && changed === 0)) {
      out(options.json, { published: false, reason: "nothing to publish" }, () => console.log("  Nothing to publish: every language is already live.\n"));
      return;
    }
    if (preview.blocker) throw new Error(`Publishing is blocked: ${s(preview.blocker)}`);

    if (!(await confirmOrExplain("Publish these changes to the CDN?", options, deps.ask))) {
      out(options.json, { published: false }, () => console.log("  Cancelled. Nothing was published."));
      return;
    }

    // A retry with the same id joins this release instead of publishing twice. A person approves it in Lefine: the
    // key cannot (#55), so --yes only skips the question above; the browser opens and the CLI waits for the yes.
    const { run } = await callWithApproval<RunOutput>(
      ops,
      "strings.releases.publish",
      { appId, requestId: randomUUID() },
      {
        sleep,
        now,
        openBrowser: deps.openBrowser ?? openInBrowser,
        ...(deps.approvalWaitMs !== undefined ? { waitMs: deps.approvalWaitMs } : {}),
        say: (line) => (options.json ? console.error(line) : console.log(line)),
      },
    );

    // Exit 0 only when every locale was read back from the CDN: `run.status === "succeeded"`.
    // A run still going is followed through the delivery checks of the new version.
    let outcome: "verified" | "failed" | "pending" =
      run.status === "succeeded" ? "verified" : run.status === "running" || run.status === "waiting" ? "pending" : "failed";
    let delivery: DeliveryChecks = { version: null, checks: [] };
    // A failed run is not live: Lefine puts the previous release back when the CDN check fails (its reason says so).
    const failed = run.status === "failed";
    if (!options.json) console.log(failed ? `  ${red("✗")} The publish failed.` : `  ${green("✓")} Published.${outcome === "pending" ? " Waiting for the CDN..." : ""}`);
    const deadline = now() + (deps.verifyTimeoutMs ?? 120_000);
    while (outcome === "pending") {
      if (now() >= deadline) break;
      await sleep(2000);
      delivery = await ops.callOp<DeliveryChecks>("strings.delivery.checks", { appId });
      outcome = judge(delivery, preview.liveVersion);
    }
    if (!options.json) {
      for (const c of delivery.checks) console.log(`    ${c.status === "ok" ? green("✓") : red("✗")} ${s(c.locale)} ${dim(`${num(c.servedKeys)}/${num(c.expectedKeys)} keys`)}`);
    }

    const verified = outcome === "verified";
    out(options.json, { published: !failed, verified, run, version: delivery.version, checks: delivery.checks }, () => {
      console.log();
      if (verified) console.log(`  ${green("✓")} Verified on the CDN.`);
      else {
        if (!failed) console.log(red("  Published, but not every locale is verified on the CDN. Run `lefine strings status` later."));
        for (const step of run.steps) if (step.status !== "succeeded") console.log(red(`    ${s(step.name)}: ${s(step.detail)}`));
        if (run.failure) console.log(red(`    ${s(run.failure.reason)} ${s(run.failure.fixAction)}`));
      }
      console.log();
    });
    if (!verified) process.exit(1);
  } catch (err) {
    fail(err, options.json);
  }
}

// ── status ─────────────────────────────────────────────────────────────

export async function stringsStatusCommand(options: StringsOptions): Promise<void> {
  try {
    const target = await resolveTarget(options);
    const session = await openSession(options, target);
    const { ops, appId } = session;
    const [preview, delivery] = await Promise.all([
      ops.callOp<ReleasePreview>("strings.releases.preview", { appId }),
      ops.callOp<DeliveryChecks>("strings.delivery.checks", { appId }),
    ]);
    const checks = delivery.checks;
    const pending = preview.locales.reduce((n, l) => n + num(l.added) + num(l.edited) + num(l.removed), 0);
    out(options.json, { app: target.app, liveVersion: preview.liveVersion, pending, preview, checks }, () => {
      console.log();
      console.log(`  ${bold(s(`${session.app.name} (${appId})`))}`);
      console.log(`  Live: ${preview.liveVersion ? s(preview.liveVersion) : "nothing published yet"}`);
      console.log(`  Pending: ${pending === 0 ? "no changes" : plural(pending, "change")}`);
      const bad = checks.filter((c) => c.status !== "ok");
      console.log(
        `  CDN: ${checks.length === 0 ? "no check yet" : bad.length === 0 ? green("all locales verified") : red(`${bad.map((c) => s(c.locale)).join(", ")} not verified`)}`,
      );
      console.log();
    });
  } catch (err) {
    fail(err, options.json);
  }
}

// ── types ──────────────────────────────────────────────────────────────

export interface StringsTypesOptions extends StringsOptions {
  /** File to write; default `lefine-strings.d.ts` next to lefine.ts (src/ when init put it there). */
  output?: string;
  /** Whose types to extend: next-intl, use-intl, lefine/strings, none; default from package.json. */
  binding?: string;
}

const BINDINGS: readonly TypesBinding[] = ["next-intl", "use-intl", "lefine/strings", "none"];

/**
 * Where the types file goes by default: beside lefine.ts. init writes src/lefine.ts in a Vite or TanStack Start app, whose
 * tsconfig includes only src/ (Vite's tsconfig.app.json: "include": ["src"]): a file at the root was never read, and
 * every key compiled (DX walk 2026-10-29, create-vite react-ts).
 */
export function defaultTypesFile(rootDir: string): string {
  const inSrc = !existsSync(join(rootDir, "lefine.ts")) && existsSync(join(rootDir, "src", "lefine.ts"));
  return join(rootDir, inSrc ? "src" : "", "lefine-strings.d.ts");
}

export async function stringsTypesCommand(options: StringsTypesOptions): Promise<void> {
  try {
    if (options.binding && !BINDINGS.includes(options.binding as TypesBinding)) {
      throw new Error(`--binding must be one of ${BINDINGS.join(", ")}.`);
    }
    const target = await resolveTarget(options);
    const session = await openSession(options, target);
    const keys = await fetchSourceKeys(session.ops, session.appId, session.app.sourceLocale);
    const binding = (options.binding as TypesBinding | undefined) ?? detectBinding(target.rootDir);
    const rendered = renderStringsTypes({ workspace: target.workspace, app: session.app, keys, binding });
    const file = options.output ? resolve(target.rootDir, options.output) : defaultTypesFile(target.rootDir);
    if (!file.endsWith(".d.ts")) throw new Error(`${file} must end in .d.ts: it holds types only.`);
    writeFileSync(file, rendered.text);
    out(options.json, { file, keys: rendered.keyCount, binding, conflicts: rendered.conflicts }, () => {
      console.log(`  ${green("✓")} Wrote ${file}: ${plural(rendered.keyCount, "key")} from ${s(appLabel(session))}.`);
      console.log(
        dim(
          binding === "none"
            ? "    No next-intl or use-intl in package.json: the file exports LefineMessages and LefineKey only. Pass --binding to register them."
            : binding === "lefine/strings"
              ? "    useStrings (lefine/react), getStrings (lefine/next) and createTranslator (lefine/strings) now check namespaces and keys. Make sure tsconfig includes the file."
              : `    useTranslations from ${binding} now checks keys and arguments. Make sure tsconfig includes the file.`,
        ),
      );
      if (rendered.conflicts.length > 0) {
        console.log(yellow(`    Left out ${plural(rendered.conflicts.length, "key")} that is both a text and a group: ${rendered.conflicts.slice(0, 5).map(s).join(", ")}`));
      }
    });
  } catch (err) {
    fail(err, options.json);
  }
}
