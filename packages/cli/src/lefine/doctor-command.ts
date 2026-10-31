/**
 * `lefine doctor` (#30, Better's doctor): one report and a 0–100 score for the app. The local half is Better's
 * diagnose() (hard-coded JSX text, toasts, local locale files) with its score and weights unchanged; the CDN
 * comparison there is Better's, so it is off and Lefine's server does that part:
 *   - strings.check, every page: texts that break at run time (ICU, placeholders, markup) → error, Quality
 *   - strings.keys.usage: names in the code with no key → missing-in-remote (warning), keys the code never uses →
 *     unused-remote-key (info, as in Better: no points off)
 */

import type { Issue } from "../analyzer/types.js";
import type { DoctorReport } from "../doctor/index.js";
import type { I18nDiagnostic } from "../rules/registry.js";
import { fail } from "./auth-commands.js";
import { safeJson, safeText } from "./safe-text.js";
import { openSession, resolveTarget, type StringsOptions } from "./strings-commands.js";
import { keyUsage, usageQuery } from "./strings-usage.js";
import type { CheckPage } from "./types.js";

export interface DoctorCommandOptions extends StringsOptions {
  verbose?: boolean;
  /** Fail under this score (default 70, as Better). */
  threshold?: string;
}

const server = (rule: string, severity: I18nDiagnostic["severity"], category: I18nDiagnostic["category"], message: string, help: string, key?: string, namespace?: string): I18nDiagnostic => ({
  filePath: "(Lefine)",
  line: 0,
  column: 0,
  rule,
  category,
  severity,
  message,
  help,
  ...(key ? { key } : {}),
  ...(namespace ? { namespace } : {}),
});

/** Every page of strings.check, as diagnostics. */
async function serverChecks(ops: Parameters<typeof keyUsage>[0], appId: string): Promise<I18nDiagnostic[]> {
  const out: I18nDiagnostic[] = [];
  let cursor: string | undefined;
  do {
    const page = await ops.callOp<CheckPage>("strings.check", { appId, ...(cursor ? { cursor } : {}) });
    for (const p of page.problems) {
      out.push(server("lefine-check", "error", "Quality", `[${p.locale}] ${p.namespace}.${p.key}: ${p.message}`, "Fix the text in Lefine: a text that breaks here breaks on the page, and an invalid one blocks the publish", p.key, p.namespace));
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return out;
}

export async function lefineDoctorCommand(options: DoctorCommandOptions): Promise<void> {
  try {
    const started = performance.now();
    const target = await resolveTarget(options);
    const session = await openSession(options, target);
    let threshold = 70;
    if (options.threshold !== undefined) {
      threshold = Number(options.threshold);
      if (!Number.isInteger(threshold) || threshold < 0 || threshold > 100) throw new Error("--threshold takes a whole number from 0 to 100.");
    }

    // Loaded here: it reads code with TypeScript, an optional peer of the lefine package.
    let doctor: typeof import("../doctor/index.js");
    let score: typeof import("../doctor/score.js");
    try {
      [doctor, score] = await Promise.all([import("../doctor/index.js"), import("../doctor/score.js")]);
    } catch (err) {
      if (String(err).includes("typescript")) throw new Error("`lefine doctor` reads your code with TypeScript. Add it: npm i -D typescript");
      throw err;
    }
    let issues: Issue[] = [];
    // No CDN read at all: a cloned project's config could name any host (security review). Lefine's server
    // compares instead; diagnose() reads only local locale files.
    const local = await doctor.diagnose(target.rootDir, { skipSync: true, skipRemote: true, verbose: options.verbose, passThreshold: threshold, onIssues: (all) => (issues = all) });

    const keyIssues = issues.filter((i) => i.type === "string-variable" && i.severity === "info");
    const [checks, usage] = await Promise.all([serverChecks(session.ops, session.appId), keyUsage(session.ops, session.appId, usageQuery(keyIssues))]);
    const diagnostics = [
      ...local.diagnostics,
      ...checks,
      ...usage.missing.map((m) => server("missing-in-remote", "warning", "Coverage", `"${m}" is used in the code but has no key in Lefine: users see the raw name`, "Add it with `lefine strings push` or in Lefine (`lefine strings missing` lists them)", m)),
      ...usage.unused.map((u) => server("unused-remote-key", "info", "Performance", `${u.namespace}.${u.key} is in Lefine but the code never uses it`, "Remove it with `lefine strings unused --delete` (a person approves it in Lefine)", u.key, u.namespace)),
    ];

    const summary = { ...local.summary, total: diagnostics.length, errors: 0, warnings: 0, infos: 0, byCategory: {} as Record<string, number>, keysChecked: Math.max(local.summary.keysChecked, usage.keys) };
    for (const d of diagnostics) {
      summary.byCategory[d.category] = (summary.byCategory[d.category] ?? 0) + 1;
      if (d.severity === "error") summary.errors++;
      else if (d.severity === "warning") summary.warnings++;
      else summary.infos++;
    }
    const report: DoctorReport = {
      ...local,
      durationMs: Math.round(performance.now() - started),
      diagnostics,
      score: score.calculateHealthScore(diagnostics, threshold),
      summary,
    };

    if (options.json) console.log(safeJson({ app: session.appId, ...report, unusedTotal: usage.unusedTotal, missingTotal: usage.missingTotal }, 2));
    else {
      // Server text and the scanned code's text go to the terminal without escape sequences (security review).
      const shown = report.diagnostics.map((d) => ({
        ...d,
        filePath: safeText(d.filePath),
        message: safeText(d.message),
        help: safeText(d.help),
        ...(d.key !== undefined ? { key: safeText(d.key) } : {}),
        ...(d.namespace !== undefined ? { namespace: safeText(d.namespace) } : {}),
      }));
      (await import("../reporters/doctor-eslint.js")).reportEslint({ ...report, diagnostics: shown }, options.verbose, "lefine");
    }
    if (!report.score.passed) process.exit(1);
  } catch (err) {
    fail(err, options.json);
  }
}
