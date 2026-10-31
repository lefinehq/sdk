/**
 * `lefine init`: signs in when needed, picks the app, installs `lefine`, and writes what the app's framework needs
 * for a first translated page (init-scaffold.ts): lefine.ts with the app's id, and for Next proxy.ts and
 * app/[locale]/{layout,page}.tsx, for TanStack Start a route at /$locale. Nobody types the id, and code never holds
 * a name: an id survives renames and moves (names broke apps before). A file the app has is never replaced.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { select } from "@inquirer/prompts";
import { bold, dim, green } from "../utils/colors.js";
import { fail, loginCommand, out, type GlobalOptions } from "./auth-commands.js";
import { createOpClient } from "./client.js";
import { DEFAULT_CDN_URL, resolveLefineAuth } from "./credentials.js";
import { describeApp, detectFramework, installCommand, LOCALE, packageDeps, pickSample, planInit, renderNextLefine, type SampleText } from "./init-scaffold.js";
import { safeText } from "./safe-text.js";
import { itemsOf, type AppSummary } from "./types.js";

export interface InitOptions extends GlobalOptions {
  /** The app's id or slug, to skip the question (CI). */
  app?: string;
  dir?: string;
  /** Where lefine.ts goes, instead of the framework's place. */
  output?: string;
  force?: boolean;
  /** Commander's --no-install: do not add `lefine` to the app. */
  install?: boolean;
}

/** lefine.ts for one Next app. Pure. Refuses an id that is not Lefine's shape: it goes into code. */
export const renderLefineFile = (app: Pick<AppSummary, "id" | "name" | "sourceLocale" | "targetLocales">): string => renderNextLefine(app);

export type PickApp = (apps: AppSummary[]) => Promise<AppSummary>;
/** Runs the install; returns whether it worked. Injected in tests. */
export type RunInstall = (cmd: [string, ...string[]], cwd: string) => boolean;

const ask: PickApp = (apps) => select({ message: "Which app?", choices: apps.map((a) => ({ name: `${a.name} (${a.slug})`, value: a })) });
const runInstall: RunInstall = ([bin, ...args], cwd) => spawnSync(bin, args, { cwd, stdio: "inherit", shell: process.platform === "win32" }).status === 0;

/** The first plain text of the app's live source locale, for the starter page; null when nothing is live yet. */
async function liveSample(cdn: string, app: AppSummary): Promise<SampleText | null> {
  try {
    const signal = AbortSignal.timeout(5000);
    const manifest = (await (await fetch(`${cdn}/${app.id}/manifest.json`, { signal })).json()) as { files?: Record<string, { version?: string }> };
    const locale = app.sourceLocale.toLowerCase();
    const version = manifest.files?.[locale]?.version;
    if (!version || !/^[a-z0-9-]{1,64}$/.test(version)) return null;
    return pickSample(await (await fetch(`${cdn}/${app.id}/v/${version}/${locale}/translations.json`, { signal })).json());
  } catch {
    return null;
  }
}

export async function initCommand(options: InitOptions, pick: PickApp = ask, install: RunInstall = runInstall): Promise<void> {
  try {
    const dir = resolve(options.dir || process.cwd());
    const framework = detectFramework(dir);

    let auth = resolveLefineAuth(options);
    if (!auth) {
      await loginCommand({ apiUrl: options.apiUrl, json: options.json });
      auth = resolveLefineAuth(options);
      if (!auth) throw new Error("Not signed in. Run `lefine login`, then `lefine init` again.");
    }
    const apps = itemsOf<AppSummary>(await createOpClient(auth.apiUrl, auth.token).callOp("strings.apps.list", {}));
    if (apps.length === 0) throw new Error("This workspace has no app yet. Create one in Lefine, then run `lefine init` again.");

    let app: AppSummary | undefined;
    if (options.app) {
      app = apps.find((a) => a.id === options.app || a.slug === options.app);
      if (!app) throw new Error(`No app "${safeText(options.app)}" here. Apps: ${apps.map((a) => safeText(a.slug)).join(", ")}.`);
    } else if (apps.length === 1) app = apps[0];
    else if (!process.stdin.isTTY || options.json) {
      throw new Error(`This workspace has ${apps.length} apps. Pick one with --app: ${apps.map((a) => safeText(a.slug)).join(", ")}.`);
    } else app = await pick(apps);

    if (!LOCALE.test(app!.sourceLocale)) throw new Error(`Unexpected locale from the server: ${JSON.stringify(safeText(app!.sourceLocale))}`);
    // Another edge (staging, local) is written into the file, so the app reads where init looked.
    const cdnFlag = process.env.LEFINE_CDN_URL?.replace(/\/+$/, "");
    const cdn = cdnFlag && cdnFlag !== DEFAULT_CDN_URL ? cdnFlag : undefined;
    const plan = planInit(framework, dir, app!, await liveSample(cdn ?? DEFAULT_CDN_URL, app!), cdn);
    if (options.output) plan[0]!.path = options.output;
    const lefineFile = resolve(dir, plan[0]!.path);
    if (existsSync(lefineFile) && !options.force) throw new Error(`${lefineFile} exists. Run again with --force to replace it.`);

    const written: string[] = [];
    const kept: string[] = [];
    const removed: string[] = [];
    for (const [i, file] of plan.entries()) {
      const path = resolve(dir, file.path);
      // --force replaces lefine.ts only; the app's own pages are never replaced. `replaces`: create-next-app's root
      // layout, and only while it is still the text the plan read.
      const replacing = file.replaces !== undefined && existsSync(path) && readFileSync(path, "utf-8") === file.replaces;
      if (file.remove) {
        if (replacing) {
          unlinkSync(path);
          removed.push(file.path);
        }
        continue;
      }
      if (existsSync(path) && !replacing && !(i === 0 && options.force)) {
        kept.push(file.ifExists ?? `${file.path} exists, kept as it is.`);
        continue;
      }
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, file.content);
      written.push(file.path);
      if (file.note) kept.push(file.note);
    }

    let installed: boolean | null = null;
    if (options.install !== false && !packageDeps(dir).lefine && existsSync(resolve(dir, "package.json"))) {
      const cmd = installCommand(dir);
      if (!options.json) console.log(dim(`  ${cmd.join(" ")}`));
      installed = install(cmd, dir);
    }

    const { label, next } = describeApp(framework, dir);
    out(options.json, { app: app!.id, framework, written, removed, kept, installed }, () => {
      console.log(`  ${green("✓")} ${bold(safeText(app!.name))} (${label}): wrote ${written.join(", ") || "nothing"}.`);
      if (removed.length > 0) console.log(dim(`    Removed create-next-app's ${removed.join(", ")}: app/[locale]/layout.tsx is the root layout now, with its <html>, fonts and CSS; lang and dir follow the locale.`));
      for (const line of kept) console.log(dim(`    ${line}`));
      if (installed === false) console.log(`    Installing lefine failed. Run ${installCommand(dir).join(" ")}.`);
      console.log(dim(`    Next: ${next.replace("<locale>", app!.sourceLocale)}`));
    });
  } catch (err) {
    fail(err, options.json);
  }
}
