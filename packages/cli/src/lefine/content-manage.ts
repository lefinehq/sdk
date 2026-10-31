/**
 * `lefine content projects | pages | page <id> | publish <id>` (#30, "lefine content …"). Each is one action of
 * /v1/ops, the same ones the MCP server uses. A publish goes live, so a person approves it in Lefine, as a strings
 * publish does; the CLI opens the page and waits.
 */

import { bold, cyan, dim, green, yellow } from "../utils/colors.js";
import { openInBrowser, out, type GlobalOptions } from "./auth-commands.js";
import { callWithApproval, createOpClient, LefineError, type OpClient } from "./client.js";
import { failContent, pickContentProject } from "./content-types.js";
import { resolveLefineAuth } from "./credentials.js";
import { safeText as s } from "./safe-text.js";
import { canonicalLocale, confirmOrExplain, type Ask } from "./strings-commands.js";

export interface ContentOptions extends GlobalOptions {
  /** Content project id (prj_...) or slug; default: the workspace's only one. */
  project?: string;
  yes?: boolean;
}

interface ProjectRow {
  id: string;
  slug: string;
  name: string;
  sourceLocale: string;
  targetLocales: string[];
  collectionCount: number;
  entryCount: number;
}

interface TypeRow {
  id: string;
  slug: string;
  kind: string;
  labels: { singular: string; plural: string };
}

interface PageLocale {
  locale: string;
  status: string;
  publishedVersionNo: number | null;
}

interface RelatedPage {
  id: string;
  slug: string | null;
  title: string | null;
}

interface PageRow {
  id: string;
  collectionId: string;
  slug: string | null;
  title: string | null;
  headVersionNo: number;
  updatedAt: string;
  locales: PageLocale[];
  /** With --expand: the pages each relation field points at, one level deep. */
  relations?: Record<string, RelatedPage | RelatedPage[] | null>;
}

interface Page extends PageRow {
  data: Record<string, unknown>;
}

const items = <T>(v: unknown): T[] => ((v as { items?: T[] } | null)?.items ?? []) as T[];
const n = (v: unknown): number => (Number.isFinite(Number(v)) ? Number(v) : 0);

function client(options: GlobalOptions): OpClient {
  const auth = resolveLefineAuth(options);
  if (!auth) throw new LefineError("UNAUTHORIZED", "no key");
  return createOpClient(auth.apiUrl, auth.token);
}

/** Live `de` green; changes not live yet `de*` yellow; scheduled `de@`; not live `de-` dim. The marks say it without color too. */
const localeLine = (locales: PageLocale[]) =>
  locales
    .map((l) =>
      l.status === "published" ? green(s(l.locale)) : l.status === "changed" ? yellow(`${s(l.locale)}*`) : l.status === "scheduled" ? yellow(`${s(l.locale)}@`) : dim(`${s(l.locale)}-`),
    )
    .join(" ");

// ── lefine content projects ───────────────────────────────────────────

export async function contentProjectsCommand(options: GlobalOptions): Promise<void> {
  try {
    const projects = items<ProjectRow>(await client(options).callOp("content.projects.list", {}));
    out(options.json, { items: projects }, () => {
      console.log();
      if (projects.length === 0) console.log("  No Content project yet. Create one in Lefine.");
      for (const p of projects) {
        console.log(`  ${bold(s(p.name))} ${dim(`(${s(p.slug)})`)}  ${cyan(s(p.id))}`);
        console.log(dim(`    ${[p.sourceLocale, ...p.targetLocales].map(s).join(", ")}  ·  ${n(p.collectionCount)} types, ${n(p.entryCount)} pages`));
      }
      console.log();
    });
  } catch (err) {
    failContent(err, options.json);
  }
}

// ── lefine content pages ──────────────────────────────────────────────

export interface ContentPagesOptions extends ContentOptions {
  /** A content type's slug or id. */
  type?: string;
  search?: string;
  /** Only pages that still need this language. */
  missing?: string;
  /** Comma-separated slugs. */
  slug?: string;
  /** published | changed | not-published | offline | scheduled, in --locale. */
  status?: string;
  /** The language --status and a translated --where field are read in (default: the main language). */
  locale?: string;
  /** Repeatable: field=value (text) or field:=json (true, 3, null, "x"). */
  where?: string[];
  /** Comma-separated relation fields. */
  expand?: string;
  sort?: string;
  order?: string;
  limit?: string;
  all?: boolean;
}

const STATUSES = ["published", "changed", "not-published", "offline", "scheduled"];
const FIELD = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const list = (raw: string | undefined) => (raw ?? "").split(",").map((v) => v.trim()).filter(Boolean);

/** `--where` pairs as the API's `where`: field=value is text, field:=json a typed value (featured:=true, views:=3). */
export function parseWhere(pairs: string[] = []): Record<string, string | number | boolean | null> | undefined {
  if (pairs.length === 0) return undefined;
  if (pairs.length > 10) throw new Error("--where takes 10 fields at most.");
  const where: Record<string, string | number | boolean | null> = {};
  for (const pair of pairs) {
    const typed = /^([^:=]+):=(.*)$/s.exec(pair);
    const text = typed ? null : /^([^=]+)=(.*)$/s.exec(pair);
    const name = (typed ?? text)?.[1]?.trim();
    if (!name || !FIELD.test(name)) throw new Error(`--where "${s(pair)}": write field=value (text) or field:=json (true, 3, null).`);
    if (Object.hasOwn(where, name)) throw new Error(`--where names "${s(name)}" twice.`);
    if (typed) {
      let value: unknown;
      try {
        value = JSON.parse(typed[2]!);
      } catch {
        throw new Error(`--where ${s(name)}:= takes JSON: true, false, null, a number or "text".`);
      }
      if (value !== null && !["string", "number", "boolean"].includes(typeof value)) throw new Error(`--where ${s(name)}:= takes one value, not a list or an object.`);
      where[name] = value as string | number | boolean | null;
    } else {
      where[name] = text![2]!;
    }
  }
  return where;
}

export async function contentPagesCommand(options: ContentPagesOptions): Promise<void> {
  try {
    const ops = client(options);
    const project = await pickContentProject(ops, options.project);
    const limit = options.limit === undefined ? 20 : Number(options.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error("--limit takes 1 to 50.");
    const types = items<TypeRow>(await ops.callOp("content.collections.list", { projectId: project.id }));
    let collectionId: string | undefined;
    if (options.type) {
      const type = types.find((t) => t.id === options.type || t.slug === options.type);
      if (!type) throw new Error(`No content type "${s(options.type)}" in ${s(project.name ?? project.id)}. Types: ${types.map((t) => s(t.slug)).join(", ") || "none"}.`);
      collectionId = type.id;
    }
    const slugs = list(options.slug);
    if (slugs.length > 50) throw new Error("--slug takes 50 slugs at most.");
    if (options.status && !STATUSES.includes(options.status)) throw new Error(`--status takes ${STATUSES.join(", ")}.`);
    if (options.sort && !["updatedAt", "createdAt"].includes(options.sort)) throw new Error("--sort takes updatedAt or createdAt.");
    if (options.order && !["asc", "desc"].includes(options.order)) throw new Error("--order takes asc or desc.");
    const where = parseWhere(options.where);
    const expand = list(options.expand);
    if (expand.length > 5) throw new Error("--expand takes 5 relation fields at most.");
    for (const name of expand) if (!FIELD.test(name)) throw new Error(`--expand "${s(name)}" is not a field name.`);
    if ((where || expand.length > 0) && !collectionId) throw new Error("--where and --expand name fields of one content type: add --type <slug>.");
    const filters = {
      ...(slugs.length > 0 ? { slugs } : {}),
      ...(options.status ? { status: options.status } : {}),
      ...(options.locale ? { locale: canonicalLocale(options.locale) } : {}),
      ...(where ? { where } : {}),
      ...(expand.length > 0 ? { expand } : {}),
      ...(options.sort ? { sort: options.sort } : {}),
      ...(options.order ? { order: options.order } : {}),
    };
    const pages: PageRow[] = [];
    let total = 0;
    for (let offset = 0; ; offset += limit) {
      const page = await ops.callOp<{ items: PageRow[]; total: number }>("content.entries.list", {
        projectId: project.id,
        limit,
        offset,
        ...(collectionId ? { collectionId } : {}),
        ...(options.search ? { search: options.search } : {}),
        ...(options.missing ? { missingLocale: canonicalLocale(options.missing) } : {}),
        ...filters,
      });
      pages.push(...page.items);
      total = n(page.total);
      if (!options.all || page.items.length < limit || pages.length >= total) break;
    }
    const typeOf = new Map(types.map((t) => [t.id, t.slug]));
    out(options.json, { items: pages, total }, () => {
      console.log();
      if (pages.length === 0) console.log(options.missing ? `  Every page has ${s(options.missing)}.` : Object.keys(filters).length > 0 ? "  No page matches." : "  No pages.");
      for (const p of pages) {
        console.log(`  ${cyan(s(p.id))}  ${dim(s(typeOf.get(p.collectionId) ?? ""))}  ${bold(s(p.title ?? p.slug ?? "(untitled)"))}`);
        console.log(`    ${localeLine(p.locales)}  ${dim(`v${n(p.headVersionNo)}, ${s(p.updatedAt)}`)}`);
        for (const [field, related] of Object.entries(p.relations ?? {})) {
          const named = (r: RelatedPage) => `${s(r.title ?? r.slug ?? "(untitled)")} ${dim(`(${s(r.id)})`)}`;
          const shown = related === null || (Array.isArray(related) && related.length === 0) ? dim("none") : Array.isArray(related) ? related.map(named).join(", ") : named(related);
          console.log(`    ${dim(`${s(field)}:`)} ${shown}`);
        }
      }
      console.log(dim(`\n  ${pages.length} of ${total} pages${pages.length < total ? ", more: add --all" : ""}. de is live, de* has changes not live, de@ is scheduled, de- is not live.`));
      console.log();
    });
  } catch (err) {
    failContent(err, options.json);
  }
}

// ── lefine content page <id> ──────────────────────────────────────────

const ENTRY_ID = /^ent_[A-Za-z0-9]+$/;

function entryId(id: string): string {
  if (!ENTRY_ID.test(id)) throw new Error(`"${s(id)}" is not a page id (ent_...). Find it with \`lefine content pages\`.`);
  return id;
}

export async function contentPageCommand(id: string, options: ContentOptions): Promise<void> {
  try {
    const ops = client(options);
    const project = await pickContentProject(ops, options.project);
    const page = await ops.callOp<Page>("content.entries.get", { projectId: project.id, entryId: entryId(id) });
    out(options.json, page, () => {
      console.log();
      console.log(`  ${bold(s(page.title ?? page.slug ?? "(untitled)"))}  ${cyan(s(page.id))}  ${dim(`v${n(page.headVersionNo)}`)}`);
      console.log(`  ${localeLine(page.locales)}`);
      // The page's own texts: printed without escape sequences, as everything the server sends.
      for (const line of JSON.stringify(page.data ?? {}, null, 2).split("\n")) console.log(`  ${s(line)}`);
      console.log();
    });
  } catch (err) {
    failContent(err, options.json);
  }
}

// ── lefine content publish <id> ───────────────────────────────────────

export interface ContentPublishOptions extends ContentOptions {
  /** Comma-separated languages; default: every language of the project. */
  locales?: string;
  approval?: string;
}

interface Approvals {
  ask?: Ask;
  openBrowser?: (url: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  approvalWaitMs?: number;
}

export async function contentPublishCommand(id: string, options: ContentPublishOptions, deps: Approvals = {}): Promise<void> {
  try {
    const ops = client(options);
    const project = await pickContentProject(ops, options.project);
    const page = await ops.callOp<Page>("content.entries.get", { projectId: project.id, entryId: entryId(id) });
    const all = [project.sourceLocale, ...project.targetLocales];
    const locales = options.locales
      ? [...new Set(options.locales.split(",").map((l) => l.trim()).filter(Boolean).map(canonicalLocale))]
      : all;
    const unknown = locales.filter((l) => !all.some((a) => a.toLowerCase() === l.toLowerCase()));
    if (locales.length === 0) throw new Error("--locales names no language.");
    if (unknown.length > 0) throw new Error(`${unknown.map(s).join(", ")}: not a language of ${s(project.name ?? project.id)} (${all.map(s).join(", ")}).`);

    const title = s(page.title ?? page.slug ?? page.id);
    if (!options.json) console.log(`\n  ${bold(title)} ${dim(`v${n(page.headVersionNo)}`)} → ${locales.map(s).join(", ")}\n`);
    if (!(await confirmOrExplain(`Publish "${title}" in ${locales.map(s).join(", ")}?`, options, deps.ask))) {
      out(options.json, { published: false }, () => console.log("  Cancelled. Nothing was published."));
      return;
    }
    // Bound to the version shown: if someone saves the page meanwhile, the server refuses instead of publishing it.
    const input = { projectId: project.id, entryId: page.id, locales, expectedVersionNo: page.headVersionNo };
    const saved = await (options.approval
      ? ops.callOp<{ id: string; headVersionNo: number; locales: PageLocale[] }>("content.entries.publish", input, { approval: options.approval })
      : callWithApproval<{ id: string; headVersionNo: number; locales: PageLocale[] }>(ops, "content.entries.publish", input, {
          openBrowser: deps.openBrowser ?? openInBrowser,
          say: (line: string) => (options.json ? console.error(line) : console.log(line)),
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
          ...(deps.now ? { now: deps.now } : {}),
          ...(deps.approvalWaitMs !== undefined ? { waitMs: deps.approvalWaitMs } : {}),
        })
    ).catch((err: unknown) => {
      if (err instanceof LefineError && err.code === "APPROVAL_PENDING" && err.approval) {
        throw new Error(`Once a person approves ${err.approval.url} , run lefine content publish ${page.id} --locales ${locales.join(",")} --yes --approval ${err.approval.id}.`);
      }
      throw err;
    });
    out(options.json, { published: true, ...saved }, () => console.log(`  ${green("✓")} Published ${title} in ${locales.map(s).join(", ")}. ${localeLine(saved.locales ?? [])}`));
  } catch (err) {
    failContent(err, options.json);
  }
}
