// lefine/server: strings for any React SSR app (TanStack Start, Remix, Vite SSR, Hono). lefine/next builds on it.

import { compileMessages } from "../strings/compile.js";
import { devOnError } from "../strings/dev.js";
import type { FormatError, Formats } from "../strings/format.js";
import type { MessageTree } from "../strings/ir.js";
import { createStringsLoader, DEFAULT_CDN_URL, type StringsStorage } from "../strings/loader.js";

export type { StringsStorage };
import { createTranslator } from "../strings/translator.js";
// Types through lefine/strings, so its declaration file is in every app that uses this entry: the app's
// `declare module "lefine/strings"` (lefine strings types) then applies to getStrings and useStrings too.
import type { KeyOf, Namespace, Translator } from "../strings/index.js";

export interface ServerConfig {
  /** The app's id, `app_...`: `npx lefine init` writes it. Never a name (names change). */
  project: string;
  /** For dates in texts, the same on server and client. Default UTC. */
  timeZone?: string;
  /** Named formats for your own `{n, number, money}`-style styles. */
  formats?: Formats;
  /** Server side: a missing key, value or format, as it happens. */
  onError?: (error: FormatError) => void;
  /** Another edge (local or staging). Default https://cdn.lefine.ai. */
  cdn?: string;
  /**
   * React Native: AsyncStorage or MMKV behind `{ get, set }`. The last manifest and language files stay on the
   * device; a cold start serves them at once (no network needed) and refreshes in the background.
   */
  storage?: StringsStorage;
  /**
   * The published texts as they were at build time (`npx lefine strings snapshot` writes the file). The first
   * request after a deploy is served from it at once while the edge is asked in the background; the next render has
   * what the edge has. Without it, that first request waits for the edge (two round trips).
   */
  snapshot?: StringsSnapshot;
}

/** What `npx lefine strings snapshot` writes: the manifest and each language's verified file, by storage key. */
export type StringsSnapshot = Record<string, string>;

/** A snapshot read as storage: nothing is written back to it. */
const snapshotStorage = (snapshot: StringsSnapshot): StringsStorage => ({
  get: async (key) => (Object.hasOwn(snapshot, key) ? snapshot[key] : null),
  set: async () => undefined,
});

/**
 * Reads the live manifest and every published language from the edge, checked as a render checks them, and returns
 * them as a snapshot for `snapshot`. For a build step; `npx lefine strings snapshot` calls it.
 */
export async function createSnapshot(config: { project: string; cdn?: string; locales?: readonly string[]; fetch?: typeof fetch }): Promise<StringsSnapshot> {
  const snapshot: StringsSnapshot = {};
  const recorder: StringsStorage = { get: async () => null, set: async (key, value) => void (snapshot[key] = value) };
  const loader = createStringsLoader({ project: config.project, cdnBaseUrl: config.cdn ?? DEFAULT_CDN_URL, storage: recorder, fetch: config.fetch });
  const locales = config.locales ?? (await loader.locales());
  for (const locale of locales) await loader.load(locale);
  // The writes are fire-and-forget in the loader: let them land.
  await new Promise((r) => setTimeout(r, 0));
  return snapshot;
}

/** What `<StringsProvider {...props}>` needs: plain JSON, so it can go through a route loader or RSC. */
export interface StringsProps {
  locale: string;
  messages: MessageTree;
  timeZone: string;
  formats?: Formats;
  /** Development only: for the "strings updated" toast. */
  live?: { base: string; revision: number };
}

/** Shared with lefine/next, which passes Next's fetch and lets Next's data cache hold the manifest. */
// `wrap`: lefine/next keys t.rich output for React (react/keyed.ts). lefine/server passes none, so it imports no React
// and works in a Vue, Svelte, Hono or React Native app (framework-support.md).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Wrap = <T extends Translator<any, any>>(t: T) => T;

export function createCore(config: ServerConfig, options: { fetch?: typeof fetch; manifestTtlMs?: number; staleWhileRevalidate?: boolean; shareInFlight?: boolean; wrap?: Wrap } = {}) {
  const { wrap = (t) => t, ...loaderOptions } = options;
  const storage = config.storage ?? (config.snapshot ? snapshotStorage(config.snapshot) : undefined);
  const loader = createStringsLoader({ project: config.project, cdnBaseUrl: config.cdn ?? DEFAULT_CDN_URL, storage, ...loaderOptions, fetch: options.fetch });
  const timeZone = config.timeZone ?? "UTC";
  try {
    new Intl.DateTimeFormat("en", { timeZone });
  } catch {
    throw new Error(`lefine: timeZone "${timeZone}" is not one Intl knows. Use an IANA name like "Europe/Istanbul".`);
  }
  const compiled = new Map<string, MessageTree>();

  /** A locale's texts: the edge's compiled file, or compiled here once per published version. */
  async function messages(locale: string): Promise<MessageTree> {
    const file = await loader.load(locale);
    const key = `${file.locale}|${file.stamp}`;
    let tree = compiled.get(key);
    if (!tree) {
      tree = file.ir ?? compileMessages(file.texts);
      compiled.set(key, tree);
    }
    return tree;
  }

  return {
    timeZone,
    messages,

    /** `const t = await strings.getStrings(locale, "home")`; `t("title")`, `t.rich("terms", { a })`. */
    async getStrings<N extends Namespace | undefined = undefined>(locale: string, namespace?: N): Promise<Translator<KeyOf<N>, N>> {
      const tree = await messages(locale);
      return wrap(createTranslator<N>({ locale, messages: tree, namespace, timeZone, formats: config.formats, onError: config.onError ?? devOnError(locale) }));
    },

    /** For the browser: only these namespaces, as props for `<StringsProvider>` (from a route loader). */
    async load(locale: string, namespaces: readonly string[]): Promise<StringsProps> {
      const tree = await messages(locale);
      const picked: MessageTree = {};
      for (const name of namespaces) if (tree[name] !== undefined) picked[name] = tree[name]!;
      const props: StringsProps = { locale, messages: picked, timeZone, ...(config.formats ? { formats: config.formats } : {}) };
      if (process.env.NODE_ENV !== "production") {
        // Development only: the provider tells you when a publish lands (react/dev-toast.ts). A production build drops it.
        const revision = (await loader.manifest()).revision;
        if (typeof revision === "number") props.live = { base: `${(config.cdn ?? DEFAULT_CDN_URL).replace(/\/+$/, "")}/${config.project}`, revision };
      }
      return props;
    },

    /**
     * The source texts of these namespaces as published, not compiled: `{ namespace: { key: "text" } }`, for code
     * that reads texts as data (copy objects merged over defaults). Formatting goes through getStrings / useStrings.
     */
    async texts(locale: string, namespaces: readonly string[]): Promise<Record<string, unknown>> {
      const file = await loader.load(locale);
      const picked: Record<string, unknown> = {};
      for (const name of namespaces) if (file.texts[name] !== undefined) picked[name] = file.texts[name];
      return picked;
    },

    /** The published languages, source first, for a language menu: code (as the CDN spells it), names, flag. */
    async languages(): Promise<Language[]> {
      const list = (await loader.manifest()).languages.map((l) => ({
        code: l.code.toLowerCase(),
        name: l.name ?? l.code,
        nativeName: l.nativeName ?? l.name ?? l.code,
        flagUrl: l.flagUrl ?? null,
        isSource: l.isSource === true,
      }));
      return [...list.filter((l) => l.isSource), ...list.filter((l) => !l.isSource)];
    },
  };
}

export interface Language {
  code: string;
  name: string;
  nativeName: string;
  flagUrl: string | null;
  isSource: boolean;
}

/**
 * `const strings = createStrings({ project: "app_..." })`, once at module scope. The manifest is kept 60 s (the
 * edge's max-age), versioned files for good; a publish shows within a minute. Unknown locales throw.
 */
export function createStrings(config: ServerConfig) {
  // With a snapshot, a render never waits for the edge: what is kept is served and refreshed in the background.
  const { getStrings, load, texts, languages } = createCore(config, { manifestTtlMs: 60_000, staleWhileRevalidate: config.snapshot !== undefined });
  return { getStrings, load, texts, languages };
}
