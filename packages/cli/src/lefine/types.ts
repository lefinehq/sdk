/**
 * Shapes of the `strings.*` actions as this client uses them.
 *
 * Written from the actions' documented outputs (`/v1/ops/strings.*`); the types
 * below are the parts of those outputs this client reads.
 */

export interface AppSummary {
  id: string;
  slug: string;
  name: string;
  sourceLocale: string;
  targetLocales: string[];
  keyCount: number;
}

/** Input of strings.import.preview; apply takes the same plus `digest`. */
export interface ImportFileInput {
  appId: string;
  locale: string;
  namespace: string;
  fileName: string;
  content: string;
  /** Target languages: reviewed (default) or approved (lefine import from a tool that tracked approval). */
  state?: "reviewed" | "approved";
}

export interface ChangeItem {
  namespace: string;
  key: string;
  kind: "added" | "edited" | "removed";
  before: string | null;
  after: string | null;
  author: string | null;
}

export interface ChangeSet {
  locales: Array<{
    locale: string;
    added: number;
    edited: number;
    removed: number;
    items: ChangeItem[];
    truncated: boolean;
  }>;
}

export interface ImportPreview {
  /** Pass to strings.import.apply: what was shown is what is applied. */
  digest: string;
  source: number;
  tally: { created: number; updated: number; skipped: number; dropped: number };
  dropped: Array<{ key: string; reason: string }>;
  newNamespace: boolean;
  alreadyImported: { runId: string; at: string } | null;
  /** Empty `locales`: nothing would change. */
  changes: ChangeSet;
}

export type RunStatus = "running" | "waiting" | "succeeded" | "partial" | "failed";

export interface Run {
  id: string;
  status: RunStatus;
  steps: Array<{ name: string; status: string; detail: string }>;
  counts: { source: number; pushed: number; live: number | null };
  tally: { created: number; updated: number; skipped: number; dropped: number; failed?: number };
  failure?: { step: string; reason: string; fixAction: string };
}

/** Result of strings.import.apply and strings.releases.publish. */
export interface RunOutput {
  run: Run;
  replayed: boolean;
}

export interface CheckPage {
  keys: number;
  checked: number;
  problems: Array<{ namespace: string; key: string; locale: string; reason: string; message: string }>;
  nextCursor: string | null;
}

export interface ReleasePreview {
  appId: string;
  cdnEnabled: boolean;
  liveVersion: string | null;
  locales: Array<{
    locale: string;
    willServe: number;
    draftsExcluded: number;
    added: number;
    edited: number;
    removed: number;
  }>;
  keysAdded: number;
  keysChanged: number;
  keysRemoved: number;
  blocker: string | null;
}

/** Shared with the dashboard: the blocker when every language is already live. */
export const NOTHING_TO_PUBLISH = "Nothing to publish: every language is already live.";

export interface DeliveryCheck {
  locale: string;
  version: string;
  expectedKeys: number;
  servedKeys: number;
  status: "ok" | "partial" | "empty";
  checkedAt?: string;
}

/** strings.delivery.checks: the latest version and a check per locale. */
export interface DeliveryChecks {
  version: string | null;
  checks: DeliveryCheck[];
}

/** Lists come as `{ items }`, or `{ items, nextCursor }` when they page. */
export function itemsOf<T>(result: unknown): T[] {
  const items = (result as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? (items as T[]) : [];
}
