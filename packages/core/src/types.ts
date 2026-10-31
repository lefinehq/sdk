/**
 * Supported locale string (e.g., "en", "en-US", "tr")
 */
export type Locale = string;

/**
 * Log level for debugging
 */
export type LogLevel = "debug" | "info" | "warn" | "error" | "silent";

/**
 * Pluggable storage interface for persistent translation caching.
 * Compatible with browser localStorage, AsyncStorage, MMKV, or any key-value store.
 */
export interface TranslationStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove?(key: string): Promise<void>;
}

/**
 * Core i18n configuration
 */
export interface I18nCoreConfig {
  /**
   * Project ID in `org/project` slug format (e.g., "acme/dashboard").
   *
   * Find it in the dashboard under **Settings → General → Project ID**, or
   * read it off the dashboard URL: `dash.better-i18n.com/{org}/{project}`.
   *
   * Canonical field. Use `projectId` in new code.
   *
   * Either `projectId` or `project` (legacy alias) must be set.
   */
  projectId?: string;

  /**
   * Legacy alias for `projectId`. Kept for backward compatibility with
   * integrations that shipped before 0.x.
   *
   * @deprecated Use `projectId` instead.
   */
  project?: string;

  /**
   * Default locale to use when no locale is specified
   */
  defaultLocale: string;

  /**
   * CDN base URL
   * @default "https://cdn.better-i18n.com"
   */
  cdnBaseUrl?: string;

  /**
   * Cache TTL in milliseconds for manifest
   * @default 300000 (5 minutes)
   */
  manifestCacheTtlMs?: number;

  /**
   * Enable debug logging
   * @default false
   */
  debug?: boolean;

  /**
   * Log level
   * @default "warn"
   */
  logLevel?: LogLevel;

  /**
   * Custom fetch function (useful for testing or custom environments)
   */
  fetch?: typeof fetch;

  /**
   * Persistent storage adapter for offline fallback.
   * When CDN is unavailable, translations are served from storage.
   */
  storage?: TranslationStorage;

  /**
   * Bundled/static translations as last-resort fallback.
   * Used when both CDN and storage are unavailable.
   * Can be a static object or a lazy-loading function.
   *
   * @example
   * ```ts
   * // Static import
   * staticData: { en: { common: { hello: "Hello" } } }
   *
   * // Lazy import
   * staticData: () => import('./fallback-translations.json')
   * ```
   */
  staticData?: Record<string, Messages> | (() => Promise<Record<string, Messages>>);

  /**
   * Default namespaces to fetch when the project uses namespaced CDN delivery.
   * When set, `getMessages(locale)` only fetches these namespaces instead of all.
   * Can be overridden per-call: `getMessages(locale, { namespaces: [...] })`.
   *
   * Only effective for projects with `fileStructure: "namespaced_folders"`.
   * Ignored for `single_file` projects (no namespace concept in CDN).
   *
   * @example
   * ```ts
   * namespaces: ["common", "auth", "dashboard"]
   * ```
   */
  namespaces?: string[];

  /**
   * CDN fetch timeout in milliseconds.
   * If a fetch does not complete within this time, the request is aborted
   * and fallback sources are tried.
   * @default 10000
   */
  fetchTimeout?: number;

  /**
   * Number of retry attempts on CDN fetch failure.
   * @default 1
   */
  retryCount?: number;

  /**
   * Schema-2 manifests only. Wait before the single retry when a snapshot URL
   * answers 404 right after the manifest moved (the manifest got ahead of the
   * files). After the retry the last verified copy is kept.
   * @default 1000
   */
  snapshotRetryDelayMs?: number;
}

/**
 * Parsed project identifier.
 *
 * Two input shapes are accepted:
 *
 *   1. `"org/project"` slug — `workspaceId` and `projectSlug` carry the split
 *      parts, `pathSegment` is `"org/project"`, `isUuid` is false.
 *   2. Project UUID (canonical 36-char form) — `workspaceId` and `projectSlug`
 *      are empty strings (no meaningful split), `pathSegment` is the
 *      lowercase UUID, `isUuid` is true.
 *
 * URL construction MUST use `pathSegment` so both shapes route correctly to
 * the CDN. Code paths that read `workspaceId` / `projectSlug` directly will
 * only work in slug mode — guard with `isUuid` if both modes need to be
 * supported.
 */
export interface ParsedProject {
  workspaceId: string;
  projectSlug: string;
  /**
   * CDN path segment — `"org/project"` for slug input, the UUID for UUID
   * input. Always populated post-normalization.
   */
  pathSegment: string;
  /** True when the project identifier was a canonical UUID, not a slug. */
  isUuid: boolean;
}

/**
 * Normalized configuration with all defaults applied
 */
export interface NormalizedConfig extends I18nCoreConfig, ParsedProject {
  /** Resolved project slug (always set post-normalization, from `projectId` or legacy `project` input) */
  project: string;
  cdnBaseUrl: string;
  manifestCacheTtlMs: number;
  /** Separate TTL for translation messages cache (dev=0, prod=5min by default) */
  messagesCacheTtlMs: number;
  fetchTimeout: number;
  retryCount: number;
}

/**
 * Language information from manifest
 */
export interface ManifestLanguage {
  code: string;
  name?: string;
  nativeName?: string;
  flagUrl?: string | null;
  /** ISO 3166-1 alpha-2 country code (e.g. "tr", "jp", "cn") */
  countryCode?: string | null;
  isSource?: boolean;
  lastUpdated?: string | null;
  keyCount?: number;
}

/**
 * File information in manifest
 */
export interface ManifestFile {
  url: string;
  size: number;
  lastModified: string | null;
  /**
   * Immutable snapshot version for this language (platform #115). When
   * present, the SDK fetches `{base}/v/{version}/{locale}/{ns}.json`, served
   * with a one-year `immutable` Cache-Control. Absent → legacy
   * `{base}/{locale}/{ns}.json`, exactly as before the field existed.
   */
  version?: string;
  /** Hex SHA-256 of the exact bytes at the snapshot URL (schema 2). */
  sha256?: string;
  /** Number of texts in the file (schema 2). A different count means the locale was not delivered. */
  keyCount?: number;
  /** App revision at which this file's bytes last changed (schema 2). */
  revision?: number;
  /** When this file's content went live (schema 2). */
  publishedAt?: string;
  /** Texts that differ from the previous release; all zero for a carried-over file (schema 2). */
  changes?: { added: number; changed: number; removed: number };
}

/**
 * Per-language file entry in manifest v2.
 * When `namespaces` is present, the project uses namespaced_folders delivery.
 * Old SDKs fall back to `url` (combined translations.json for backward compat).
 * New SDKs check `namespaces` first and fetch per-namespace files in parallel.
 */
export interface ManifestFileEntry extends ManifestFile {
  namespaces?: Record<string, ManifestFile>;
}

/**
 * CDN manifest response
 */
export interface ManifestResponse {
  projectSlug?: string;
  sourceLanguage?: string;
  languages: ManifestLanguage[];
  files?: Record<string, ManifestFileEntry>;
  updatedAt?: string;
  /**
   * When true, CDN supports batch namespace fetching in a single HTTP request:
   * `GET /{locale}/batch.json?ns=common,nav,hero`
   * → `{ "common": {...}, "nav": {...}, "hero": {...} }`
   *
   * SDK falls back to parallel individual fetches when this is false/absent.
   */
  batch?: boolean;
  /**
   * Top-level namespace list for slim manifests.
   * When present, per-locale `files[locale].namespaces` objects can be omitted —
   * SDK constructs URLs deterministically: `{baseUrl}/{locale}/{ns}.json`.
   *
   * This reduces manifest size from ~477KB to ~10-15KB for projects with
   * 100+ namespaces × 20+ locales (removes ~240KB of redundant URL/size/date entries).
   */
  namespaces?: string[];
  /** `2` on every Lefine manifest. Absent on a Better i18n manifest, which keeps the `lastModified` behaviour. */
  schema?: number;
  /** Integer, +1 per publish, never reused. Higher is newer; the SDK ignores a lower one. */
  revision?: number;
  /** The release's version string. */
  version?: string;
  /** When the release went live. */
  publishedAt?: string;
  /** Absolute URL of `v/{version}/changes.json` (what changed since `previousVersion`). */
  changesUrl?: string;
  /** The release this one was compared with; null for the first. */
  previousVersion?: string | null;
}

/**
 * Simplified language option for UI components
 */
export interface LanguageOption {
  code: string;
  name?: string;
  nativeName?: string;
  flagUrl?: string | null;
  /** ISO 3166-1 alpha-2 country code (e.g. "tr", "jp", "cn") */
  countryCode?: string | null;
  /**
   * Whether this is the default/source language
   */
  isDefault?: boolean;
}

/**
 * Translation messages keyed by namespace.
 * Matches the CDN response format: `{ "common": { "key": "value" }, "auth": { ... } }`
 */
export type Messages = Record<string, Record<string, unknown>>;

/**
 * Logger interface
 */
export interface Logger {
  debug: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

/**
 * Cache entry with expiration
 */
export interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

/**
 * i18n core instance returned by createI18nCore
 */
export interface MessagesUpdateEvent {
  /** Normalized locale the fresh messages belong to (e.g. `"tr"`). */
  locale: string;
  /** Fresh messages payload — safe to swap into the provider's state. */
  messages: Messages;
  /**
   * Which project the event belongs to (`{cdnBaseUrl}|{project}`). The bus is
   * shared by every instance in the process; a listener only receives events
   * for the project of the core it subscribed on.
   */
  project?: string;
}

export type MessagesUpdateListener = (event: MessagesUpdateEvent) => void;

/**
 * Richer update event for schema-2 manifests: a verified copy replaced the
 * cached one. `revision`/`version` are absent for a Better i18n manifest.
 */
export interface CacheUpdateEvent extends MessagesUpdateEvent {
  /** Always set on schema-2 update events. */
  project: string;
  /** Manifest revision the new copy belongs to. */
  revision?: number;
  /** Revision of the copy it replaced, when known. */
  previousRevision?: number;
  /** Snapshot version of the new copy. */
  version?: string;
  /** Where to read what changed in this release (`changes.json`), when advertised. */
  changesUrl?: string;
  /** The release it was compared with; null for the first. */
  previousReleaseVersion?: string | null;
}

/** `v/{version}/changes.json`: what one release changed against the one before it. */
export interface ChangesFile {
  revision: number;
  version: string;
  previousVersion: string | null;
  publishedAt: string;
  locales: Record<
    string,
    {
      added: number;
      changed: number;
      removed: number;
      /** `[namespace, key]` pairs, at most 1000 per locale, edits first. */
      keys: {
        added: Array<[string, string]>;
        changed: Array<[string, string]>;
        removed: Array<[string, string]>;
      };
      /** `true` when `keys` was cut at the limit; the counts are still exact. */
      truncated: boolean;
    }
  >;
}

/**
 * Answer of `changesSince(revision)`.
 *
 * `changes.json` compares a release with the one before it only, so the list
 * is `complete` when the caller is at most one revision behind. Further back
 * the SDK cannot know what changed: `complete` is `false`, and `latest` (when
 * still available) is only the last release's part of the answer.
 */
export interface ChangesSinceResult {
  complete: boolean;
  fromRevision: number;
  /** Revision of the manifest the answer was built from; `null` when it has none (schema 1). */
  toRevision: number | null;
  /** The last release's change list, or `null` (nothing to report, schema 1, pruned, unreachable). */
  latest: ChangesFile | null;
}

export type CacheUpdateListener = (event: CacheUpdateEvent) => void;

/** Observable state of the cache for one project. */
export interface CacheStatus {
  /** `true` when the last check failed and the last verified copy is being served. */
  stale: boolean;
  /** Epoch ms of the last successful manifest check (a 304 counts). */
  lastCheckedAt: number | null;
  /** Revision of the manifest in use, when it is a schema-2 manifest. */
  revision: number | null;
  /** Downloads discarded because they did not match `sha256` / `keyCount`. */
  integrityFailures: number;
  /** Message of the last failure, cleared on the next success. */
  lastError: string | null;
  /**
   * Message of the last failed write to the persistent `storage` (full disk,
   * unavailable). The load that triggered it still succeeded; the copy is
   * just not persisted. Cleared on the next successful `markFresh`.
   */
  storageError: string | null;
}

export interface I18nCore {
  /**
   * Resolved configuration
   */
  config: NormalizedConfig;

  /**
   * Fetch manifest from CDN
   */
  getManifest: (options?: { forceRefresh?: boolean }) => Promise<ManifestResponse>;

  /**
   * Get messages for a specific locale.
   * When `namespaces` is provided and the project uses namespaced CDN delivery,
   * only the specified namespaces are fetched (instead of all).
   *
   * Stale-while-revalidate: when a memory cache hit happens, the cached copy is
   * returned immediately AND a background revalidation is kicked off against the
   * CDN. If the revalidation returns different content, subscribers registered
   * via {@link onMessagesUpdate} are notified with the fresh payload.
   */
  getMessages: (locale: string, options?: { namespaces?: string[] }) => Promise<Messages>;

  /**
   * Get available locale codes
   */
  getLocales: () => Promise<string[]>;

  /**
   * Get language options with metadata (for UI components)
   */
  getLanguages: () => Promise<LanguageOption[]>;

  /**
   * Subscribe to background revalidation updates.
   *
   * When a call to {@link revalidate} detects that the CDN manifest version
   * has changed for the given locale, fresh messages are fetched and the
   * listener is invoked with the new payload. React providers use this to
   * re-render stale UI without a full reload.
   *
   * @returns Unsubscribe function.
   */
  onMessagesUpdate: (listener: MessagesUpdateListener) => () => void;

  /**
   * Force a freshness check against the CDN for the given locale.
   *
   * Flow:
   * 1. Fetch the manifest with `forceRefresh` (ETag-aware — cheap, ~5KB, usually 304).
   * 2. Compare `files[locale].lastModified` (or `manifest.updatedAt` fallback)
   *    with the version that was active at the last fetch.
   * 3. If the version is unchanged, the call exits early (no message fetch).
   * 4. If the version changed, fetch new messages and notify subscribers
   *    registered via {@link onMessagesUpdate}.
   *
   * Call this on `visibilitychange` / `focus` / a polling interval to keep
   * long-lived tabs fresh without a full reload. Safe to call frequently —
   * in-flight calls are de-duplicated per locale.
   *
   * Infrastructure-agnostic: only uses standard HTTP semantics (ETag,
   * Cache-Control). No CF/Worker/Vercel coupling.
   *
   * When the caller only renders a subset of namespaces (selective loading),
   * pass them via `options.namespaces` so the refetch after a version change
   * stays as narrow as the original load. Defaults to the `namespaces` given
   * to {@link createI18nCore}, i.e. every namespace when that is unset.
   */
  revalidate: (
    locale: string,
    options?: { namespaces?: string[] },
  ) => Promise<void>;

  /**
   * Subscribe to verified cache swaps. Like {@link onMessagesUpdate}, but the
   * event also carries the manifest `revision`, the snapshot `version` and the
   * `changes` pointer. Fires only after the new copy passed `sha256` /
   * `keyCount` verification and replaced the cached one.
   *
   * @returns Unsubscribe function.
   */
  onUpdate: (listener: CacheUpdateListener) => () => void;

  /**
   * What changed since the caller's `revision` (see {@link ChangesSinceResult}).
   * Reads `changes.json` of the current release when the manifest names one.
   * Never throws: a missing, pruned or unreachable file is `complete: false`.
   */
  changesSince: (revision: number) => Promise<ChangesSinceResult>;

  /**
   * Cache state: `stale` is `true` while the last verified copy is served
   * because the CDN, the manifest or an integrity check failed.
   */
  getStatus: () => CacheStatus;
}
