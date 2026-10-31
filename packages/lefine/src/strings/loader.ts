/**
 * Strings from the Lefine edge: the manifest, then each locale's versioned file. Ours, no dependency; the rules
 * are the ones @better-i18n/core follows for a schema-2 manifest (ported, not imported):
 *
 *  - The manifest is asked for with If-None-Match; a 304 keeps the copy we have.
 *  - A manifest with a lower `revision` than the one we have is older: ignored.
 *  - A locale is fetched again only when its `version` or `sha256` changed, from the immutable
 *    `{base}/{project}/v/{version}/{locale}/translations.json` (built here, never taken from the manifest's url).
 *  - A download must match the manifest's `sha256` (synchronous, sha256.ts) and `keyCount`, and is
 *    never `{}`. Anything else keeps the last verified copy; with none, it throws.
 *  - Next to it, `messages.ir.json` (written at publish) is asked for only when the manifest entry says `ir: true`,
 *    and used when its `format` is known and its `sha256` is the manifest's. Otherwise `ir` is null and the caller
 *    compiles. A listed file that cannot be used is not asked for again.
 *
 * `project` is the app's id (`app_...`): the edge serves `/{appId}/...` and an id survives renames and moves.
 * One loader per app; keep it at module scope on a server.
 */

import { cdnLocale } from "../locale.js";
import { IR_FORMAT, type IrFile, type MessageTree } from "./ir.js";
import { sha256Hex } from "./sha256.js";

/**
 * Elapsed time for the manifest TTL and the retry window. A monotonic timer, not the wall clock: Next 16 with
 * cacheComponents refuses Date.now() while prerendering ("blocking-prerender-current-time") and allows timing APIs.
 */
const clock: () => number = typeof performance !== "undefined" && typeof performance.now === "function" ? () => performance.now() : Date.now;

export const DEFAULT_CDN_URL = "https://cdn.lefine.ai";
const VERSION = /^[a-z0-9]{6,12}-[a-z0-9]{4,12}$/;
const RETRY_MS = 30_000;
const APP_ID = /^app_[a-z0-9]{3,64}$/;
const LOCALE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/;

export interface ManifestFile {
  version?: string;
  sha256?: string;
  keyCount?: number;
  /** The publish wrote `messages.ir.json` next to the file. Only then is it asked for (no 404 per locale). */
  ir?: boolean;
}

export interface Manifest {
  sourceLanguage?: string;
  languages: Array<{ code: string; name?: string; nativeName?: string; isSource?: boolean; flagUrl?: string | null }>;
  files?: Record<string, ManifestFile | undefined>;
  schema?: number;
  revision?: number;
  version?: string;
}

export interface LoadedLocale {
  locale: string;
  /** The file as served: `{ namespace: { key: text } }`. */
  texts: Record<string, unknown>;
  /** The compiled form from the edge, or null (compile `texts`). */
  ir: MessageTree | null;
  /** `version:sha256` of the file: changes only when its bytes change. */
  stamp: string;
  /** True when this is the last verified copy because a fresh one could not be had. */
  stale: boolean;
}

export interface LoaderConfig {
  /** The app's id, `app_...` (Lefine: Settings, App, App id; or `npx lefine init` writes it). */
  project: string;
  cdnBaseUrl?: string;
  fetch?: typeof fetch;
  /** How long the manifest is trusted before it is asked for again. Default 60 s. */
  manifestTtlMs?: number;
  /** Per request. Default 10 s. */
  timeoutMs?: number;
  /** Keeps the last manifest and language files on the device, for a start without network (React Native). */
  storage?: StringsStorage;
  /**
   * Past the TTL, answer with what is in memory at once and ask the edge in the background (one request in flight
   * per process); a new release shows from the next render. Off by default: a call past the TTL waits for the edge.
   */
  staleWhileRevalidate?: boolean;
  /**
   * One request in flight per manifest or file, shared by every caller (default true). lefine/next turns it off:
   * Next's cache already holds each answer, and with Cache Components a render that awaits a promise another render
   * (the layout's Provider, the page's getStrings) started counts as uncached data, so `next build` stops.
   */
  shareInFlight?: boolean;
}

/**
 * Where the app keeps strings between launches. Two async calls, so any store fits; lefine depends on none.
 *   AsyncStorage: `{ get: (k) => AsyncStorage.getItem(k), set: (k, v) => AsyncStorage.setItem(k, v) }`
 *   MMKV:         `{ get: async (k) => mmkv.getString(k), set: async (k, v) => mmkv.set(k, v) }`
 */
export interface StringsStorage {
  get(key: string): Promise<string | null | undefined>;
  set(key: string, value: string): Promise<unknown>;
}

export class IntegrityError extends Error {
  constructor(message: string) {
    super(`lefine: ${message}`);
    this.name = "IntegrityError";
  }
}

export interface StringsLoader {
  manifest(): Promise<Manifest>;
  /** Locale codes as the CDN spells them (lowercase). */
  locales(): Promise<string[]>;
  load(locale: string): Promise<LoadedLocale>;
}


const countKeys = (value: unknown): number => {
  if (!value || typeof value !== "object") return 0;
  let n = 0;
  for (const v of Object.values(value)) n += v && typeof v === "object" ? countKeys(v) : 1;
  return n;
};

const isTree = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

export function createStringsLoader(config: LoaderConfig): StringsLoader {
  if (!APP_ID.test(config.project)) {
    throw new Error(
      `lefine: project must be the app's id (app_...), not its name: got "${config.project}". ` +
        "Copy it in Lefine under Settings, App, App id, or run `npx lefine init` to write it for you.",
    );
  }
  const base = `${(config.cdnBaseUrl ?? DEFAULT_CDN_URL).replace(/\/+$/, "")}/${config.project}`;
  const doFetch = config.fetch ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const ttl = config.manifestTtlMs ?? 60_000;
  const swr = config.staleWhileRevalidate === true;
  const timeout = config.timeoutMs ?? 10_000;
  const share = config.shareInFlight !== false;

  let current: { manifest: Manifest; etag: string | null; at: number } | null = null;
  let pending: Promise<Manifest> | null = null;
  const verified = new Map<string, LoadedLocale>();
  const inFlight = new Map<string, Promise<LoadedLocale>>();
  // A version that failed to download is not asked for again on every render: once per RETRY_MS.
  const failedAt = new Map<string, number>();
  /** Versions whose compiled file was listed but could not be used: not asked for again. */
  const irMissing = new Set<string>();

  const get = (url: string, headers: Record<string, string> = {}) =>
    doFetch(url, { headers: { Accept: "application/json", ...headers }, cache: "no-store", signal: AbortSignal.timeout(timeout) });

  // ── The device copy (config.storage). Only what was verified is written; what is read is checked again, and a
  // broken or foreign value is ignored. Storage errors never reach the app: it is a cache.
  const store = config.storage;
  const storeKey = (name: string) => `lefine:${config.project}:${name}`;
  const save = (name: string, value: unknown) => void store?.set(storeKey(name), JSON.stringify(value)).catch(() => {});
  async function read<T>(name: string): Promise<T | null> {
    try {
      const raw = store && (await store.get(storeKey(name)));
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  }
  /** The manifest from the last launch, when none is in memory. Marked old, so the next call asks the edge. */
  async function restoreManifest(): Promise<boolean> {
    if (current || !store) return !!current;
    const saved = await read<{ manifest: Manifest; etag: string | null }>("manifest");
    if (saved && Array.isArray(saved.manifest?.languages)) current ??= { manifest: saved.manifest, etag: saved.etag, at: -Infinity };
    return !!current;
  }
  const restored = new Set<string>();
  /** The last manifest call did not reach the edge: what we have is not confirmed live. */
  let failedManifest = false;

  async function fetchManifest(): Promise<Manifest> {
    try {
      const res = await get(`${base}/manifest.json`, current?.etag ? { "If-None-Match": current.etag } : {});
      failedManifest = !res.ok && res.status !== 304;
      if (res.status === 304 && current) {
        current = { ...current, at: clock() };
        return current.manifest;
      }
      if (!res.ok) throw new Error(`lefine: manifest ${res.status}`);
      const manifest = (await res.json()) as Manifest;
      if (!Array.isArray(manifest?.languages)) throw new Error("lefine: the manifest has no languages");
      const older = typeof current?.manifest.revision === "number" && typeof manifest.revision === "number" && manifest.revision < current.manifest.revision;
      if (older && current) {
        current = { ...current, at: clock() };
        return current.manifest;
      }
      current = { manifest, etag: res.headers.get("etag"), at: clock() };
      save("manifest", { manifest, etag: current.etag });
      return manifest;
    } catch (err) {
      // The edge is down or answered badly: the manifest we have (in memory, else from the device) is the best answer.
      failedManifest = true;
      if (await restoreManifest()) {
        // Asked again after the TTL, not on every call while the edge (or the network) is away.
        current = { ...current!, at: clock() };
        return current.manifest;
      }
      throw err;
    }
  }

  function manifest(): Promise<Manifest> {
    if (current && clock() - current.at < ttl) return Promise.resolve(current.manifest);
    if (!share) return fetchManifest();
    pending ??= fetchManifest().finally(() => {
      pending = null;
    });
    if (swr && current) {
      // Stale while revalidating: this render gets what is in memory; the one request in flight refreshes it.
      pending.catch(() => {});
      return Promise.resolve(current.manifest);
    }
    return pending;
  }

  async function readIr(url: string, sha256: string): Promise<MessageTree | null> {
    try {
      const res = await get(url);
      if (!res.ok) return null;
      const file = (await res.json()) as Partial<IrFile>;
      return file?.format === IR_FORMAT && file.sha256 === sha256 && isTree(file.messages) ? file.messages : null;
    } catch {
      return null;
    }
  }

  async function fetchLocale(locale: string, entry: Required<ManifestFile>): Promise<LoadedLocale> {
    const url = `${base}/v/${entry.version}/${locale}/translations.json`;
    // The compiled file is asked for at the same time: a cold start waits one round trip for both, not two
    // (bench/: 3 sequential requests became 2). Its result counts only if the texts verify.
    const stamp = `${entry.version}:${entry.sha256}`;
    const ir =
      entry.ir === true && !irMissing.has(stamp)
        ? readIr(url.replace(/translations\.json$/, "messages.ir.json"), entry.sha256).then((tree) => {
            // A miss is kept: this version's compiled file is not asked for again (the texts are compiled here).
            if (tree === null) irMissing.add(stamp);
            return tree;
          })
        : Promise.resolve(null);
    const res = await get(url);
    if (!res.ok) throw new Error(`lefine: ${locale} answered ${res.status}`);
    const bytes = await res.arrayBuffer();
    let texts: unknown;
    try {
      texts = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      throw new IntegrityError(`${locale} is not JSON`);
    }
    if (!isTree(texts) || Object.keys(texts).length === 0) throw new IntegrityError(`${locale} is empty`);
    if (countKeys(texts) !== entry.keyCount) throw new IntegrityError(`${locale} has ${countKeys(texts)} texts, the manifest says ${entry.keyCount}`);
    // Synchronous on purpose (sha256.ts): with Cache Components an await on crypto.subtle stops `next build`.
    if (sha256Hex(new Uint8Array(bytes)) !== entry.sha256) throw new IntegrityError(`${locale} does not match the manifest's sha256`);
    return { locale, texts, ir: await ir, stamp, stale: false };
  }

  /**
   * A cold start with a device copy: the file from the last launch, checked against the saved manifest, served at
   * once (offline or not). The edge is asked in the background; the next load gets what it found.
   */
  async function fromDevice(locale: string): Promise<LoadedLocale | null> {
    restored.add(locale);
    if (!(await restoreManifest())) return null;
    const entry = current!.manifest.files?.[locale];
    const saved = await read<{ stamp: string; texts: Record<string, unknown>; ir?: MessageTree | null }>(locale);
    if (!entry || !saved || saved.stamp !== `${entry.version}:${entry.sha256}` || !isTree(saved.texts) || countKeys(saved.texts) !== entry.keyCount) return null;
    // The compiled form saved with it (a snapshot, or a device copy) saves compiling again; a broken one is ignored.
    const copy: LoadedLocale = { locale, texts: saved.texts, ir: isTree(saved.ir) ? (saved.ir as MessageTree) : null, stamp: saved.stamp, stale: true };
    verified.set(locale, copy);
    void load(locale).catch(() => {});
    return copy;
  }

  async function load(requested: string): Promise<LoadedLocale> {
    const locale = cdnLocale(requested);
    if (!LOCALE.test(locale)) throw new Error(`lefine: "${requested}" is not a locale`);
    if (store && !restored.has(locale) && !verified.has(locale)) {
      const copy = await fromDevice(locale);
      if (copy) return copy;
    }
    const entry = (await manifest()).files?.[locale];
    if (!entry?.version || !VERSION.test(entry.version) || !entry.sha256 || typeof entry.keyCount !== "number") {
      throw new Error(`lefine: ${locale} is not published for ${config.project}. Publish it in Lefine, or check the locale.`);
    }
    const stamp = `${entry.version}:${entry.sha256}`;
    const last = verified.get(locale);
    // Same bytes as the copy we verified: nothing to fetch. A device copy the live manifest confirms is fresh again.
    if (last?.stamp === stamp) {
      if (!last.stale || failedManifest) return last;
      const confirmed = { ...last, stale: false };
      verified.set(locale, confirmed);
      return confirmed;
    }
    if (last && clock() - (failedAt.get(stamp + locale) ?? -Infinity) < RETRY_MS) return { ...last, stale: true };
    const job = download(locale, entry as Required<ManifestFile>, stamp, last);
    if (swr && last) {
      // A new release: this render keeps the copy it has; the download in flight serves the next one.
      job.catch(() => {});
      return { ...last, stale: true };
    }
    return job;
  }

  function download(locale: string, entry: Required<ManifestFile>, stamp: string, last: LoadedLocale | undefined): Promise<LoadedLocale> {
    let job = share ? inFlight.get(stamp + locale) : undefined;
    if (!job) {
      job = fetchLocale(locale, entry)
        .then((fresh) => {
          verified.set(locale, fresh);
          save(locale, { stamp: fresh.stamp, texts: fresh.texts, ir: fresh.ir });
          return fresh;
        })
        // A download that fails or does not match keeps the last verified copy (the edge keeps old versions).
        .catch((err) => {
          failedAt.set(stamp + locale, clock());
          if (last) return { ...last, stale: true };
          throw err;
        })
        .finally(() => inFlight.delete(stamp + locale));
      if (share) inFlight.set(stamp + locale, job);
    }
    return job;
  }

  return {
    manifest,
    async locales() {
      return (await manifest()).languages.map((l) => cdnLocale(l.code));
    },
    load,
  };
}
