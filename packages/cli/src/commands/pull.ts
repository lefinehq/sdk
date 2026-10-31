/**
 * Pull command
 *
 * Downloads translations from Better i18n CDN to local JSON files.
 * Essential for mobile apps (Expo, React Native, Swift, Flutter) where
 * bundled translations serve as offline fallback when CDN is unreachable.
 *
 * Config priority (highest → lowest):
 *   1. CLI flags (-p, -o, -l)
 *   2. i18n.config.ts pull section
 *   3. i18n.config.ts project/defaultLocale
 *   4. Defaults (./locales, all languages)
 *
 * Usage:
 *   better-i18n pull                          # reads from i18n.config.ts
 *   better-i18n pull -p org/project           # explicit project (no config needed)
 *   better-i18n pull -o ./src/locales         # override output dir
 *   better-i18n pull -l en,tr                 # specific locales only
 *   better-i18n pull --cdn-url http://localhost:8788   # another CDN (local edge, staging)
 *   better-i18n pull --since 180              # also list what changed since revision 180
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import ora from "ora";
import type { ProjectContext } from "../analyzer/types.js";
import { detectProjectContext } from "../context/detector.js";
import { fetchChanges, fetchManifest, fetchRemoteKeys } from "../utils/cdn-client.js";
import { describeChangesSince, parseSinceRevision } from "../utils/changes-report.js";
import { bold, cyan, dim, green, red, yellow } from "../utils/colors.js";

const DEFAULT_CDN = "https://cdn.better-i18n.com";

export interface PullOptions {
  project?: string;
  output?: string;
  locales?: string;
  dir?: string;
  verbose?: boolean;
  /** Revision last pulled; prints what changed since, before downloading. */
  since?: string;
  /** Download every locale even when the saved state says it is unchanged. */
  force?: boolean;
  /** CDN origin to read from (default: i18n.config.ts `cdnBaseUrl`, else https://cdn.better-i18n.com). */
  cdnUrl?: string;
}

export async function pullCommand(options: PullOptions) {
  const spinner = ora({ text: "Detecting project...", color: "cyan" }).start();

  // ── Resolve config from i18n.config.ts ──────────────────────────
  const rootDir = resolve(options.dir || process.cwd());
  let context: ProjectContext | null = null;

  if (!options.project) {
    context = await detectProjectContext(rootDir, false);
  }

  // ── Resolve project identifier ──────────────────────────────────
  let workspaceId: string;
  let projectSlug: string;
  let cdnBaseUrl = DEFAULT_CDN;

  if (options.project) {
    // CLI flag takes priority. An app id (app_...) is the edge's id path; org/project is the old name path.
    const parts = /^app_[a-z0-9]{3,64}$/.test(options.project) ? [options.project, ""] : options.project.split("/");
    if (parts.length !== 2 || !parts[0] || (!parts[1] && !parts[0].startsWith("app_"))) {
      spinner.fail(`Invalid project format: ${bold(options.project)}. Expected "org/project".`);
      process.exit(1);
    }
    [workspaceId, projectSlug] = parts;
  } else if (context) {
    // From i18n.config.ts
    workspaceId = context.workspaceId;
    projectSlug = context.projectSlug;
    cdnBaseUrl = context.cdnBaseUrl || DEFAULT_CDN;
  } else {
    spinner.fail(
      "No project found. Either:\n" +
      `  ${bold("1.")} Create an ${bold("i18n.config.ts")} with your project identifier\n` +
      `  ${bold("2.")} Pass ${bold("-p org/project")} flag`,
    );
    process.exit(1);
  }

  if (options.cdnUrl) cdnBaseUrl = options.cdnUrl.replace(/\/+$/, "");

  spinner.succeed(`Project: ${bold(projectSlug ? workspaceId + "/" + projectSlug : workspaceId)}`);

  // ── Fetch manifest ──────────────────────────────────────────────
  spinner.start("Fetching manifest from CDN...");

  let manifest;
  try {
    manifest = await fetchManifest(cdnBaseUrl, workspaceId, projectSlug);
  } catch (err) {
    spinner.fail(`Failed to fetch manifest: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }

  const availableLocales = manifest.languages.map((l) => l.code);
  spinner.succeed(
    `Manifest: ${bold(String(availableLocales.length))} languages (${availableLocales.join(", ")})`,
  );

  // ── Determine locales: CLI flag → config.pull.locales → all ─────
  let targetLocales: string[];
  const localesSource = options.locales
    ? options.locales.split(",").map((l) => l.trim().toLowerCase())
    : context?.pull?.locales;

  if (localesSource) {
    const invalid = localesSource.filter((l) => !availableLocales.includes(l));
    if (invalid.length > 0) {
      console.log(yellow(`  ⚠  Unknown locales: ${invalid.join(", ")} (skipped)`));
    }
    targetLocales = localesSource.filter((l) => availableLocales.includes(l));
    if (targetLocales.length === 0) {
      spinner.fail("No valid locales to download.");
      process.exit(1);
    }
  } else {
    targetLocales = availableLocales;
  }

  // ── What changed since the revision the caller last pulled ───────
  if (options.since !== undefined) {
    const since = parseSinceRevision(options.since);
    if (since === null) {
      spinner.fail(`Invalid --since value: ${bold(options.since)}. Expected a revision number, e.g. 180.`);
      process.exit(1);
    }
    const changes = await fetchChanges(cdnBaseUrl, workspaceId, projectSlug, manifest);
    console.log();
    for (const line of describeChangesSince(manifest, since, changes, targetLocales)) {
      console.log(line);
    }
    console.log();
  }

  // ── Resolve output dir: CLI flag → config.pull.output → ./locales
  const outputPath = options.output || context?.pull?.output || "./locales";
  const outputDir = resolve(rootDir, outputPath);
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }
  const relOutput = relative(process.cwd(), outputDir);

  // ── Download translations ───────────────────────────────────────
  spinner.start(`Downloading ${bold(String(targetLocales.length))} locale(s)...`);

  const results: {
    locale: string;
    keys: number;
    size: number;
    ok: boolean;
    reason?: string;
    unchanged?: boolean;
  }[] = [];

  /* A schema-2 manifest carries each file's sha256. Remember the one that was
     verified and written, and skip a locale whose manifest entry still has it
     and whose file is still there. Nothing is skipped without a sha256. */
  const statePath = resolve(outputDir, PULL_STATE_FILE);
  const state = options.force ? {} : readPullState(statePath);

  for (const locale of targetLocales) {
    const manifestSha = manifest.files?.[locale]?.sha256?.toLowerCase();
    if (manifestSha && state[locale] === manifestSha && existsSync(resolve(outputDir, `${locale}.json`))) {
      results.push({ locale, keys: manifest.files?.[locale]?.keyCount ?? 0, size: 0, ok: true, unchanged: true });
      continue;
    }
    try {
      const translations = await fetchRemoteKeys(
        cdnBaseUrl,
        workspaceId,
        projectSlug,
        locale,
        manifest,
      );

      const namespaceCount = Object.keys(translations).length;
      const keyCount = countNestedKeys(translations);

      /* A locale the manifest counts as non-empty must not land on disk empty.
         The CDN answers some wrong paths with 200 + `{}`, so "no keys" is not
         proof of an empty project — writing it would ship an app with zero
         strings behind a green exit code. Fail the locale instead. */
      const expectedKeys =
        manifest.files?.[locale]?.keyCount ??
        manifest.languages.find((l) => l.code === locale)?.keyCount ??
        0;
      if (keyCount === 0 && expectedKeys > 0) {
        throw new Error(
          `CDN returned no keys, but the manifest expects ${expectedKeys}`,
        );
      }

      const json = JSON.stringify(translations, null, 2) + "\n";
      const filePath = resolve(outputDir, `${locale}.json`);
      writeFileSync(filePath, json, "utf-8");

      results.push({ locale, keys: keyCount, size: json.length, ok: true });
      if (manifestSha) state[locale] = manifestSha;

      if (options.verbose) {
        spinner.text = `Downloaded ${bold(locale)} — ${namespaceCount} namespaces, ${keyCount} keys`;
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      results.push({ locale, keys: 0, size: 0, ok: false, reason });
    }
  }

  writePullState(statePath, state);

  // ── Summary ─────────────────────────────────────────────────────
  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  if (succeeded.length > 0) {
    spinner.succeed(
      `Downloaded ${bold(String(succeeded.filter((r) => !r.unchanged).length))} of ${succeeded.length} locale(s) to ${cyan(relOutput + "/")}`,
    );

    console.log();
    for (const r of succeeded) {
      if (r.unchanged) {
        console.log(`  ${dim("=")} ${bold(r.locale.padEnd(6))} ${dim("unchanged, not downloaded")}`);
        continue;
      }
      const sizeStr = formatBytes(r.size);
      console.log(`  ${green("✓")} ${bold(r.locale.padEnd(6))} ${dim(String(r.keys).padStart(5) + " keys")}  ${dim(sizeStr)}`);
    }
  }

  if (failed.length > 0) {
    console.log();
    for (const r of failed) {
      console.log(
        `  ${red("✗")} ${bold(r.locale.padEnd(6))} ${red(r.reason ?? "failed")}`,
      );
    }
  }

  // ── Usage hint ──────────────────────────────────────────────────
  console.log();
  console.log(dim("  Use as offline fallback in your app:"));
  console.log(dim(`    staticData: { ${targetLocales.map((l) => `${l}: require('./${relOutput}/${l}.json')`).join(", ")} }`));
  console.log();

  if (failed.length > 0) {
    process.exit(1);
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

const PULL_STATE_FILE = ".pull-state.json";

function readPullState(path: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter(([, v]) => typeof v === "string")) as Record<string, string>;
  } catch {
    return {};
  }
}

function writePullState(path: string, state: Record<string, string>): void {
  if (Object.keys(state).length > 0) writeFileSync(path, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

function countNestedKeys(obj: Record<string, unknown>): number {
  let count = 0;
  for (const [, value] of Object.entries(obj)) {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      count += countNestedKeys(value as Record<string, unknown>);
    } else {
      count++;
    }
  }
  return count;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
