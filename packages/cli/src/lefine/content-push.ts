/**
 * `lefine content push`: content types kept in code (`lefine.config.ts`, see lefine/content/config)
 * made true in a Content project, diff first. Each type is new (created), the same (left alone) or changed; a field change is
 * checked by the server (content.collections.previewChange) and shown as safe, breaking or destructive with the pages it touches.
 * Nothing is written before the person says yes (or --yes), --dry-run never writes, and a change of a type asks first in Lefine
 * (the update action waits for a person, like publish). A type in Lefine that is not in the file is listed and left alone:
 * the push never deletes. Payload has no equivalent (its config is the database schema); this is our own design.
 *
 * The config is code the person keeps in their own repo and runs this command on, like drizzle.config.ts or payload.config.ts.
 * A .ts file needs a runtime that strips types (bun, or Node 22.6+ with type stripping); .mjs, .js and .json work everywhere.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { bold, dim, green, red, yellow } from "../utils/colors.js";
import { openInBrowser, out } from "./auth-commands.js";
import { callWithApproval, createOpClient, LefineError, type OpClient } from "./client.js";
import type { ContentOptions } from "./content-manage.js";
import { failContent, pickContentProject } from "./content-types.js";
import { resolveLefineAuth } from "./credentials.js";
import { safeText as s } from "./safe-text.js";
import { confirmOrExplain, type Ask } from "./strings-commands.js";

export const CONFIG_FILES = ["lefine.config.ts", "lefine.config.mts", "lefine.config.mjs", "lefine.config.js", "lefine.config.json"] as const;

export interface ContentPushOptions extends ContentOptions {
  /** The config file; default: the first of CONFIG_FILES in --dir or the current directory. */
  config?: string;
  dir?: string;
  dryRun?: boolean;
}

interface TypeConfig {
  slug: string;
  kind?: "collection" | "global";
  labels: { singular: string; plural?: string };
  useAsTitle?: string;
  fields: unknown[];
}
interface Config {
  project?: string;
  types: TypeConfig[];
}

interface Change {
  path: string;
  label: string;
  class: "safe" | "breaking" | "destructive";
  note: string;
  pages: number;
}
export type PlannedType =
  | { slug: string; action: "create"; config: TypeConfig }
  | { slug: string; action: "same" }
  | { slug: string; action: "update"; config: TypeConfig; collectionId: string; schemaVersion: number; plural: string; class: Change["class"]; changes: Change[]; labels: boolean; title: boolean }
  | { slug: string; action: "not-in-file" };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The config as data, checked enough to give a sentence instead of a server error. */
export function checkConfig(value: unknown, file: string): Config {
  const config = isObject(value) && "default" in value && isObject(value.default) ? value.default : value;
  if (!isObject(config) || !Array.isArray(config.types)) throw new Error(`${file} must export default defineContent({ types: [...] }).`);
  const seen = new Set<string>();
  config.types.forEach((t, i) => {
    const where = `${file}: types[${i}]`;
    if (!isObject(t) || typeof t.slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(t.slug)) throw new Error(`${where} needs a slug of lowercase letters, digits and dashes.`);
    if (seen.has(t.slug)) throw new Error(`${where}: "${t.slug}" is in the file twice.`);
    seen.add(t.slug);
    if (!isObject(t.labels) || typeof t.labels.singular !== "string" || !t.labels.singular.trim()) throw new Error(`${where} (${t.slug}) needs labels.singular.`);
    if (!Array.isArray(t.fields) || t.fields.length === 0) throw new Error(`${where} (${t.slug}) needs at least one field.`);
    if (t.kind !== undefined && t.kind !== "collection" && t.kind !== "global") throw new Error(`${where} (${t.slug}): kind is "collection" or "global".`);
  });
  if (config.project !== undefined && typeof config.project !== "string") throw new Error(`${file}: project is a prj_... id or a slug.`);
  return config as unknown as Config;
}

/** Finds and reads the config file. */
export async function loadContentConfig(options: { config?: string; dir?: string }): Promise<{ file: string; config: Config }> {
  const base = options.dir ?? process.cwd();
  const file = options.config ? resolve(base, options.config) : CONFIG_FILES.map((f) => resolve(base, f)).find((f) => existsSync(f));
  if (!file || !existsSync(file)) throw new Error(options.config ? `${options.config}: no such file.` : `No ${CONFIG_FILES.join(", ")} here. Write one with defineContent from lefine/content/config, or pass --config.`);
  if (file.endsWith(".json")) return { file, config: checkConfig(JSON.parse(readFileSync(file, "utf-8")), file) };
  try {
    return { file, config: checkConfig(await import(pathToFileURL(file).href), file) };
  } catch (err) {
    if (/\.m?ts$/.test(file) && err instanceof Error && /Unknown file extension|ERR_UNKNOWN_FILE_EXTENSION|Unexpected token|strip/i.test(err.message)) {
      throw new Error(`${file}: this Node cannot read TypeScript. Run the push with bun (bunx lefine content push), use Node 22.6+ with --experimental-strip-types, or rename it to lefine.config.mjs.`);
    }
    throw err;
  }
}

/** What the push would do, type by type, in the file's order; types only in Lefine last. Reads only. */
export async function planContentPush(ops: OpClient, projectId: string, config: Config): Promise<PlannedType[]> {
  const listed = await ops.callOp<{ items: Array<{ id: string; slug: string; kind: string }> }>("content.collections.list", { projectId });
  const bySlug = new Map(listed.items.map((c) => [c.slug, c]));
  const plan: PlannedType[] = [];
  for (const t of config.types) {
    const existing = bySlug.get(t.slug);
    if (!existing) {
      plan.push({ slug: t.slug, action: "create", config: t });
      continue;
    }
    const kind = t.kind ?? "collection";
    if (existing.kind !== kind) throw new Error(`${t.slug} is a ${existing.kind} in Lefine and a ${kind} in the file. A type's kind cannot change: give it another slug.`);
    const current = await ops.callOp<{ labels: { singular: string; plural: string }; schemaVersion: number; useAsTitle?: string | null }>("content.collections.get", { projectId, collectionId: existing.id });
    const check = await ops.callOp<{ class: Change["class"]; changes: Change[] }>("content.collections.previewChange", { projectId, collectionId: existing.id, fields: t.fields });
    const labels = current.labels.singular !== t.labels.singular || (t.labels.plural !== undefined && current.labels.plural !== t.labels.plural);
    const title = t.useAsTitle !== undefined && (current.useAsTitle ?? null) !== t.useAsTitle;
    if (check.changes.length === 0 && !labels && !title) plan.push({ slug: t.slug, action: "same" });
    else plan.push({ slug: t.slug, action: "update", config: t, collectionId: existing.id, schemaVersion: current.schemaVersion, plural: t.labels.plural ?? current.labels.plural, class: check.class, changes: check.changes, labels, title });
  }
  const inFile = new Set(config.types.map((t) => t.slug));
  for (const c of listed.items) if (!inFile.has(c.slug)) plan.push({ slug: c.slug, action: "not-in-file" });
  return plan;
}

const CLASS_COLOR = { safe: green, breaking: yellow, destructive: red } as const;

function printPlan(plan: PlannedType[], projectName: string): void {
  console.log(`\n  ${bold(s(projectName))}`);
  for (const p of plan) {
    if (p.action === "create") console.log(`  ${green("+")} ${s(p.slug)} ${dim(`new ${p.config.kind === "global" ? "global" : "content type"}, ${p.config.fields.length} field${p.config.fields.length === 1 ? "" : "s"}`)}`);
    else if (p.action === "same") console.log(`  ${dim("=")} ${s(p.slug)} ${dim("no change")}`);
    else if (p.action === "not-in-file") console.log(`  ${dim("·")} ${s(p.slug)} ${dim("in Lefine, not in the file: left alone")}`);
    else {
      console.log(`  ${CLASS_COLOR[p.class]("~")} ${s(p.slug)} ${CLASS_COLOR[p.class](p.class)}`);
      if (p.labels) console.log(`      ${dim("name:")} ${s(p.config.labels.singular)}`);
      if (p.title) console.log(`      ${dim("title field:")} ${s(p.config.useAsTitle ?? "")}`);
      for (const c of p.changes) console.log(`      ${CLASS_COLOR[c.class](c.class.padEnd(11))} ${s(c.label || c.path)}: ${s(c.note)}${c.pages > 0 ? dim(` (${c.pages} page${c.pages === 1 ? "" : "s"})`) : ""}`);
    }
  }
  console.log("");
}

interface Deps {
  ask?: Ask;
  openBrowser?: (url: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  approvalWaitMs?: number;
}

export async function contentPushCommand(options: ContentPushOptions, deps: Deps = {}): Promise<void> {
  try {
    const { file, config } = await loadContentConfig(options);
    const auth = resolveLefineAuth(options);
    if (!auth) throw new LefineError("UNAUTHORIZED", "no key");
    const ops = createOpClient(auth.apiUrl, auth.token);
    const project = await pickContentProject(ops, options.project ?? config.project);
    const plan = await planContentPush(ops, project.id, config);
    // New types first: a changed type may link to one of them (a relationship names its type).
    const todo = [...plan.filter((p) => p.action === "create"), ...plan.filter((p) => p.action === "update")] as Array<Extract<PlannedType, { action: "create" | "update" }>>;
    const summary = plan.map((p) => (p.action === "update" ? { slug: p.slug, action: p.action, class: p.class, changes: p.changes } : { slug: p.slug, action: p.action }));
    if (!options.json) printPlan(plan, project.name ?? project.id);

    if (todo.length === 0) {
      out(options.json, { project: project.id, file, plan: summary, applied: [] }, () => console.log("  Lefine already matches the file. Nothing to push."));
      return;
    }
    if (options.dryRun) {
      out(options.json, { project: project.id, file, plan: summary, applied: [], dryRun: true }, () => console.log(`  Dry run: ${todo.length} type${todo.length === 1 ? "" : "s"} would change. Nothing was written.`));
      return;
    }
    if (!(await confirmOrExplain(`Push ${todo.length} type${todo.length === 1 ? "" : "s"} to ${s(project.name ?? project.id)}?`, options, deps.ask))) {
      out(options.json, { project: project.id, file, plan: summary, applied: [] }, () => console.log("  Cancelled. Nothing was written."));
      return;
    }

    const applied: string[] = [];
    for (const p of todo) {
      if (p.action === "create") {
        await ops.callOp("content.collections.create", {
          projectId: project.id,
          slug: p.slug,
          kind: p.config.kind ?? "collection",
          labels: p.config.labels,
          ...(p.config.useAsTitle ? { useAsTitle: p.config.useAsTitle } : {}),
          fields: p.config.fields,
        });
      } else {
        // A change of a type asks first: a person approves it in Lefine (the card shows the same plan as above).
        await callWithApproval(
          ops,
          "content.collections.update",
          {
            projectId: project.id,
            collectionId: p.collectionId,
            expectedSchemaVersion: p.schemaVersion,
            labels: { singular: p.config.labels.singular, plural: p.plural },
            ...(p.config.useAsTitle ? { useAsTitle: p.config.useAsTitle } : {}),
            fields: p.config.fields,
          },
          {
            why: `Changing ${s(p.slug)} changes what pages hold`,
            openBrowser: deps.openBrowser ?? openInBrowser,
            say: (line: string) => (options.json ? console.error(line) : console.log(line)),
            ...(deps.sleep ? { sleep: deps.sleep } : {}),
            ...(deps.now ? { now: deps.now } : {}),
            ...(deps.approvalWaitMs !== undefined ? { waitMs: deps.approvalWaitMs } : {}),
          },
        );
      }
      applied.push(p.slug);
      if (!options.json) console.log(`  ${green("✓")} ${s(p.slug)} ${p.action === "create" ? "created" : "updated"}`);
    }
    out(options.json, { project: project.id, file, plan: summary, applied }, () => console.log(`\n  Pushed ${applied.length} type${applied.length === 1 ? "" : "s"}. Pages are not published by a push.`));
  } catch (err) {
    failContent(err, options.json);
  }
}
