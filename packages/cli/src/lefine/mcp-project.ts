/**
 * What the working folder says about its Lefine project, and names to ids for the local tools.
 *
 * `lefine.ts` (written by `npx lefine init`) names the Strings app, `lefine.config.*` names the Content
 * project. Both are READ AS TEXT. They are never imported or run: a cloned repository must not get code
 * executed by an AI app starting this server.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { OpClient } from "./client.js";
import { itemsOf } from "./types.js";

export const APP_ID = /^app_[a-z0-9]{3,64}$/;
export const PROJECT_ID = /^prj_[A-Za-z0-9]{3,64}$/;

const LEFINE_FILES = ["lefine.ts", "src/lefine.ts", "lefine.tsx", "src/lefine.tsx"];
const CONFIG_FILES = ["lefine.config.ts", "lefine.config.mts", "lefine.config.mjs", "lefine.config.js", "lefine.config.json"];
const MAX_CONFIG_BYTES = 512_000;

export interface ProjectInfo {
  /** Strings app id (app_...), from lefine.ts. */
  appId?: string;
  /** The file it came from, relative to the folder. */
  appFile?: string;
  /** Content project: a prj_... id or a slug, from lefine.config.*. */
  contentProject?: string;
  contentFile?: string;
  /** Names of the content types written in lefine.config.* (slugs), when it lists them in plain text. */
  contentTypes?: string[];
  /** The source and target languages when lefine.ts names them. */
  locales?: string[];
}

function readSmall(path: string): string | null {
  try {
    const st = statSync(path);
    if (!st.isFile() || st.size > MAX_CONFIG_BYTES) return null;
    return readFileSync(path, "utf-8");
  } catch {
    return null;
  }
}

/** Reads lefine.ts and lefine.config.* in `dir`. Nothing is run. Empty when there is neither. */
export function readProjectInfo(dir: string): ProjectInfo {
  const info: ProjectInfo = {};
  for (const file of LEFINE_FILES) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    const text = readSmall(path);
    const id = text ? /project:\s*["'`](app_[a-z0-9]{3,64})["'`]/.exec(text)?.[1] : undefined;
    if (id) {
      info.appId = id;
      info.appFile = file;
      const locales = /locales:\s*\[([^\]]{0,400})\]/.exec(text ?? "")?.[1];
      if (locales) info.locales = [...locales.matchAll(/["'`]([A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8})*)["'`]/g)].map((m) => m[1]!);
      break;
    }
  }
  for (const file of CONFIG_FILES) {
    const path = join(dir, file);
    if (!existsSync(path)) continue;
    const text = readSmall(path);
    if (text === null) continue;
    const project = file.endsWith(".json") ? jsonProject(text) : /\bproject:\s*["'`]([A-Za-z0-9_-]{1,64})["'`]/.exec(text)?.[1];
    if (project) info.contentProject = project;
    info.contentFile = file;
    const slugs = [...text.matchAll(/\bslug:\s*["'`]([a-z0-9]+(?:-[a-z0-9]+)*)["'`]/g)].map((m) => m[1]!);
    if (slugs.length > 0) info.contentTypes = [...new Set(slugs)].slice(0, 50);
    break;
  }
  return info;
}

function jsonProject(text: string): string | undefined {
  try {
    const v = JSON.parse(text) as { project?: unknown };
    return typeof v.project === "string" ? v.project : undefined;
  } catch {
    return undefined;
  }
}

export class NameError extends Error {}

interface Named {
  id: string;
  slug?: string;
  name?: string;
}

/** One of `items` named by `wanted` (id, slug or name, any case). Says which exist when none or several fit. */
export function pickByName<T extends Named>(items: T[], wanted: string, what: string): T {
  const w = wanted.trim().toLowerCase();
  const exact = items.filter((i) => i.id.toLowerCase() === w || i.slug?.toLowerCase() === w || i.name?.toLowerCase() === w);
  if (exact.length === 1) return exact[0]!;
  const pool = exact.length > 1 ? exact : items.filter((i) => `${i.slug ?? ""} ${i.name ?? ""}`.toLowerCase().includes(w));
  if (pool.length === 1) return pool[0]!;
  const names = (pool.length > 1 ? pool : items).slice(0, 10).map((i) => `${i.name ?? i.slug ?? i.id} (${i.id})`);
  if (pool.length > 1) throw new NameError(`"${wanted}" fits ${pool.length} ${what}s: ${names.join(", ")}. Say which, or pass the id.`);
  throw new NameError(`No ${what} called "${wanted}".${names.length ? ` There are: ${names.join(", ")}.` : ""}`);
}

/** A Content project's id from a name, slug or id; without one, the folder's lefine.config project; else the only project. */
export async function resolveContentProject(ops: OpClient, wanted: string | undefined, dir: string): Promise<string> {
  const value = wanted?.trim() || readProjectInfo(dir).contentProject;
  if (value && PROJECT_ID.test(value)) return value;
  const items = itemsOf<Named>(await ops.callOp("content.projects.list", {}));
  if (!value) {
    if (items.length === 1) return items[0]!.id;
    throw new NameError(`Which project? ${items.length ? `There are: ${items.slice(0, 10).map((i) => `${i.name ?? i.slug} (${i.id})`).join(", ")}.` : "This workspace has none."}`);
  }
  return pickByName(items, value, "project").id;
}

export interface AppRef extends Named {
  sourceLocale: string;
  targetLocales: string[];
}

/** A Strings app from a name, slug or id; without one, the folder's lefine.ts app; else the only app. */
export async function resolveStringsApp(ops: OpClient, wanted: string | undefined, dir: string): Promise<AppRef> {
  const value = wanted?.trim() || readProjectInfo(dir).appId;
  const items = itemsOf<AppRef>(await ops.callOp("strings.apps.list", {}));
  if (!value) {
    if (items.length === 1) return items[0]!;
    throw new NameError(`Which app? ${items.length ? `There are: ${items.slice(0, 10).map((i) => `${i.name ?? i.slug} (${i.id})`).join(", ")}.` : "This workspace has none."}`);
  }
  return pickByName(items, value, "app");
}
