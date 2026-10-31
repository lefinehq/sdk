import type { CacheStatus, CacheUpdateEvent, I18nCore, Messages } from "@better-i18n/core";

type UpdateSource = Pick<I18nCore, "onMessagesUpdate" | "onUpdate" | "getStatus">;

export interface CoreUpdateHandlers {
  /** Active locale; events for other locales are ignored. */
  locale: string;
  /** Swap the new payload into state. */
  onMessages: (messages: Messages) => void;
  /** Host callback: a verified update replaced the active locale's copy. */
  onUpdate?: (event: CacheUpdateEvent) => void;
  /** Cache state changed (after an update). */
  onStatus?: (status: CacheStatus) => void;
}

/**
 * Subscribe a provider to its core's update bus. The messages swap uses
 * `onMessagesUpdate` (fires for schema-1 and schema-2 alike); `onUpdate` adds
 * the revision/version detail for schema-2 manifests. Returns one unsubscribe.
 */
export function subscribeToCoreUpdates(core: UpdateSource, handlers: CoreUpdateHandlers): () => void {
  const offMessages = core.onMessagesUpdate((event) => {
    if (event.locale !== handlers.locale) return;
    handlers.onMessages(event.messages as Messages);
    handlers.onStatus?.(core.getStatus());
  });
  const offUpdate = core.onUpdate((event) => {
    if (event.locale !== handlers.locale) return;
    handlers.onUpdate?.(event);
  });
  return () => {
    offMessages();
    offUpdate();
  };
}

/**
 * Ask the core to revalidate and report the resulting cache state, whatever
 * the outcome (a failed check is exactly when `stale` matters). Never throws.
 */
export async function revalidateAndReport(
  core: Pick<I18nCore, "revalidate" | "getStatus">,
  locale: string,
  namespaces: string[] | undefined,
  onStatus?: (status: CacheStatus) => void,
): Promise<void> {
  try {
    await core.revalidate(locale, { namespaces });
  } catch {
    // Best-effort — the cached copy keeps serving.
  }
  onStatus?.(core.getStatus());
}

/** Field-by-field equality of two cache states, `lastCheckedAt` excluded (it moves on every check). */
export function sameStatus(a: CacheStatus, b: CacheStatus): boolean {
  return (
    a.stale === b.stale &&
    a.revision === b.revision &&
    a.integrityFailures === b.integrityFailures &&
    a.lastError === b.lastError &&
    a.storageError === b.storageError
  );
}
