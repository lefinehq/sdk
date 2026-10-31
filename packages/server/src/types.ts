import type { I18nCore, I18nCoreConfig, LanguageOption } from "@better-i18n/core";
import type { createTranslator } from "use-intl/core";

/**
 * Translator function returned by getTranslator()
 * Thin alias for the use-intl/core createTranslator return type
 */
export type Translator = ReturnType<typeof createTranslator>;

/**
 * Configuration for createServerI18n() — mirrors I18nCoreConfig exactly
 */
export type ServerI18nConfig = I18nCoreConfig;

/**
 * Server-side i18n instance returned by createServerI18n()
 */
export interface ServerI18n {
  /**
   * Resolved configuration
   */
  config: I18nCoreConfig;

  /**
   * Get a translator function for the given locale.
   * Messages are fetched and cached via TtlCache.
   */
  getTranslator(locale: string, namespace?: string): Promise<Translator>;

  /**
   * Detect the best-matching locale from Web Standards Headers object.
   * Uses Accept-Language header and falls back to defaultLocale.
   */
  detectLocaleFromHeaders(headers: Headers): Promise<string>;

  /**
   * Get available locale codes from the CDN manifest
   */
  getLocales(): Promise<string[]>;

  /**
   * Get language options with metadata (for responses, UI, etc.)
   */
  getLanguages(): Promise<LanguageOption[]>;

  /**
   * Check the CDN manifest for `locale` (a 304 when nothing was published) and
   * refetch only if its version moved. Call it on a timer or a webhook in a
   * long-lived server; the subscribers below hear about the result.
   */
  revalidate: I18nCore["revalidate"];

  /**
   * Subscribe to verified updates (schema-2 manifests): `revision`, `version`,
   * `changesUrl`. Scoped to this instance's project. Returns an unsubscribe.
   */
  onUpdate: I18nCore["onUpdate"];

  /** Cache state: `stale`, `revision`, `integrityFailures`, `storageError`, ... */
  getStatus: I18nCore["getStatus"];

  /** What changed since `revision` (reads the release's `changes.json`). */
  changesSince: I18nCore["changesSince"];
}
