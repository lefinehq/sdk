/**
 * Draft preview through Lefine's ops API (`POST /v1/ops/content.*`, the same actions the CLI and MCP use). Needs a key with
 * `content:read`: a secret, so preview runs on the server only. Lefine has no public preview route yet (#26 slice 2); when it
 * lands, this file is the one to change.
 */
import { cdnLocale } from "../locale.js";
import { localeChain } from "./locale.js";
import { localizeData, type ModelField } from "./localize.js";
import { ContentPreviewError, type ContentEntry } from "./types.js";
import type { FetchLike } from "./edge.js";

export interface PreviewOptions {
  /** A Lefine key (`lfn_...`) with `content:read`. Never send it to a browser. */
  key: string;
  /** Default https://dash.lefine.ai. */
  apiUrl?: string;
}

interface ProjectOut {
  id: string;
  sourceLocale: string;
  targetLocales: string[];
  fallbackLocale: string | null;
}
interface CollectionOut {
  id: string;
  slug: string;
  kind: string;
}
interface EntrySummary {
  id: string;
  slug: string | null;
}
interface EntryOut extends EntrySummary {
  collectionId: string;
  data: Record<string, unknown>;
  locales?: Array<{ locale: string }>;
}

/** Preview reads at most this many pages for `list`; each page is its own request. */
export const PREVIEW_LIST_LIMIT = 50;

export interface PreviewReader {
  localesOf(
    collection: string,
    by: { slug?: string; id?: string },
  ): Promise<string[]>;
  list<T>(collection: string, locale: string): Promise<Array<ContentEntry<T>>>;
  get<T>(
    collection: string,
    locale: string,
    by: { slug?: string; id?: string },
  ): Promise<ContentEntry<T> | null>;
  global<T>(collection: string, locale: string): Promise<ContentEntry<T> | null>;
}

export function createPreviewReader(
  projectId: string,
  options: PreviewOptions,
  fetchImpl: FetchLike,
): PreviewReader {
  const apiUrl = (options.apiUrl ?? "https://dash.lefine.ai").replace(
    /\/+$/,
    "",
  );

  async function op<T>(name: string, input: unknown): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(`${apiUrl}/v1/ops/${name}`, {
        method: "POST",
        cache: "no-store",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          Authorization: `Bearer ${options.key}`,
        },
        body: JSON.stringify({ input }),
      });
    } catch (error) {
      throw new ContentPreviewError(
        "NETWORK",
        error instanceof Error ? error.message : String(error),
      );
    }
    const body = (await res.json().catch(() => null)) as {
      ok?: boolean;
      data?: T;
      error?: { code?: string; message?: string };
    } | null;
    if (body?.ok === true) return body.data as T;
    throw new ContentPreviewError(
      body?.error?.code ?? (res.status === 401 ? "UNAUTHORIZED" : "INTERNAL"),
      body?.error?.message ?? `HTTP ${res.status}`,
    );
  }

  async function context(collection: string, locale: string) {
    const [projects, collections] = await Promise.all([
      op<{ items: ProjectOut[] }>("content.projects.list", {}),
      op<{ items: CollectionOut[] }>("content.collections.list", { projectId }),
    ]);
    const project = projects.items.find((p) => p.id === projectId);
    if (!project)
      throw new ContentPreviewError(
        "NOT_FOUND",
        `This key cannot read project ${projectId}`,
      );
    const type = collections.items.find((c) => c.slug === collection);
    if (!type) return null;
    const model = await op<{ fields: ModelField[] }>(
      "content.collections.get",
      { projectId, collectionId: type.id },
    );
    const chain = localeChain(
      locale,
      [project.sourceLocale, ...project.targetLocales],
      project.fallbackLocale,
    );
    return { collectionId: type.id, kind: type.kind, fields: model.fields, chain };
  }

  function toEntry<T>(
    entry: EntryOut,
    fields: ModelField[],
    chain: string[],
    locale: string,
  ): ContentEntry<T> {
    const asked = cdnLocale(locale);
    const view = localizeData(
      fields,
      entry.data,
      chain.length > 0 ? chain : [asked],
    );
    const served = chain[0] ?? asked;
    return {
      id: entry.id,
      slug: entry.slug,
      publishedAt: null,
      data: view.data as T,
      fallbacks: view.fallbacks,
      locale: served,
      isFallback: served !== asked,
      draft: true,
    };
  }

  async function summaries(
    collectionId: string,
    max: number,
    stop?: (s: EntrySummary) => boolean,
  ): Promise<EntrySummary[]> {
    const out: EntrySummary[] = [];
    for (let offset = 0; out.length < max; offset += 50) {
      const page = await op<{ items: EntrySummary[]; total: number }>(
        "content.entries.list",
        { projectId, collectionId, limit: 50, offset },
      );
      out.push(...page.items);
      if (stop && page.items.some(stop)) break;
      if (page.items.length === 0 || offset + page.items.length >= page.total)
        break;
    }
    return out.slice(0, max);
  }

  return {
    async localesOf(collection: string, by: { slug?: string; id?: string }) {
      const ctx = await context(collection, "en");
      if (!ctx) return [];
      let id = by.id;
      if (!id && by.slug !== undefined)
        id = (
          await summaries(ctx.collectionId, 10_000, (s) => s.slug === by.slug)
        ).find((s) => s.slug === by.slug)?.id;
      if (!id) return [];
      const entry = await op<EntryOut>("content.entries.get", {
        projectId,
        entryId: id,
      }).catch(() => null);
      return entry && entry.collectionId === ctx.collectionId
        ? (entry.locales ?? []).map((l) => cdnLocale(l.locale))
        : [];
    },

    async list<T>(collection: string, locale: string) {
      const ctx = await context(collection, locale);
      if (!ctx) return [];
      const items = await summaries(ctx.collectionId, PREVIEW_LIST_LIMIT);
      const full = await Promise.all(
        items.map((s) =>
          op<EntryOut>("content.entries.get", { projectId, entryId: s.id }),
        ),
      );
      return full.map((e) => toEntry<T>(e, ctx.fields, ctx.chain, locale));
    },

    async global<T>(collection: string, locale: string) {
      const ctx = await context(collection, locale);
      if (!ctx) return null;
      if (ctx.kind !== "global") throw new Error(`[lefine/content] "${collection}" has a list of pages, not one document: use list() or get()`);
      const entry = await op<EntryOut>("content.globals.get", { projectId, collectionId: ctx.collectionId });
      return toEntry<T>(entry, ctx.fields, ctx.chain, locale);
    },

    async get<T>(
      collection: string,
      locale: string,
      by: { slug?: string; id?: string },
    ) {
      const ctx = await context(collection, locale);
      if (!ctx) return null;
      let id = by.id;
      if (!id && by.slug !== undefined) {
        const match = (
          await summaries(ctx.collectionId, 10_000, (s) => s.slug === by.slug)
        ).find((s) => s.slug === by.slug);
        id = match?.id;
      }
      if (!id) return null;
      let entry: EntryOut;
      try {
        entry = await op<EntryOut>("content.entries.get", {
          projectId,
          entryId: id,
        });
      } catch (error) {
        if (error instanceof ContentPreviewError && error.code === "NOT_FOUND")
          return null;
        throw error;
      }
      // An id of another content type is not this type's page.
      return entry.collectionId === ctx.collectionId
        ? toEntry<T>(entry, ctx.fields, ctx.chain, locale)
        : null;
    },
  };
}
