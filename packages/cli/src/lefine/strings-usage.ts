/**
 * `lefine strings unused` and `lefine strings missing` (#30, Better's check:unused and check:missing). The code scan is
 * the one `strings check` uses; the comparison is the server's (`strings.keys.usage`), so it is against the app's keys
 * in Lefine, not a local file. `unused --delete` deletes through `strings.keys.delete`, which a person approves.
 */

import type { Issue } from "../analyzer/types.js";
import { bold, cyan, dim, green, red, yellow } from "../utils/colors.js";
import { fail, openInBrowser, out } from "./auth-commands.js";
import { callWithApproval, LefineError, type OpClient } from "./client.js";
import { confirmOrExplain, loadAnalyzer, openSession, resolveTarget, type Ask, type StringsOptions } from "./strings-commands.js";
import { safeText as s } from "./safe-text.js";

/** The API's limits (strings.keys.usage). */
export const USAGE_LIMITS = { codeKeys: 20_000, patterns: 2_000, prefixes: 500, patternChars: 200, patternStars: 5 } as const;
const DELETE_CHUNK = 200;

export interface UsageQuery {
  codeKeys: string[];
  patterns: string[];
  prefixes: string[];
  /** Dynamic keys we could not send: fully dynamic (t(key)) or over the pattern limits. They may hide used keys. */
  skipped: string[];
}

export interface KeyUsage {
  keys: number;
  used: number;
  unusedTotal: number;
  unused: Array<{ keyId: string; namespace: string; key: string }>;
  missingTotal: number;
  missing: string[];
}

/** `plans.${id}.name` → `plans.*.name`; null when nothing but `*` and dots is left (it would match every key). */
export function toPattern(raw: string): string | null {
  const p = raw.replace(/\$\{[^}]*\}/g, "*").replace(/\*{2,}/g, "*").trim();
  if (!p.includes("*") || /^[*.]*$/.test(p)) return null;
  return p;
}

/**
 * What the scan found, as the server takes it. A key the analyzer could only partly name (a translator whose
 * namespace it does not know) is sent as patterns `*.key`, `*.*.key`, ...: it is used somewhere under some prefix, and
 * a guess at the full name would show up as missing.
 */
export function usageQuery(issues: Issue[]): UsageQuery {
  const codeKeys = new Set<string>();
  const patterns = new Set<string>();
  const prefixes = new Set<string>();
  const skipped = new Set<string>();
  for (const issue of issues) {
    if (issue.bindingType === "bound-scoped" && issue.namespace) prefixes.add(issue.namespace);
    if (issue.isDynamic) {
      const raw = issue.pattern ?? issue.key ?? "";
      const p = toPattern(raw);
      const stars = p ? (p.match(/\*/g) ?? []).length : 0;
      if (p && p.length <= USAGE_LIMITS.patternChars && stars <= USAGE_LIMITS.patternStars) patterns.add(p);
      else if (raw) skipped.add(raw);
      continue;
    }
    if (!issue.key) continue;
    if (issue.bindingType === "unknown-scoped") {
      for (let depth = 1; depth <= 3; depth++) patterns.add(`${"*.".repeat(depth)}${issue.key}`);
      continue;
    }
    codeKeys.add(issue.key);
  }
  return { codeKeys: [...codeKeys], patterns: [...patterns], prefixes: [...prefixes], skipped: [...skipped] };
}

function checkLimits(q: UsageQuery): void {
  for (const field of ["codeKeys", "patterns", "prefixes"] as const) {
    if (q[field].length > USAGE_LIMITS[field]) {
      throw new Error(`The scan found ${q[field].length} ${field}, over the API's ${USAGE_LIMITS[field]}. Check one namespace at a time with --namespace.`);
    }
  }
}

/**
 * The server's comparison, plus one fix-up the old local check had: code that reads an object (`t.raw("nav")`)
 * names a key that is not a leaf. Such a name comes back as missing and its children as unused, so the names that
 * came back missing are asked again as prefixes: a missing name that covers some unused key reads an object, it is
 * not missing, and what it covers is used.
 */
export async function keyUsage(ops: OpClient, appId: string, q: UsageQuery, namespace?: string): Promise<KeyUsage> {
  checkLimits(q);
  const ask = (prefixes: string[]) =>
    ops.callOp<KeyUsage>("strings.keys.usage", { appId, ...(namespace ? { namespace } : {}), codeKeys: q.codeKeys, patterns: q.patterns, prefixes });
  const first = await ask(q.prefixes);
  const extra = first.missing.filter((m) => !q.prefixes.includes(m));
  if (extra.length === 0 || first.unused.length === 0 || q.prefixes.length + extra.length > USAGE_LIMITS.prefixes) return first;
  const second = await ask([...q.prefixes, ...extra]);
  const nowUsed = first.unused.filter((u) => !second.unused.some((v) => v.keyId === u.keyId));
  const covers = (name: string) => nowUsed.some((u) => u.namespace === name || `${u.namespace}.${u.key}`.startsWith(`${name}.`) || u.key.startsWith(`${name}.`));
  const objects = new Set(extra.filter(covers));
  if (objects.size === 0) return first;
  const missing = first.missing.filter((m) => !objects.has(m));
  return { ...second, missing, missingTotal: first.missingTotal - (first.missing.length - missing.length) };
}

export interface UsageOptions extends StringsOptions {
  namespace?: string;
  ci?: boolean;
  delete?: boolean;
  /** The approval id a person gave for the first delete, to run it without waiting again. */
  approval?: string;
  verbose?: boolean;
}

export interface UsageDeps {
  ask?: Ask;
  openBrowser?: (url: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  approvalWaitMs?: number;
  /** The scan, replaceable in tests: issues of the app's code. */
  scan?: (rootDir: string, lint: Parameters<typeof scanCode>[1]) => Promise<{ issues: Issue[]; files: number }>;
}

async function scanCode(rootDir: string, lint?: { include?: string[]; exclude?: string[] }, command = "lefine strings unused"): Promise<{ issues: Issue[]; files: number }> {
  const { collectFiles, analyzeFile } = await loadAnalyzer(command);
  const files = await collectFiles({ rootDir, include: lint?.include, exclude: lint?.exclude });
  const issues: Issue[] = [];
  for (const file of files) {
    try {
      const { issues: found } = await analyzeFile(file, lint as never, false);
      issues.push(...found.filter((i) => i.type === "string-variable" && i.severity === "info"));
    } catch {
      /* a file that does not parse names no key */
    }
  }
  return { issues, files: files.length };
}

async function run(kind: "unused" | "missing", options: UsageOptions, deps: UsageDeps) {
  const target = await resolveTarget(options);
  const session = await openSession(options, target);
  const scan = deps.scan ?? ((dir, lint) => scanCode(dir, lint, `lefine strings ${kind}`));
  const { issues, files } = await scan(target.rootDir, target.context?.lint);
  const q = usageQuery(issues);
  const usage = await keyUsage(session.ops, session.appId, q, options.namespace);
  return { target, session, usage, q, files };
}

const listedNote = (shown: number, total: number) => (total > shown ? dim(` (first ${shown} of ${total} listed)`) : "");

export async function stringsUnusedCommand(options: UsageOptions, deps: UsageDeps = {}): Promise<void> {
  try {
    const { session, usage, q, files } = await run("unused", options, deps);
    const say = (line: string) => (options.json ? console.error(line) : console.log(line));
    let deleted = 0;

    if (!options.json) {
      console.log();
      if (usage.unusedTotal === 0) console.log(`  ${green("✓")} Every key of ${bold(s(session.app.name))} is used (${usage.keys} keys, ${files} files).`);
      else {
        console.log(`  ${bold(String(usage.unusedTotal))} of ${usage.keys} keys are not used in the code${listedNote(usage.unused.length, usage.unusedTotal)}:`);
        for (const u of usage.unused) console.log(`    ${cyan(s(u.namespace))}${dim(".")}${s(u.key)}`);
      }
      if (q.skipped.length > 0) {
        console.log(yellow(`  ${q.skipped.length} dynamic keys could not be checked (fully dynamic, or too broad), so a key listed above may still be used:`));
        for (const k of q.skipped.slice(0, 5)) console.log(dim(`    ${s(k)}`));
      }
      console.log();
    }

    if (options.delete && usage.unused.length > 0) {
      // A fully dynamic key can use any of them: deleting on a guess is refused unless the person says so.
      if (!(await confirmOrExplain(`Delete ${usage.unused.length} keys and all their translations? Lefine cannot undo it.`, options, deps.ask))) {
        out(options.json, { ...usage, deleted: 0 }, () => console.log("  Cancelled. Nothing was deleted.\n"));
        return;
      }
      const ids = usage.unused.map((u) => u.keyId);
      for (let i = 0; i < ids.length; i += DELETE_CHUNK) {
        const input = { appId: session.appId, keyIds: ids.slice(i, i + DELETE_CHUNK) };
        const done = await (
          i === 0 && options.approval
            ? session.ops.callOp<{ deleted: number }>("strings.keys.delete", input, { approval: options.approval })
            : callWithApproval<{ deleted: number }>(session.ops, "strings.keys.delete", input, {
                why: "Deleting keys cannot be undone",
                openBrowser: deps.openBrowser ?? openInBrowser,
                say,
                ...(deps.sleep ? { sleep: deps.sleep } : {}),
                ...(deps.now ? { now: deps.now } : {}),
                ...(deps.approvalWaitMs !== undefined ? { waitMs: deps.approvalWaitMs } : {}),
              })
        ).catch((err: unknown) => {
          // Nobody answered while we waited: the same delete can run later with the person's yes.
          if (err instanceof LefineError && err.code === "APPROVAL_PENDING" && err.approval) {
            throw new Error(`${deleted} deleted so far. Once a person approves ${err.approval.url} , run this again with --approval ${err.approval.id}.`);
          }
          throw err;
        });
        deleted += Number(done.deleted) || 0;
      }
      if (!options.json) {
        console.log(`  ${green("✓")} Deleted ${deleted} keys. The next publish takes them off the CDN.`);
        if (usage.unusedTotal > usage.unused.length) console.log(dim(`    ${usage.unusedTotal - usage.unused.length} more: run it again.`));
        console.log();
      }
    }

    out(options.json, { ...usage, skipped: q.skipped, ...(options.delete ? { deleted } : {}) }, () => {});
    if (options.ci && usage.unusedTotal - deleted > 0) process.exit(1);
  } catch (err) {
    fail(err, options.json);
  }
}

export async function stringsMissingCommand(options: UsageOptions, deps: UsageDeps = {}): Promise<void> {
  try {
    const { session, usage, files } = await run("missing", options, deps);
    out(options.json, { missingTotal: usage.missingTotal, missing: usage.missing, keys: usage.keys }, () => {
      console.log();
      if (usage.missingTotal === 0) console.log(`  ${green("✓")} Every key the code names exists in ${bold(s(session.app.name))} (${files} files).`);
      else {
        console.log(`  ${bold(String(usage.missingTotal))} names in the code have no key in Lefine, so users see the raw name${listedNote(usage.missing.length, usage.missingTotal)}:`);
        for (const m of usage.missing) console.log(`    ${red("-")} ${s(m)}`);
        console.log(dim("    Add them with `lefine strings push`, or in Lefine."));
      }
      console.log();
    });
    if (usage.missingTotal > 0) process.exit(1);
  } catch (err) {
    fail(err, options.json);
  }
}
