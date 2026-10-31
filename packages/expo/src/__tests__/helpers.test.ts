import { describe, expect, it, mock, beforeEach } from "bun:test";
import type { i18n as I18nType } from "i18next";
import { initBetterI18n, getLanguages, subscribeLanguages, getLanguagesSnapshot } from "../helpers";
import { buildMetaKey, buildStorageKey, buildVersionedStorageKey, createMemoryStorage, readCache, storageAdapter } from "../storage";

// ---------------------------------------------------------------------------
// Mutable CDN fixtures — reassign in beforeEach or individual tests
// ---------------------------------------------------------------------------

let mockMessages: Record<string, Record<string, string>> = {
  auth: { login: "Sign In", logout: "Sign Out" },
  common: { welcome: "Welcome", goodbye: "Goodbye" },
};

/** Per-locale messages override. When set, getMessages returns locale-specific data. */
let mockMessagesByLocale: Record<string, Record<string, Record<string, string>> | null> = {};

let mockLanguages: { code: string }[] = [{ code: "en" }, { code: "tr" }];

// Schema-2 surface of core: manifest, stale flag, update bus, revalidate.
// `undefined` manifest = getManifest throws (what the tests above always saw).
let mockManifest: any = undefined;
let mockStale = false;
const mockUpdateListeners = new Set<(event: any) => void>();
let mockRevalidated: string[] = [];

// ---------------------------------------------------------------------------
// Mock @better-i18n/core — prevents real CDN calls.
// Bun hoists mock.module() to before any import resolution.
// ---------------------------------------------------------------------------

mock.module("@better-i18n/core", () => ({
  createI18nCore: (_config: unknown) => ({
    getMessages: async (locale: string) => {
      // If per-locale override exists, use it (null = throw like CDN 404)
      if (locale in mockMessagesByLocale) {
        const data = mockMessagesByLocale[locale];
        if (data === null) throw new Error(`CDN: locale "${locale}" not found`);
        return data;
      }
      return mockMessages;
    },
    getLanguages: async () => mockLanguages,
    getManifest: async () => {
      if (mockManifest === undefined) throw new Error("no manifest");
      return mockManifest;
    },
    getStatus: () => ({ stale: mockStale, storageError: null }),
    onUpdate: (listener: (event: any) => void) => {
      mockUpdateListeners.add(listener);
      return () => mockUpdateListeners.delete(listener);
    },
    revalidate: async (locale: string) => {
      mockRevalidated.push(locale);
    },
  }),
  normalizeLocale: (l: string) => l.toLowerCase(),
}));


// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a lightweight i18next instance mock with a simulated resource store.
 * Tracks all addResourceBundle calls and registered languageChanged listeners.
 */
function createMockI18n() {
  const bundles = new Map<string, unknown>();
  const listeners: Record<string, Array<(arg: string) => void>> = {};

  const initMock = mock(async (_opts: unknown) => {});

  const addResourceBundleMock = mock(
    (locale: string, ns: string, data: unknown) => {
      bundles.set(`${locale}:${ns}`, data);
    }
  );

  const hasResourceBundleMock = mock((locale: string, ns: string) =>
    bundles.has(`${locale}:${ns}`)
  );

  const changeLanguageMock = mock(async (_lng?: string) => {});

  const onMock = mock((event: string, listener: (arg: string) => void) => {
    if (!listeners[event]) listeners[event] = [];
    listeners[event]!.push(listener);
  });

  const i18n = {
    init: initMock,
    addResourceBundle: addResourceBundleMock,
    hasResourceBundle: hasResourceBundleMock,
    changeLanguage: changeLanguageMock,
    on: onMock,
  } as unknown as I18nType;

  return {
    i18n,
    bundles,
    listeners,
    mocks: {
      init: initMock,
      addResourceBundle: addResourceBundleMock,
      hasResourceBundle: hasResourceBundleMock,
      changeLanguage: changeLanguageMock,
      on: onMock,
    },
  };
}

const PROJECT = "acme/test-app";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("initBetterI18n", () => {
  beforeEach(() => {
    mockMessages = {
      auth: { login: "Sign In", logout: "Sign Out" },
      common: { welcome: "Welcome", goodbye: "Goodbye" },
    };
    mockMessagesByLocale = {};
    mockLanguages = [{ code: "en" }, { code: "tr" }];
  });

  it("calls i18next.init with defaultNS: 'translation' and fallbackNS: 'translation'", async () => {
    const { i18n, mocks } = createMockI18n();

    await initBetterI18n({
      project: PROJECT,
      i18n,
      storage: createMemoryStorage(),
      defaultLocale: "en",
    });

    expect(mocks.init).toHaveBeenCalledTimes(1);
    const initOpts = mocks.init.mock.calls[0]![0] as Record<string, unknown>;
    expect(initOpts["defaultNS"]).toBe("translation");
    expect(initOpts["fallbackNS"]).toBe("translation");
  });

  it("resources[lng] contains merged 'translation' bundle and individual namespaces", async () => {
    const { i18n, mocks } = createMockI18n();

    await initBetterI18n({
      project: PROJECT,
      i18n,
      storage: createMemoryStorage(),
      defaultLocale: "en",
    });

    const initOpts = mocks.init.mock.calls[0]![0] as Record<string, unknown>;
    const resources = initOpts["resources"] as Record<
      string,
      Record<string, unknown>
    >;

    // Merged into "translation" NS — enables t('auth.login')
    expect(resources["en"]!["translation"]).toEqual(mockMessages);

    // Individual namespaces — enables t('auth:login') and useTranslation('auth')
    expect(resources["en"]!["auth"]).toEqual(mockMessages.auth);
    expect(resources["en"]!["common"]).toEqual(mockMessages.common);
  });

  it("returns { core, languages } from CDN manifest", async () => {
    const { i18n } = createMockI18n();

    const result = await initBetterI18n({
      project: PROJECT,
      i18n,
      storage: createMemoryStorage(),
      defaultLocale: "en",
    });

    expect(result.core).toBeDefined();
    expect(result.languages).toEqual(mockLanguages);
  });

  // -------------------------------------------------------------------------
  // changeLanguage override
  // -------------------------------------------------------------------------

  describe("changeLanguage override", () => {
    it("calls addResourceBundle when 'translation' NS is missing for new locale", async () => {
      const { i18n, mocks } = createMockI18n();

      await initBetterI18n({
        project: PROJECT,
        i18n,
        storage: createMemoryStorage(),
        defaultLocale: "en",
      });

      mocks.addResourceBundle.mockClear();

      // "tr" has no pre-loaded translations
      await i18n.changeLanguage("tr");

      const calls = mocks.addResourceBundle.mock.calls as Array<
        [string, string, unknown]
      >;
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every(([locale]) => locale === "tr")).toBe(true);
      expect(calls.some(([, ns]) => ns === "translation")).toBe(true);
    });

    it("skips addResourceBundle when 'translation' NS already exists", async () => {
      const { i18n, mocks, bundles } = createMockI18n();

      await initBetterI18n({
        project: PROJECT,
        i18n,
        storage: createMemoryStorage(),
        defaultLocale: "en",
      });

      // Simulate "tr" already loaded
      bundles.set("tr:translation", mockMessages);
      mocks.addResourceBundle.mockClear();

      await i18n.changeLanguage("tr");

      const calls = mocks.addResourceBundle.mock.calls as Array<
        [string, string, unknown]
      >;
      const trCalls = calls.filter(([locale]) => locale === "tr");
      expect(trCalls).toHaveLength(0);
    });

    it("pre-load registers both individual namespace bundles and merged 'translation' bundle", async () => {
      const { i18n, mocks } = createMockI18n();

      await initBetterI18n({
        project: PROJECT,
        i18n,
        storage: createMemoryStorage(),
        defaultLocale: "en",
      });

      mocks.addResourceBundle.mockClear();
      await i18n.changeLanguage("tr");

      const calls = mocks.addResourceBundle.mock.calls as Array<
        [string, string, unknown]
      >;
      const namespaces = calls.map(([, ns]) => ns);

      // addAllNamespaces: one call per CDN namespace
      expect(namespaces).toContain("auth");
      expect(namespaces).toContain("common");

      // addTranslationBundle: merged "translation" NS (dot-notation support)
      expect(namespaces).toContain("translation");
    });
  });

  // -------------------------------------------------------------------------
  // Persistent cache sync (widget extension support)
  // -------------------------------------------------------------------------

  describe("persistent cache sync on changeLanguage", () => {
    it("writes persistent cache even when resource bundle is already loaded", async () => {
      const { i18n, bundles } = createMockI18n();
      const storage = createMemoryStorage();
      const setItemSpy = mock(storage.setItem.bind(storage));
      storage.setItem = setItemSpy;

      await initBetterI18n({
        project: PROJECT,
        i18n,
        storage,
        defaultLocale: "en",
      });

      // Simulate "tr" already loaded in i18next memory (init with Turkish data)
      const trData = {
        auth: { login: "Giriş Yap", logout: "Çıkış Yap" },
        common: { welcome: "Hoşgeldiniz" },
      };
      bundles.set("tr:translation", trData);

      // Attach i18next store.data so the else branch can reconstruct messages
      (i18n as any).store = {
        data: {
          tr: {
            translation: trData, // merged NS — excluded by the filter
            auth: trData.auth,
            common: trData.common,
          },
        },
      };

      setItemSpy.mockClear();

      await i18n.changeLanguage("tr");

      // Verify cache was written to persistent storage
      const calls = setItemSpy.mock.calls as Array<[string, string]>;
      const translationWriteCall = calls.find(([key]) =>
        key.includes(PROJECT) && key.includes("tr") && key.includes("translations")
      );
      expect(translationWriteCall).toBeDefined();

      // Verify written data contains the namespaces (excluding "translation")
      const writtenData = JSON.parse(translationWriteCall![1]);
      expect(writtenData).toHaveProperty("auth");
      expect(writtenData).toHaveProperty("common");
      expect(writtenData).not.toHaveProperty("translation");
    });

    it("awaits writeCache before returning from loadMessages", async () => {
      const { i18n } = createMockI18n();
      const storage = createMemoryStorage();

      await initBetterI18n({
        project: PROJECT,
        i18n,
        storage,
        defaultLocale: "en",
      });

      // After init, cache should already be written (await, not fire-and-forget)
      const cached = await storage.getItem(
        `@better-i18n:${PROJECT}:en:translations`
      );
      expect(cached).not.toBeNull();
      const parsed = JSON.parse(cached!);
      expect(parsed).toHaveProperty("auth");
    });
  });

  // -------------------------------------------------------------------------
  // languageChanged listener (safety-net)
  // -------------------------------------------------------------------------

  describe("languageChanged listener", () => {
    it("loads 'translation' NS and individual namespaces for the new language", async () => {
      const { i18n, mocks, listeners } = createMockI18n();

      await initBetterI18n({
        project: PROJECT,
        i18n,
        storage: createMemoryStorage(),
        defaultLocale: "en",
      });

      mocks.addResourceBundle.mockClear();

      // Directly trigger the safety-net listener
      const listener = listeners["languageChanged"]![0]! as (
        lang: string
      ) => Promise<void>;
      await listener("tr");

      const calls = mocks.addResourceBundle.mock.calls as Array<
        [string, string, unknown]
      >;
      const namespaces = calls.map(([, ns]) => ns);
      expect(namespaces).toContain("translation");
      expect(namespaces).toContain("auth");
      expect(namespaces).toContain("common");
    });

    it("does nothing when 'translation' NS is already loaded for the new language", async () => {
      const { i18n, mocks, bundles, listeners } = createMockI18n();

      await initBetterI18n({
        project: PROJECT,
        i18n,
        storage: createMemoryStorage(),
        defaultLocale: "en",
      });

      // Pre-populate "tr:translation" — safety-net should be a no-op
      bundles.set("tr:translation", mockMessages);
      mocks.addResourceBundle.mockClear();

      const listener = listeners["languageChanged"]![0]! as (
        lang: string
      ) => Promise<void>;
      await listener("tr");

      const calls = mocks.addResourceBundle.mock.calls as Array<
        [string, string, unknown]
      >;
      const trCalls = calls.filter(([locale]) => locale === "tr");
      expect(trCalls).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // LocaleAwareTranslationStorage — localeKey integration
  // -------------------------------------------------------------------------

  describe("LocaleAwareTranslationStorage via storageAdapter localeKey", () => {
    function makeLocaleAwareStorage(localeKey = "@app:locale") {
      const store = new Map<string, string>();
      const mockAS = {
        getItem: async (key: string) => store.get(key) ?? null,
        setItem: async (key: string, value: string) => { store.set(key, value); },
        removeItem: async (key: string) => { store.delete(key); },
      };
      return storageAdapter(mockAS, { localeKey });
    }

    it("reads initial locale from storage when localeKey is set", async () => {
      const { i18n, mocks } = createMockI18n();
      const storage = makeLocaleAwareStorage();

      // Pre-store a locale
      await (storage as any).writeLocale("tr");

      await initBetterI18n({
        project: PROJECT,
        i18n,
        storage,
        defaultLocale: "en",
      });

      const initOpts = mocks.init.mock.calls[0]![0] as Record<string, unknown>;
      expect(initOpts["lng"]).toBe("tr");
    });

    it("falls back to defaultLocale when no locale stored yet", async () => {
      const { i18n, mocks } = createMockI18n();
      const storage = makeLocaleAwareStorage();

      await initBetterI18n({
        project: PROJECT,
        i18n,
        storage,
        defaultLocale: "en",
      });

      const initOpts = mocks.init.mock.calls[0]![0] as Record<string, unknown>;
      expect(initOpts["lng"]).toBe("en");
    });

    it("persists locale to storage on changeLanguage", async () => {
      const { i18n } = createMockI18n();
      const storage = makeLocaleAwareStorage();

      await initBetterI18n({
        project: PROJECT,
        i18n,
        storage,
        defaultLocale: "en",
      });

      await i18n.changeLanguage("tr");

      // Allow background writeLocale to complete
      await new Promise((r) => setTimeout(r, 0));
      expect(await (storage as any).readLocale()).toBe("tr");
    });

    it("does not add readLocale/writeLocale to plain storage", () => {
      const plain = createMemoryStorage();
      expect("readLocale" in plain).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Reactive language list (subscribeLanguages / getLanguagesSnapshot)
  // -------------------------------------------------------------------------

  describe("subscribeLanguages / getLanguagesSnapshot", () => {
    it("getLanguagesSnapshot returns [] before init", () => {
      // Note: if a previous test already called initBetterI18n,
      // _cachedLanguages may be populated. This tests the snapshot API works.
      const snapshot = getLanguagesSnapshot();
      expect(Array.isArray(snapshot)).toBe(true);
    });

    it("getLanguages and getLanguagesSnapshot return the same reference", async () => {
      const { i18n } = createMockI18n();

      await initBetterI18n({
        project: PROJECT,
        i18n,
        storage: createMemoryStorage(),
        defaultLocale: "en",
      });

      expect(getLanguages()).toBe(getLanguagesSnapshot());
    });

    it("notifies subscribers when initBetterI18n completes", async () => {
      const { i18n } = createMockI18n();
      const listener = mock(() => {});

      const unsubscribe = subscribeLanguages(listener);

      await initBetterI18n({
        project: PROJECT,
        i18n,
        storage: createMemoryStorage(),
        defaultLocale: "en",
      });

      expect(listener).toHaveBeenCalledTimes(1);

      // After init, snapshot should have languages
      const snapshot = getLanguagesSnapshot();
      expect(snapshot.length).toBeGreaterThan(0);

      unsubscribe();
    });

    it("unsubscribe prevents further notifications", async () => {
      const { i18n } = createMockI18n();
      const listener = mock(() => {});

      const unsubscribe = subscribeLanguages(listener);
      unsubscribe();

      await initBetterI18n({
        project: PROJECT,
        i18n,
        storage: createMemoryStorage(),
        defaultLocale: "en",
      });

      expect(listener).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Unsupported locale fallback
  // -------------------------------------------------------------------------

  describe("unsupported locale fallback", () => {
    it("falls back to defaultLocale when device locale is not in supported languages", async () => {
      const { i18n, mocks } = createMockI18n();

      // Project only has en and tr
      mockLanguages = [{ code: "en" }, { code: "tr" }];
      // Spanish returns empty (unsupported locale)
      mockMessagesByLocale["es"] = {};
      // English has real translations
      mockMessagesByLocale["en"] = {
        auth: { login: "Sign In" },
        common: { welcome: "Welcome" },
      };

      await initBetterI18n({
        project: PROJECT,
        i18n,
        storage: createMemoryStorage(),
        defaultLocale: "en",
        useDeviceLocale: false,
        i18nextOptions: {
          lng: "es", // simulate device locale override
        },
      });

      const initOpts = mocks.init.mock.calls[0]![0] as Record<string, unknown>;
      // Should have fallen back to "en", not "es"
      expect(initOpts["lng"]).toBe("en");

      // Resources should contain English translations
      const resources = initOpts["resources"] as Record<string, Record<string, unknown>>;
      expect(resources["en"]).toBeDefined();
      expect(resources["en"]!["translation"]).toEqual(
        mockMessagesByLocale["en"]
      );
    });

    it("loads defaultLocale as fallback when effective locale differs", async () => {
      const { i18n, mocks } = createMockI18n();

      mockLanguages = [{ code: "en" }, { code: "tr" }, { code: "de" }];
      const trMessages = { common: { welcome: "Hoşgeldiniz" } };
      const enMessages = { common: { welcome: "Welcome" } };
      mockMessagesByLocale["tr"] = trMessages;
      mockMessagesByLocale["en"] = enMessages;

      await initBetterI18n({
        project: PROJECT,
        i18n,
        storage: createMemoryStorage(),
        defaultLocale: "en",
        useDeviceLocale: false,
        i18nextOptions: { lng: "tr" },
      });

      const initOpts = mocks.init.mock.calls[0]![0] as Record<string, unknown>;
      const resources = initOpts["resources"] as Record<string, Record<string, unknown>>;

      // Both tr (effective) and en (fallback) should be in resources
      expect(resources["tr"]).toBeDefined();
      expect(resources["en"]).toBeDefined();
      expect(resources["tr"]!["translation"]).toEqual(trMessages);
      expect(resources["en"]!["translation"]).toEqual(enMessages);
    });

    it("strips lng from i18nextOptions to prevent override of SDK-computed locale", async () => {
      const { i18n, mocks } = createMockI18n();

      mockLanguages = [{ code: "en" }, { code: "tr" }];

      await initBetterI18n({
        project: PROJECT,
        i18n,
        storage: createMemoryStorage(),
        defaultLocale: "en",
        i18nextOptions: {
          lng: "es", // unsupported — should be stripped
          compatibilityJSON: "v4", // should be preserved
        },
      });

      const initOpts = mocks.init.mock.calls[0]![0] as Record<string, unknown>;
      // lng should be "en" (fallback), not "es"
      expect(initOpts["lng"]).toBe("en");
      // compatibilityJSON should be preserved
      expect(initOpts["compatibilityJSON"]).toBe("v4");
    });
  });
});


// ---------------------------------------------------------------------------
// Schema-2 cache: version-keyed disk copy, stale, errors, revalidation
// ---------------------------------------------------------------------------

describe("schema-2 cache", () => {
  const manifestAt = (version: string, revision: number) => ({
    schema: 2,
    revision,
    languages: [{ code: "en" }],
    files: { en: { version } },
  });

  beforeEach(() => {
    mockMessages = { common: { hello: "Hello" } };
    mockMessagesByLocale = {};
    mockLanguages = [{ code: "en" }];
    mockManifest = manifestAt("aaaaaa01-aaaa", 1);
    mockStale = false;
    mockUpdateListeners.clear();
    mockRevalidated = [];
  });

  it("persists the copy under a version-keyed entry and records the version in meta", async () => {
    const storage = createMemoryStorage();
    const { i18n } = createMockI18n();
    await initBetterI18n({ project: PROJECT, i18n, storage, revalidate: false });

    expect(await storage.getItem(buildVersionedStorageKey(PROJECT, "en", "aaaaaa01-aaaa"))).toBe(
      JSON.stringify(mockMessages)
    );
    const meta = JSON.parse((await storage.getItem(buildMetaKey(PROJECT, "en")))!);
    expect(meta).toMatchObject({ version: "aaaaaa01-aaaa", revision: 1 });
  });

  it("does not write a stale fallback back to disk as if it were fresh", async () => {
    mockStale = true;
    const storage = createMemoryStorage();
    const { i18n } = createMockI18n();
    await initBetterI18n({ project: PROJECT, i18n, storage, revalidate: false });
    expect(await storage.getItem(buildStorageKey(PROJECT, "en"))).toBeNull();
  });

  it("a disk write failure is reported through onError and the load still succeeds", async () => {
    const base = createMemoryStorage();
    const storage = {
      ...base,
      setItem: async () => {
        throw new Error("disk full");
      },
    };
    const errors: any[] = [];
    const { i18n, mocks } = createMockI18n();
    await initBetterI18n({
      project: PROJECT,
      i18n,
      storage,
      revalidate: false,
      onError: (e) => errors.push(e),
    });
    expect(mocks.init).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({ phase: "cache-write", locale: "en" });
    expect((errors[0].error as Error).message).toBe("disk full");
  });

  it("getStatus().storageError shows the failed disk write and clears after a good one", async () => {
    let fail = true;
    const base = createMemoryStorage();
    const storage = {
      ...base,
      setItem: async (k: string, v: string) => {
        if (fail) throw new Error("disk full");
        return base.setItem(k, v);
      },
    };
    const { i18n } = createMockI18n();
    const { getStatus } = await initBetterI18n({
      project: PROJECT,
      i18n,
      storage,
      revalidate: false,
      onError: () => {},
    });
    expect(getStatus().storageError).toBe("disk full");

    fail = false;
    for (const l of mockUpdateListeners) {
      l({ locale: "en", messages: { common: { hello: "Hi" } }, version: "aaaaaa02-aaaa", revision: 2 });
    }
    await new Promise((r) => setTimeout(r, 0));
    expect(getStatus().storageError).toBeNull();
  });

  it("without onError a disk write failure is logged, not swallowed", async () => {
    const warn = mock(() => {});
    const original = console.warn;
    console.warn = warn as any;
    try {
      const base = createMemoryStorage();
      const { i18n } = createMockI18n();
      await initBetterI18n({
        project: PROJECT,
        i18n,
        storage: { ...base, setItem: async () => { throw new Error("disk full"); } },
        revalidate: false,
      });
    } finally {
      console.warn = original;
    }
    expect(warn.mock.calls.some((c: any[]) => String(c[0]).includes("cache-write"))).toBe(true);
  });

  it("revalidates loaded locales when the app returns to the foreground, at most once per interval", async () => {
    const handlers: Array<(state: string) => void> = [];
    let removed = false;
    const appState = {
      addEventListener: (_t: "change", h: (state: string) => void) => {
        handlers.push(h);
        return { remove: () => { removed = true; } };
      },
    };
    const { i18n } = createMockI18n();
    const { dispose } = await initBetterI18n({
      project: PROJECT,
      i18n,
      storage: createMemoryStorage(),
      revalidate: { minIntervalMs: 0, appState },
    });

    handlers[0]!("background");
    expect(mockRevalidated).toEqual([]);
    handlers[0]!("active");
    expect(mockRevalidated).toEqual(["en"]);

    dispose();
    expect(removed).toBe(true);
    expect(mockUpdateListeners.size).toBe(0);
  });

  it("does not revalidate again inside minIntervalMs", async () => {
    const handlers: Array<(state: string) => void> = [];
    const { i18n } = createMockI18n();
    await initBetterI18n({
      project: PROJECT,
      i18n,
      storage: createMemoryStorage(),
      revalidate: {
        minIntervalMs: 60_000,
        appState: { addEventListener: (_t, h) => { handlers.push(h); } },
      },
    });
    handlers[0]!("active");
    expect(mockRevalidated).toEqual([]);
  });

  it("a verified update lands in i18next, on disk under the new version, and keeps only two versions", async () => {
    const storage = createMemoryStorage();
    const { i18n, mocks } = createMockI18n();
    const updates: any[] = [];
    await initBetterI18n({
      project: PROJECT,
      i18n,
      storage,
      revalidate: false,
      onUpdate: (e) => updates.push(e),
    });
    mocks.addResourceBundle.mockClear();

    const publish = async (version: string, revision: number, hello: string) => {
      for (const l of mockUpdateListeners) {
        l({ locale: "en", messages: { common: { hello } }, version, revision });
      }
      await new Promise((r) => setTimeout(r, 0));
    };
    await publish("aaaaaa02-aaaa", 2, "Hi");
    await publish("aaaaaa03-aaaa", 3, "Hey");

    const added = mocks.addResourceBundle.mock.calls as Array<[string, string, any]>;
    expect(added.some(([l, ns, d]) => l === "en" && ns === "common" && d.hello === "Hey")).toBe(true);
    expect(updates.map((u) => u.revision)).toEqual([2, 3]);

    // 01 was pruned; 02 (previous) and 03 (current) remain.
    expect(await storage.getItem(buildVersionedStorageKey(PROJECT, "en", "aaaaaa01-aaaa"))).toBeNull();
    expect(await storage.getItem(buildVersionedStorageKey(PROJECT, "en", "aaaaaa02-aaaa"))).not.toBeNull();
    expect(await storage.getItem(buildVersionedStorageKey(PROJECT, "en", "aaaaaa03-aaaa"))).not.toBeNull();
    const cached = await readCache(storage, PROJECT, "en");
    expect(cached?.data).toEqual({ common: { hello: "Hey" } });
    expect(cached?.meta).toMatchObject({ version: "aaaaaa03-aaaa", previousVersion: "aaaaaa02-aaaa", revision: 3 });
  });
});
