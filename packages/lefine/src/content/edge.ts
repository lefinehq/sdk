/**
 * Reads published Content from the Lefine edge, following the SDK cache rule of lefine `docs/cdn-contract.md`:
 *  1. Revalidate the manifest, not the files: a memory copy for `manifestTtlMs`, then `If-None-Match`; 304 keeps the copy.
 *  2. A manifest with a lower `revision` than the copy is older (another data centre); the copy stays.
 *  3. A versioned file never changes: it is cached by URL and never revalidated. Its bytes are checked against the manifest's SHA-256.
 *  4. If the manifest cannot be read, the last copy keeps serving. Without a copy the error is thrown.
 *  5. A missing manifest (404) means nothing is published: `null`, never an error.
 */
import { cdnLocale } from "../locale.js";
import { sha256Hex } from "../strings/sha256.js";
import {
  ContentFetchError,
  ContentIntegrityError,
  type ContentFile,
  type ContentManifest,
} from "./types.js";

export type FetchLike = (
  input: string,
  init?: RequestInit,
) => Promise<Response>;

/** Extra fetch options per request kind; the Next.js helper uses it for `next: { revalidate, tags }`. */
export type FetchInit = (
  request:
    { kind: "manifest" } | { kind: "file"; locale: string; collection: string },
) => RequestInit | undefined;

export interface EdgeReaderOptions {
  cdnUrl: string;
  workspaceId: string;
  projectId: string;
  fetch: FetchLike;
  manifestTtlMs: number;
  timeoutMs: number;
  verify: boolean;
  fetchInit?: FetchInit;
  now?: () => number;
}

/** Most sites have a few types times a few languages; this bounds memory on a site with many releases. */
const MAX_CACHED_FILES = 200;

export interface EdgeReader {
  manifest(): Promise<ContentManifest | null>;
  /** The file of one language and content type named by `manifest`, or null when the manifest names none. */
  file<T>(
    manifest: ContentManifest,
    locale: string,
    collection: string,
  ): Promise<ContentFile<T> | null>;
  /** Forget the manifest copy (files stay: their URLs never change content). */
  reset(): void;
}

export function createEdgeReader(options: EdgeReaderOptions): EdgeReader {
  const now = options.now ?? Date.now;
  const base = `${options.cdnUrl.replace(/\/+$/, "")}/${options.workspaceId}/${options.projectId}/c`;
  let cached: {
    manifest: ContentManifest;
    etag: string | null;
    checkedAt: number;
  } | null = null;
  let inflight: Promise<ContentManifest | null> | null = null;
  const files = new Map<string, Promise<ContentFile<unknown>>>();

  async function request(
    url: string,
    init: RequestInit | undefined,
  ): Promise<Response> {
    const signal =
      typeof AbortSignal !== "undefined" && "timeout" in AbortSignal
        ? AbortSignal.timeout(options.timeoutMs)
        : undefined;
    try {
      return await options.fetch(url, {
        ...init,
        ...(signal ? { signal } : {}),
        headers: {
          Accept: "application/json",
          ...(init?.headers as Record<string, string> | undefined),
        },
      });
    } catch (error) {
      throw new ContentFetchError(
        `Could not reach the Lefine edge (${url}): ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async function loadManifest(): Promise<ContentManifest | null> {
    const url = `${base}/manifest.json`;
    const init = options.fetchInit?.({ kind: "manifest" });
    let res: Response;
    try {
      res = await request(url, {
        ...init,
        headers: {
          ...(init?.headers as Record<string, string> | undefined),
          ...(cached?.etag ? { "If-None-Match": cached.etag } : {}),
        },
      });
    } catch (error) {
      if (cached) return cached.manifest;
      throw error;
    }
    if (res.status === 304 && cached) {
      cached.checkedAt = now();
      return cached.manifest;
    }
    if (res.status === 404) {
      cached = null;
      return null;
    }
    if (!res.ok) {
      if (cached) return cached.manifest;
      throw new ContentFetchError(
        `The Lefine edge answered ${res.status} for ${url}`,
        res.status,
      );
    }
    const manifest = (await res.json()) as ContentManifest;
    if (
      manifest?.schema !== 1 ||
      typeof manifest.revision !== "number" ||
      typeof manifest.files !== "object"
    ) {
      if (cached) return cached.manifest;
      throw new ContentFetchError(
        `${url} is not a content manifest this SDK can read`,
      );
    }
    if (cached && manifest.revision < cached.manifest.revision) {
      cached.checkedAt = now();
      return cached.manifest;
    }
    cached = { manifest, etag: res.headers.get("etag"), checkedAt: now() };
    return manifest;
  }

  async function loadFile<T>(
    url: string,
    sha256: string,
    locale: string,
    collection: string,
  ): Promise<ContentFile<T>> {
    const res = await request(
      url,
      options.fetchInit?.({ kind: "file", locale, collection }),
    );
    if (!res.ok)
      throw new ContentFetchError(
        `The Lefine edge answered ${res.status} for ${url}`,
        res.status,
      );
    const text = await res.text();
    if (options.verify) {
      // Synchronous (strings/sha256.ts): with Cache Components an await on crypto.subtle stops `next build`.
      const actual = sha256Hex(new TextEncoder().encode(text));
      if (actual !== sha256)
        throw new ContentIntegrityError(url);
    }
    return JSON.parse(text) as ContentFile<T>;
  }

  return {
    manifest() {
      if (cached && now() - cached.checkedAt < options.manifestTtlMs)
        return Promise.resolve(cached.manifest);
      inflight ??= loadManifest().finally(() => {
        inflight = null;
      });
      return inflight;
    },

    file<T>(manifest: ContentManifest, locale: string, collection: string) {
      const lc = cdnLocale(locale);
      const entry = manifest.files[lc]?.[collection];
      if (!entry) return Promise.resolve(null);
      const url = `${base}/v/${entry.version}/${lc}/${collection}.json`;
      let pending = files.get(url) as Promise<ContentFile<T>> | undefined;
      if (!pending) {
        pending = loadFile<T>(url, entry.sha256, lc, collection);
        files.set(url, pending);
        if (files.size > MAX_CACHED_FILES)
          files.delete(files.keys().next().value as string);
        // A failed read is not kept: the next call tries again.
        pending.catch(() => files.delete(url));
      }
      return pending;
    },

    reset() {
      cached = null;
    },
  };
}
