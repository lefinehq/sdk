/**
 * `createContentClient`: published pages from the edge, or drafts in preview. One client per project; keep it at module level so
 * its manifest and file cache are shared between requests.
 */
import { createEdgeReader, type FetchInit, type FetchLike } from "./edge.js";
import { cdnLocale } from "../locale.js";
import { localeChain } from "./locale.js";
import { createPreviewReader, type PreviewOptions } from "./preview.js";
import type { ContentEntry, ContentManifest, ContentModels } from "./types.js";

export const DEFAULT_CDN_URL = "https://cdn.lefine.ai";

export interface ContentClientConfig {
  /** `ws_...`: Lefine shows it next to the project id under Content > Delivery. */
  workspaceId: string;
  /** `prj_...`. */
  projectId: string;
  /** The edge origin. Default https://cdn.lefine.ai. */
  cdnUrl?: string;
  /**
   * The project's fallback language (the generated `lefineContent` carries it). A page not live in the language asked for is
   * read from its parent language (pt-BR -> pt), then from this one. Null: parents only.
   */
  fallbackLocale?: string | null;
  /** False: a page not live in the language asked for is missing. Default true. */
  fallback?: boolean;
  /** How long the manifest is trusted before it is asked again (with If-None-Match). Default 30 s, the edge's max-age. */
  manifestTtlMs?: number;
  /** Per request. Default 10 s. */
  timeoutMs?: number;
  /** Check each file's SHA-256 against the manifest. Default true. */
  verify?: boolean;
  /** Read drafts instead of what is published. Server only: the key is a secret. False or absent: published. */
  preview?: PreviewOptions | false;
  fetch?: FetchLike;
  /** Extra fetch options per request (the Next.js helper sets `next.revalidate` and tags). */
  fetchInit?: FetchInit;
}

export interface GetOptions {
  locale: string;
  slug?: string;
  id?: string;
}

export interface ContentClient<M extends object = ContentModels> {
  /** Every live page of a content type in `locale`, with pages only live in a fallback language after them. */
  list<C extends keyof M & string>(
    collection: C,
    options: { locale: string },
  ): Promise<Array<ContentEntry<M[C]>>>;
  /** One page by `slug` or `id`, or null. */
  get<C extends keyof M & string>(
    collection: C,
    options: GetOptions,
  ): Promise<ContentEntry<M[C]> | null>;
  /**
   * The one document of a global content type (a footer, the navigation) in `locale`, or in the next language of the chain when it
   * is not live there; null when it is live in none. A content type with a list throws: use list() or get().
   */
  global<C extends keyof M & string>(
    collection: C,
    options: { locale: string },
  ): Promise<ContentEntry<M[C]> | null>;
  /** Languages with at least one live page (lowercase). */
  languages(): Promise<string[]>;
  /**
   * The languages one page is live in (lowercase), for a language picker or hreflang links. Not the languages of the project:
   * a page that is only translated to some of them lists only those. Empty when the page is not live. Preview: every language
   * the draft has.
   */
  localesOf<C extends keyof M & string>(
    collection: C,
    page: { slug?: string; id?: string },
  ): Promise<string[]>;
  /** The raw manifest, or null when nothing is published. */
  manifest(): Promise<ContentManifest | null>;
  /** True when this client reads drafts. */
  readonly preview: boolean;
}

export function createContentClient<M extends object = ContentModels>(
  config: ContentClientConfig,
): ContentClient<M> {
  if (
    !/^ws_[a-z0-9_-]+$/i.test(config.workspaceId) ||
    !/^prj_[a-z0-9_-]+$/i.test(config.projectId)
  ) {
    throw new Error(
      `lefine/content: workspaceId and projectId are ids (ws_..., prj_...), never names: got "${config.workspaceId}", "${config.projectId}". Copy them in Lefine under Content, Delivery, or run \`npx lefine content types\` to write them for you.`,
    );
  }
  const fetchImpl: FetchLike =
    config.fetch ?? ((input, init) => globalThis.fetch(input, init));

  if (config.preview) {
    if (typeof window !== "undefined" && typeof document !== "undefined") {
      throw new Error(
        "[lefine/content] preview uses a secret key and runs on the server only",
      );
    }
    const reader = createPreviewReader(
      config.projectId,
      config.preview,
      fetchImpl,
    );
    return {
      preview: true,
      list: (collection, { locale }) => reader.list(collection, locale),
      get: (collection, { locale, slug, id }) =>
        reader.get(collection, locale, { slug, id }),
      global: (collection, { locale }) => reader.global(collection, locale),
      languages: async () => [],
      localesOf: (collection, page) => reader.localesOf(collection, page),
      manifest: async () => null,
    };
  }

  const edge = createEdgeReader({
    cdnUrl: config.cdnUrl ?? DEFAULT_CDN_URL,
    workspaceId: config.workspaceId,
    projectId: config.projectId,
    fetch: fetchImpl,
    manifestTtlMs: config.manifestTtlMs ?? 30_000,
    timeoutMs: config.timeoutMs ?? 10_000,
    verify: config.verify ?? true,
    fetchInit: config.fetchInit,
  });

  /** The languages to read for `locale`, from the manifest's languages. */
  const chainFor = (manifest: ContentManifest, locale: string) => {
    // The config wins; otherwise the manifest names the project's fallback language (`sourceLocale`, when the manifest has it).
    const chain = localeChain(
      locale,
      manifest.languages,
      config.fallbackLocale !== undefined
        ? config.fallbackLocale
        : manifest.fallbackLocale,
    );
    return config.fallback === false
      ? chain.filter((l) => l === cdnLocale(locale))
      : chain;
  };

  return {
    preview: false,

    async list(collection, { locale }) {
      const manifest = await edge.manifest();
      if (!manifest) return [];
      const asked = cdnLocale(locale);
      const out: Array<ContentEntry<M[typeof collection]>> = [];
      const seen = new Set<string>();
      for (const lc of chainFor(manifest, locale)) {
        const file = await edge.file<M[typeof collection]>(
          manifest,
          lc,
          collection,
        );
        for (const entry of file?.entries ?? []) {
          if (seen.has(entry.id)) continue;
          seen.add(entry.id);
          out.push({
            ...entry,
            locale: lc,
            isFallback: lc !== asked,
            draft: false,
          });
        }
      }
      return out;
    },

    async get(collection, { locale, slug, id }) {
      if (slug === undefined && id === undefined)
        throw new Error("[lefine/content] get needs a slug or an id");
      const manifest = await edge.manifest();
      if (!manifest) return null;
      const asked = cdnLocale(locale);
      for (const lc of chainFor(manifest, locale)) {
        const file = await edge.file<M[typeof collection]>(
          manifest,
          lc,
          collection,
        );
        const entry = file?.entries.find((e) =>
          id !== undefined ? e.id === id : e.slug === slug,
        );
        if (entry)
          return {
            ...entry,
            locale: lc,
            isFallback: lc !== asked,
            draft: false,
          };
      }
      return null;
    },

    async global(collection, { locale }) {
      const manifest = await edge.manifest();
      if (!manifest) return null;
      const asked = cdnLocale(locale);
      for (const lc of chainFor(manifest, locale)) {
        const file = await edge.file<M[typeof collection]>(manifest, lc, collection);
        if (!file) continue;
        if (file.kind !== "global")
          throw new Error(`[lefine/content] "${collection}" has a list of pages, not one document: use list() or get()`);
        const entry = file.entries[0];
        if (entry) return { ...entry, locale: lc, isFallback: lc !== asked, draft: false };
      }
      return null;
    },

    async languages() {
      return (await edge.manifest())?.languages ?? [];
    },

    async localesOf(collection, { slug, id }) {
      if (slug === undefined && id === undefined)
        throw new Error("[lefine/content] localesOf needs a slug or an id");
      const manifest = await edge.manifest();
      if (!manifest) return [];
      const out: string[] = [];
      for (const lc of manifest.languages) {
        const file = await edge.file(manifest, lc, collection);
        const entries = (file?.entries ?? []) as Array<{
          id: string;
          slug: string | null;
        }>;
        if (
          entries.some((e) =>
            id !== undefined ? e.id === id : e.slug === slug,
          )
        )
          out.push(lc);
      }
      return out;
    },

    manifest: () => edge.manifest(),
  };
}
