/**
 * `pull --since <revision>`: what changed on the CDN since the revision the
 * caller last pulled.
 *
 * `changes.json` compares a release with the one before it only, so the list
 * is complete when the caller is exactly one revision behind. Further back it
 * is only the last release's part, and the report says so instead of passing
 * a partial list off as the whole answer.
 */

import type { CdnChangesFile, CdnManifest } from "../analyzer/types.js";

/** Keys printed per locale and kind; the counts above them are exact. */
const KEYS_SHOWN = 10;

export function parseSinceRevision(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && /^\d+$/.test(raw.trim()) ? n : null;
}

export function describeChangesSince(
  manifest: Pick<CdnManifest, "revision">,
  since: number,
  changes: CdnChangesFile | null,
  locales?: string[],
): string[] {
  const current = manifest.revision;
  if (typeof current !== "number") {
    return ["--since needs a Lefine CDN: this manifest has no revisions."];
  }
  if (since >= current) {
    return [`Already at revision ${current}. Nothing changed since ${since}.`];
  }
  if (!changes || changes.revision !== current) {
    return [
      `Revision ${current} is ${current - since} ahead of ${since}, but its change list is not available (pruned or not published).`,
    ];
  }

  const lines: string[] = [];
  if (since === current - 1) {
    lines.push(`Changes since revision ${since} (now ${current}):`);
  } else {
    lines.push(
      `Revision ${current} is ${current - since} ahead of ${since}. The CDN lists only the last release (revision ${current}); earlier ones cannot be listed:`,
    );
  }

  const entries = Object.entries(changes.locales).filter(
    ([code]) => !locales || locales.includes(code),
  );
  const changed = entries.filter(([, c]) => c.added + c.changed + c.removed > 0);
  if (changed.length === 0) {
    lines.push("  No text changed in the selected locales.");
    return lines;
  }
  for (const [code, c] of changed) {
    lines.push(`  ${code}: +${c.added} added, ~${c.changed} changed, -${c.removed} removed`);
    for (const [label, keys] of [
      ["+", c.keys.added],
      ["~", c.keys.changed],
      ["-", c.keys.removed],
    ] as const) {
      for (const [ns, key] of keys.slice(0, KEYS_SHOWN)) lines.push(`      ${label} ${ns}:${key}`);
      if (keys.length > KEYS_SHOWN) lines.push(`      ${label} ... ${keys.length - KEYS_SHOWN} more`);
    }
    if (c.truncated) lines.push("      (the CDN cut the key list; the counts are exact)");
  }
  return lines;
}
