/**
 * `lefine strings snapshot`: the published texts as they are now, for a build step. `createLefine({ snapshot })` and
 * `createStrings({ snapshot })` serve the first request after a deploy from it, while the edge is asked in the
 * background (docs/benchmark.md: that request otherwise waits two round trips).
 *
 * The snapshot is made by lefine's own reader (`lefine/server` createSnapshot), so it is checked exactly as a render
 * checks the edge: sha256 and key count against the manifest. The CDN is public: no sign-in.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { green } from "../utils/colors.js";
import { fail, out } from "./auth-commands.js";
import { DEFAULT_CDN_URL } from "./credentials.js";
import { safeText } from "./safe-text.js";
import { resolveTarget, type StringsOptions } from "./strings-commands.js";

export interface SnapshotOptions extends StringsOptions {
  output?: string;
  cdnUrl?: string;
}

type CreateSnapshot = (config: { project: string; cdn?: string }) => Promise<Record<string, string>>;

/**
 * `createSnapshot` from the lefine package this command runs from (`npx lefine` is that package's bin): never a
 * module the app's directory points at, so the command runs no code of the project it is run in (a security
 * review asked for this). It is the package this file is in: its first package.json, which must be named "lefine".
 */
async function ownCreateSnapshot(): Promise<CreateSnapshot> {
  // The first package.json above this file is the package it belongs to: only that one counts, so the walk can never
  // climb into the project that holds the install (security review of 227ed75a).
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 4 && basename(dir) !== "node_modules"; i++) {
    const pkg = join(dir, "package.json");
    if (existsSync(pkg)) {
      if ((JSON.parse(readFileSync(pkg, "utf-8")) as { name?: string }).name === "lefine") {
        const mod = (await import(pathToFileURL(join(dir, "dist", "server", "index.js")).href)) as { createSnapshot?: CreateSnapshot };
        if (typeof mod.createSnapshot === "function") return mod.createSnapshot;
      }
      break;
    }
    dir = dirname(dir);
  }
  throw new Error("Run it as `npx lefine strings snapshot` (it uses the lefine package's own reader).");
}

export async function stringsSnapshotCommand(options: SnapshotOptions, deps: { load?: () => Promise<CreateSnapshot> } = {}): Promise<void> {
  try {
    const target = await resolveTarget(options);
    if (!target.appId) throw new Error("A snapshot is read by app id: pass --project app_... (see `lefine apps`), or run it next to the lefine.ts that `npx lefine init` wrote.");
    const cdn = (options.cdnUrl || process.env.LEFINE_CDN_URL || DEFAULT_CDN_URL).replace(/\/+$/, "");
    const createSnapshot = await (deps.load ?? ownCreateSnapshot)();
    const snapshot = await createSnapshot({ project: target.appId, cdn });
    const locales = Object.keys(snapshot).filter((k) => !k.endsWith(":manifest")).length;
    if (locales === 0) throw new Error(`Nothing is published for ${safeText(target.appId)} yet. Publish in Lefine, then run this again.`);
    const file = resolve(target.rootDir, options.output || "lefine-snapshot.json");
    writeFileSync(file, `${JSON.stringify(snapshot)}\n`);
    out(options.json, { file, app: target.appId, locales }, () => console.log(`  ${green("✓")} Wrote ${file}: ${locales} ${locales === 1 ? "language" : "languages"} of ${safeText(target.appId)}.`));
  } catch (err) {
    fail(err, options.json);
  }
}
