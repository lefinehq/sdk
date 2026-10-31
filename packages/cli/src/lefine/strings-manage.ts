/**
 * The smaller Better CLI commands (#30, item 4): `lefine apps`, `lefine strings keys list|create|delete`,
 * `lefine strings runs [id]` and `lefine strings languages add`. Each is one action of /v1/ops; the ones that ask
 * first (a delete, a new language) go through the person's approval in Lefine, as a publish does.
 */

import { bold, cyan, dim, green, red, yellow } from "../utils/colors.js";
import { fail, openInBrowser, out, type GlobalOptions } from "./auth-commands.js";
import { callWithApproval, createOpClient, LefineError, type OpClient } from "./client.js";
import { resolveLefineAuth } from "./credentials.js";
import { canonicalLocale, confirmOrExplain, openSession, resolveTarget, type Ask, type StringsOptions } from "./strings-commands.js";
import { safeText as s } from "./safe-text.js";
import { itemsOf, type AppSummary, type Run } from "./types.js";

interface KeyRow {
  id: string;
  key: string;
  namespace: string;
  description?: string;
  translations: Record<string, { text: string; state: string }>;
}

export interface Approvals {
  ask?: Ask;
  openBrowser?: (url: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  approvalWaitMs?: number;
}

export const waitFor = (why: string, json: boolean | undefined, deps: Approvals) => ({
  why,
  openBrowser: deps.openBrowser ?? openInBrowser,
  say: (line: string) => (json ? console.error(line) : console.log(line)),
  ...(deps.sleep ? { sleep: deps.sleep } : {}),
  ...(deps.now ? { now: deps.now } : {}),
  ...(deps.approvalWaitMs !== undefined ? { waitMs: deps.approvalWaitMs } : {}),
});

/** An answer that waited too long names the rerun, so nobody has to find the approval again. */
export const pendingHint = (err: unknown, rerun: string): never => {
  if (err instanceof LefineError && err.code === "APPROVAL_PENDING" && err.approval) {
    throw new Error(`Once a person approves ${err.approval.url} , run ${rerun} --approval ${err.approval.id}.`);
  }
  throw err;
};

// ── lefine apps ───────────────────────────────────────────────────────

export async function appsCommand(options: GlobalOptions): Promise<void> {
  try {
    const auth = resolveLefineAuth(options);
    if (!auth) throw new LefineError("UNAUTHORIZED", "no key");
    const apps = itemsOf<AppSummary>(await createOpClient(auth.apiUrl, auth.token).callOp("strings.apps.list", {}));
    out(options.json, { items: apps }, () => {
      console.log();
      if (apps.length === 0) console.log("  No app yet. Create one in Lefine.");
      for (const a of apps) {
        console.log(`  ${bold(s(a.name))} ${dim(`(${s(a.slug)})`)}  ${cyan(s(a.id))}`);
        console.log(dim(`    ${[a.sourceLocale, ...a.targetLocales].map(s).join(", ")}  ·  ${Number(a.keyCount) || 0} keys`));
      }
      console.log();
    });
  } catch (err) {
    fail(err, options.json);
  }
}

// ── lefine strings keys ───────────────────────────────────────────────

export interface KeysListOptions extends StringsOptions {
  namespace?: string;
  search?: string;
  locale?: string;
  limit?: string;
  all?: boolean;
}

export async function keysListCommand(options: KeysListOptions): Promise<void> {
  try {
    const { ops, appId, app } = await openSession(options, await resolveTarget(options));
    const limit = options.limit === undefined ? 50 : Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("--limit takes 1 to 200.");
    const locale = options.locale ? canonicalLocale(options.locale) : app.sourceLocale;
    const items: KeyRow[] = [];
    let cursor: string | undefined;
    do {
      const page = await ops.callOp<{ items: KeyRow[]; nextCursor: string | null }>("strings.keys.list", {
        appId,
        limit,
        ...(options.namespace ? { namespace: options.namespace } : {}),
        ...(options.search ? { search: options.search } : {}),
        ...(cursor ? { cursor } : {}),
      });
      items.push(...page.items);
      cursor = page.nextCursor ?? undefined;
    } while (cursor && options.all);
    out(options.json, { items, nextCursor: cursor ?? null }, () => {
      console.log();
      for (const k of items) {
        const t = k.translations[locale];
        console.log(`  ${cyan(s(k.namespace))}${dim(".")}${s(k.key)}  ${t?.text ? s(t.text.length > 80 ? `${t.text.slice(0, 80)}…` : t.text) : dim(`(no ${s(locale)} text)`)}`);
      }
      console.log(dim(`\n  ${items.length} keys${cursor ? ", more: add --all" : ""}.`));
      console.log();
    });
  } catch (err) {
    fail(err, options.json);
  }
}

export interface KeysCreateOptions extends StringsOptions {
  text?: string;
  description?: string;
}

export async function keysCreateCommand(name: string, options: KeysCreateOptions): Promise<void> {
  try {
    const dot = name.indexOf(".");
    if (dot < 1 || dot === name.length - 1) throw new Error(`Name the key with its namespace: namespace.key, for example nav.home (got "${s(name)}").`);
    const { ops, appId } = await openSession(options, await resolveTarget(options));
    const key = await ops.callOp<KeyRow>("strings.keys.create", {
      appId,
      namespace: name.slice(0, dot),
      key: name.slice(dot + 1),
      ...(options.text !== undefined ? { sourceText: options.text } : {}),
      ...(options.description ? { description: options.description } : {}),
    });
    out(options.json, key, () => console.log(`  ${green("✓")} Created ${s(key.namespace)}.${s(key.key)} ${dim(`(${s(key.id)})`)}. It goes live with the next publish.`));
  } catch (err) {
    fail(err, options.json);
  }
}

export interface KeysDeleteOptions extends StringsOptions {
  approval?: string;
}

/** `nav.home` or a key id → the key's id, by an exact match in its namespace. */
async function keyIdOf(ops: OpClient, appId: string, name: string): Promise<string> {
  if (/^key_[A-Za-z0-9]+$/.test(name)) return name;
  const dot = name.indexOf(".");
  if (dot < 1) throw new Error(`"${s(name)}" is not namespace.key or a key id.`);
  const namespace = name.slice(0, dot);
  const key = name.slice(dot + 1);
  const page = await ops.callOp<{ items: KeyRow[] }>("strings.keys.list", { appId, namespace, search: key, limit: 200 });
  const found = page.items.find((k) => k.namespace === namespace && k.key === key);
  if (!found) throw new Error(`No key ${s(name)} in this app.`);
  return found.id;
}

export async function keysDeleteCommand(names: string[], options: KeysDeleteOptions, deps: Approvals = {}): Promise<void> {
  try {
    if (names.length === 0 || names.length > 200) throw new Error("Name 1 to 200 keys (namespace.key or key ids).");
    const { ops, appId } = await openSession(options, await resolveTarget(options));
    // One lookup at a time: up to 200 names, and the API rate-limits a key.
    const keyIds: string[] = [];
    for (const n of names) {
      const id = await keyIdOf(ops, appId, n);
      if (!keyIds.includes(id)) keyIds.push(id);
    }
    if (!(await confirmOrExplain(`Delete ${keyIds.length} keys and all their translations? Lefine cannot undo it.`, options, deps.ask))) {
      out(options.json, { deleted: 0 }, () => console.log("  Cancelled. Nothing was deleted."));
      return;
    }
    const input = { appId, keyIds };
    const done = await (options.approval
      ? ops.callOp<{ deleted: number }>("strings.keys.delete", input, { approval: options.approval })
      : callWithApproval<{ deleted: number }>(ops, "strings.keys.delete", input, waitFor("Deleting keys cannot be undone", options.json, deps))
    ).catch((err: unknown) => pendingHint(err, `lefine strings keys delete ${names.join(" ")} --yes`));
    out(options.json, done, () => console.log(`  ${green("✓")} Deleted ${Number(done.deleted) || 0} keys. The next publish takes them off the CDN.`));
  } catch (err) {
    fail(err, options.json);
  }
}

// ── lefine strings runs ───────────────────────────────────────────────

interface RunRow extends Run {
  kind?: string;
  createdAt?: string;
}

const status = (st: string) => (st === "succeeded" ? green(st) : st === "failed" ? red(st) : yellow(st));

export async function runsCommand(id: string | undefined, options: StringsOptions & { kind?: string; limit?: string }): Promise<void> {
  try {
    const { ops, appId } = await openSession(options, await resolveTarget(options));
    if (id) {
      const run = await ops.callOp<RunRow>("strings.runs.get", { appId, runId: id });
      out(options.json, run, () => {
        console.log(`\n  ${bold(s(run.kind ?? "run"))} ${s(run.id)}  ${status(s(run.status))}  ${dim(s(run.createdAt ?? ""))}`);
        for (const step of run.steps) console.log(`    ${status(s(step.status)).padEnd(20)} ${s(step.name)}  ${dim(s(step.detail))}`);
        if (run.failure) console.log(red(`    ${s(run.failure.reason)} ${s(run.failure.fixAction)}`));
        console.log();
      });
      return;
    }
    const limit = options.limit === undefined ? 10 : Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("--limit takes 1 to 50.");
    const runs = itemsOf<RunRow>(await ops.callOp("strings.runs.list", { appId, limit, ...(options.kind ? { kind: options.kind } : {}) }));
    out(options.json, { items: runs }, () => {
      console.log();
      for (const r of runs) console.log(`  ${cyan(s(r.id))}  ${s(r.kind ?? "")}  ${status(s(r.status))}  ${dim(s(r.createdAt ?? ""))}`);
      console.log(dim(`\n  ${runs.length} runs. One in detail: lefine strings runs <id>`));
      console.log();
    });
  } catch (err) {
    fail(err, options.json);
  }
}

// ── lefine strings languages add ──────────────────────────────────────

export async function languagesAddCommand(locale: string, options: StringsOptions & { approval?: string }, deps: Approvals = {}): Promise<void> {
  try {
    const tag = canonicalLocale(locale);
    const { ops, appId } = await openSession(options, await resolveTarget(options));
    const input = { appId, locale: tag };
    const done = await (options.approval
      ? ops.callOp<{ app: AppSummary }>("strings.locales.add", input, { approval: options.approval })
      : callWithApproval<{ app: AppSummary }>(ops, "strings.locales.add", input, waitFor("A new language changes what the app ships", options.json, deps))
    ).catch((err: unknown) => pendingHint(err, `lefine strings languages add ${tag}`));
    out(options.json, done, () => console.log(`  ${green("✓")} Added ${s(tag)}. Languages now: ${[done.app.sourceLocale, ...done.app.targetLocales].map(s).join(", ")}.`));
  } catch (err) {
    fail(err, options.json);
  }
}
