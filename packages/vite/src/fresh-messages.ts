import type { I18nCore, Messages } from "@better-i18n/core";

/**
 * Messages for one dev-server HTML request, checked for freshness first.
 *
 * `revalidate()` is a manifest check (a 304 when nothing was published) that
 * moves the core to the newest verified copy, so a page reload after a publish
 * shows it without waiting for the manifest TTL. When the core had to serve
 * its last verified copy (CDN down, failed integrity check) the plugin says so
 * once per outage instead of silently injecting old text.
 */
export const createFreshMessagesLoader = (
  core: Pick<I18nCore, "revalidate" | "getMessages" | "getStatus">,
  warn: (message: string) => void,
) => {
  let warnedStale = false;
  return async (locale: string): Promise<Messages> => {
    await core.revalidate(locale).catch(() => {
      // Best-effort: getMessages below still serves or throws.
    });
    const messages = await core.getMessages(locale);
    const status = core.getStatus();
    if (status.stale && !warnedStale) {
      warnedStale = true;
      warn(
        `[better-i18n] serving the last verified translations for "${locale}" (${status.lastError ?? "CDN unreachable"})`,
      );
    } else if (!status.stale) {
      warnedStale = false;
    }
    return messages;
  };
};
