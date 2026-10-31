import type { Messages } from "@better-i18n/core";
import type { AsyncStorageLike, CacheCopyInfo, CacheMeta, LocaleAwareTranslationStorage, MMKVLike, StorageAdapterOptions, TranslationStorage } from "./types.js";

const CACHE_PREFIX = "@better-i18n";

/**
 * Build the storage key for cached translations
 */
export const buildStorageKey = (project: string, locale: string): string =>
  `${CACHE_PREFIX}:${project}:${locale}:translations`;

/**
 * Build the storage key for cache metadata
 */
export const buildMetaKey = (project: string, locale: string): string =>
  `${CACHE_PREFIX}:${project}:${locale}:meta`;

/**
 * Build the storage key for one snapshot version of a locale (schema-2
 * manifests). The newest two versions are kept, so a copy that fails to parse
 * can fall back to the one before it.
 */
export const buildVersionedStorageKey = (
  project: string,
  locale: string,
  version: string
): string => `${CACHE_PREFIX}:${project}:${locale}:v:${version}:translations`;

/**
 * Create an in-memory storage adapter.
 * Used as fallback when no persistent storage is available.
 */
export const createMemoryStorage = (): TranslationStorage => {
  const store = new Map<string, string>();
  return {
    getItem: async (key) => store.get(key) ?? null,
    setItem: async (key, value) => {
      store.set(key, value);
    },
    removeItem: async (key) => {
      store.delete(key);
    },
  };
};

/**
 * Resolve storage: return user-provided storage or fall back to in-memory.
 *
 * The library never imports react-native-mmkv or AsyncStorage directly —
 * use storageAdapter() to pass your own instance.
 */
export const resolveStorage = async (
  userStorage?: TranslationStorage,
  debug?: boolean
): Promise<TranslationStorage> => {
  if (userStorage) return userStorage;
  if (debug) {
    console.warn(
      "[better-i18n/expo] No persistent storage provided. Translations won't survive app restarts. " +
      "Pass a storage adapter (e.g., storageAdapter(new MMKV())) for offline support."
    );
  }
  return createMemoryStorage();
};

/**
 * Adapt an external storage instance to TranslationStorage.
 *
 * Detects the storage type by duck-typing:
 * - MMKV  : has `getString`, `set`, `delete` (sync → wrapped async)
 * - AsyncStorage: has `getItem`, `setItem`, `removeItem` (already async)
 *
 * The library never imports react-native-mmkv or AsyncStorage directly.
 *
 * @example
 * import { MMKV } from 'react-native-mmkv';
 * storage: storageAdapter(new MMKV({ id: 'app' }))
 *
 * @example
 * import AsyncStorage from '@react-native-async-storage/async-storage';
 * storage: storageAdapter(AsyncStorage)
 *
 * @example
 * // With locale persistence — readLocale() / writeLocale() added to returned adapter
 * storage: storageAdapter(AsyncStorage, { localeKey: '@app:locale' })
 */
export const storageAdapter = (
  storage: MMKVLike | AsyncStorageLike,
  options?: StorageAdapterOptions
): TranslationStorage | LocaleAwareTranslationStorage => {
  let base: TranslationStorage;

  // MMKV: sync API — getString / set / delete
  if ("getString" in storage && "set" in storage && "delete" in storage) {
    const mmkv = storage as MMKVLike;
    base = {
      getItem: async (key) => mmkv.getString(key) ?? null,
      setItem: async (key, value) => { mmkv.set(key, value); },
      removeItem: async (key) => { mmkv.delete(key); },
    };
  }
  // AsyncStorage: async API — getItem / setItem / removeItem
  else if ("getItem" in storage && "setItem" in storage && "removeItem" in storage) {
    const as = storage as AsyncStorageLike;
    base = {
      getItem: (key) => as.getItem(key),
      setItem: (key, value) => as.setItem(key, value),
      removeItem: (key) => as.removeItem(key),
    };
  }
  else {
    throw new Error(
      "[better-i18n] storageAdapter: unrecognized storage type. " +
      "Expected MMKV (getString/set/delete) or AsyncStorage (getItem/setItem/removeItem)."
    );
  }

  if (!options?.localeKey) return base;

  const key = options.localeKey;
  return {
    ...base,
    readLocale: () => base.getItem(key),
    writeLocale: (lng: string) => base.setItem(key, lng),
  };
};

const parseMessages = (raw: string | null): Messages | null => {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw);
    return data !== null && typeof data === "object" ? (data as Messages) : null;
  } catch {
    return null;
  }
};

/**
 * Read cached translations from storage.
 * Meta is optional — if only translations exist, they are still returned.
 *
 * The un-versioned key is the primary copy. When it is missing or corrupt and
 * meta names a version, the versioned copies (current, then previous) are tried.
 */
export const readCache = async (
  storage: TranslationStorage,
  project: string,
  locale: string
): Promise<{ data: Messages; meta: CacheMeta } | null> => {
  try {
    // Meta is best-effort — default to epoch if missing/corrupt
    let meta: CacheMeta = { cachedAt: 0 };
    try {
      const rawMeta = await storage.getItem(buildMetaKey(project, locale));
      if (rawMeta) meta = JSON.parse(rawMeta) as CacheMeta;
    } catch {
      // meta is non-critical
    }

    let data = parseMessages(await storage.getItem(buildStorageKey(project, locale)));
    if (!data) {
      for (const version of [meta.version, meta.previousVersion]) {
        if (!version) continue;
        data = parseMessages(
          await storage.getItem(buildVersionedStorageKey(project, locale, version))
        );
        if (data) break;
      }
    }
    return data ? { data, meta } : null;
  } catch {
    return null;
  }
};

/**
 * Write translations to persistent storage with metadata.
 *
 * With `info.version` (schema-2 manifest) the copy is also written under a
 * version-keyed entry and the entry two versions back is removed, so the
 * newest two are kept. Errors propagate: the caller decides how to report them.
 */
export const writeCache = async (
  storage: TranslationStorage,
  project: string,
  locale: string,
  data: Messages,
  info?: CacheCopyInfo
): Promise<void> => {
  const meta: CacheMeta = { cachedAt: Date.now() };
  const json = JSON.stringify(data);
  const writes: Promise<void>[] = [];
  let prune: string | undefined;

  if (info?.version) {
    meta.version = info.version;
    if (info.revision !== undefined) meta.revision = info.revision;
    const existing = await readMeta(storage, project, locale);
    if (existing?.version && existing.version !== info.version) {
      // New version: the old current becomes the one kept for rollback, and
      // the one it had replaced is dropped (newest two stay).
      meta.previousVersion = existing.version;
      if (existing.previousVersion && existing.previousVersion !== info.version) {
        prune = existing.previousVersion;
      }
    } else if (existing?.previousVersion) {
      meta.previousVersion = existing.previousVersion;
    }
    writes.push(
      storage.setItem(buildVersionedStorageKey(project, locale, info.version), json)
    );
  }

  writes.push(
    storage.setItem(buildStorageKey(project, locale), json),
    storage.setItem(buildMetaKey(project, locale), JSON.stringify(meta))
  );
  await Promise.all(writes);
  if (prune) {
    await storage.removeItem(buildVersionedStorageKey(project, locale, prune));
  }
};

const readMeta = async (
  storage: TranslationStorage,
  project: string,
  locale: string
): Promise<CacheMeta | null> => {
  try {
    const raw = await storage.getItem(buildMetaKey(project, locale));
    return raw ? (JSON.parse(raw) as CacheMeta) : null;
  } catch {
    return null;
  }
};
