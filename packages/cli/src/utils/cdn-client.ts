/**
 * CDN client utilities
 *
 * Functions for fetching translation data from Better i18n CDN.
 * Extracted from sync.ts for reuse in doctor and sync commands.
 */

import { createHash } from "node:crypto";
import type { CdnChangesFile, CdnManifest } from "../analyzer/types.js";
import type { RemoteTranslations } from "./json-keys.js";

/**
 * Fetch project manifest from CDN.
 *
 * The manifest contains language metadata, file URLs, and last-modified timestamps.
 * Used as the entry point for all CDN operations.
 */
/** The app's folder on the CDN: `/{workspace}/{app}`, or `/{appId}` (the id path, no project slug). */
export const appBase = (cdnBaseUrl: string, workspaceId: string, projectSlug: string): string =>
  projectSlug ? `${cdnBaseUrl}/${workspaceId}/${projectSlug}` : `${cdnBaseUrl}/${workspaceId}`;

export async function fetchManifest(
  cdnBaseUrl: string,
  workspaceId: string,
  projectSlug: string,
): Promise<CdnManifest> {
  const url = `${appBase(cdnBaseUrl, workspaceId, projectSlug)}/manifest.json`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Manifest fetch failed (${response.status})`);
  }

  // CDN returns 200 with an empty body for projects that were never published.
  // Validate the shape so callers get a clear error instead of a TypeError.
  const data = (await response.json()) as CdnManifest;
  if (!data || !Array.isArray(data.languages)) {
    throw new Error(
      "Project has no published translations yet. Publish once from the dashboard (or `better-i18n publish`) and retry.",
    );
  }

  return data;
}

/** Same shape as the core SDK's snapshot version check; anything else is not a snapshot. */
const VERSION_PATTERN = /^[a-z0-9]{6,12}-[a-z0-9]{4,12}$/;

const isSchema2 = (manifest: CdnManifest | null | undefined): boolean =>
  typeof manifest?.schema === "number" && manifest.schema >= 2;

/** Texts in a `{ namespace: { key: text } }` object (nested objects are walked). */
export function countTexts(messages: unknown): number {
  if (messages === null || typeof messages !== "object") return 0;
  let total = 0;
  for (const value of Object.values(messages)) {
    total += value !== null && typeof value === "object" ? countTexts(value) : 1;
  }
  return total;
}

/** A downloaded file does not match what the manifest promised. */
export class CdnIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CdnIntegrityError";
  }
}

/**
 * Fetch remote translation keys for a specific locale.
 *
 * With a schema-2 manifest the immutable snapshot URL is used and the bytes
 * are checked against the file's `sha256` and `keyCount` before they are
 * returned (`CdnIntegrityError` on any mismatch, `{}` included). A schema-1
 * manifest is read exactly as before.
 *
 * Uses manifest URL if available (preferred, as it may include CDN cache-busting),
 * otherwise constructs a fallback URL from convention.
 */
export async function fetchRemoteKeys(
  cdnBaseUrl: string,
  workspaceId: string,
  projectSlug: string,
  locale: string,
  manifest: CdnManifest | null,
): Promise<RemoteTranslations> {
  const entry = manifest?.files?.[locale];
  const verify = isSchema2(manifest) && !!entry && (typeof entry.sha256 === "string" || typeof entry.keyCount === "number");

  let url: string;
  if (isSchema2(manifest) && entry?.version && VERSION_PATTERN.test(entry.version)) {
    // Immutable snapshot: the bytes `sha256` was computed over, never a newer overwrite.
    url = `${appBase(cdnBaseUrl, workspaceId, projectSlug)}/v/${entry.version}/${locale}/translations.json`;
  } else if (manifest?.files?.[locale]?.url) {
    url = manifest.files[locale].url;
  } else {
    /* The published layout is /{org}/{project}/{locale}/translations.json.
       The previous fallback asked for /{org}/{project}/translations/{locale}.json,
       which the CDN answers with 200 and an empty `{}` rather than a 404 — so a
       wrong URL was indistinguishable from an unpublished project, and `pull`
       wrote empty locale files while reporting success. */
    url = `${appBase(cdnBaseUrl, workspaceId, projectSlug)}/${locale}/translations.json`;
  }

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`CDN fetch failed (${response.status})`);
  }

  if (!verify || !entry) {
    return response.json() as Promise<RemoteTranslations>;
  }

  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString("utf-8");
  if (text.trim() === "" || text.trim() === "{}") {
    throw new CdnIntegrityError(
      `${locale}: the CDN returned an empty file${typeof entry.keyCount === "number" ? ` (${entry.keyCount} texts expected)` : ""}`,
    );
  }
  if (typeof entry.sha256 === "string") {
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== entry.sha256.toLowerCase()) {
      throw new CdnIntegrityError(`${locale}: the file does not match the manifest sha256`);
    }
  }
  let parsed: RemoteTranslations;
  try {
    parsed = JSON.parse(text) as RemoteTranslations;
  } catch {
    throw new CdnIntegrityError(`${locale}: the file is not valid JSON`);
  }
  if (typeof entry.keyCount === "number") {
    const served = countTexts(parsed);
    if (served !== entry.keyCount) {
      throw new CdnIntegrityError(
        `${locale}: the file holds ${served} texts, the manifest says ${entry.keyCount}`,
      );
    }
  }
  return parsed;
}

/**
 * Read `changes.json` of the release the manifest names. The manifest is
 * remote input and gives an absolute URL on its own public origin; only the
 * release version is taken from it and the file is read from the CDN the
 * caller configured (which also makes it work through a proxy or a local
 * edge). `null` when the manifest names none, the file is gone (pruned like
 * old locale files) or it is not a change list.
 */
export async function fetchChanges(
  cdnBaseUrl: string,
  workspaceId: string,
  projectSlug: string,
  manifest: CdnManifest,
): Promise<CdnChangesFile | null> {
  if (!manifest.changesUrl) return null;
  try {
    const [segment, version, file] = new URL(manifest.changesUrl).pathname.split("/").slice(-3);
    if (segment !== "v" || file !== "changes.json" || !version || !VERSION_PATTERN.test(version)) return null;
    const response = await fetch(`${appBase(cdnBaseUrl, workspaceId, projectSlug)}/v/${version}/changes.json`);
    if (!response.ok) return null;
    const body = (await response.json()) as CdnChangesFile | null;
    return body && typeof body.revision === "number" && body.locales && typeof body.locales === "object"
      ? body
      : null;
  } catch {
    return null;
  }
}

/**
 * Fetch a single locale file from CDN.
 *
 * Convenience wrapper that combines manifest lookup + locale fetch.
 * Returns null if the locale is not available.
 */
export async function fetchLocaleFile(
  cdnBaseUrl: string,
  workspaceId: string,
  projectSlug: string,
  locale: string,
): Promise<RemoteTranslations | null> {
  try {
    const manifest = await fetchManifest(cdnBaseUrl, workspaceId, projectSlug);

    if (!manifest.files?.[locale]) {
      return null;
    }

    return await fetchRemoteKeys(
      cdnBaseUrl,
      workspaceId,
      projectSlug,
      locale,
      manifest,
    );
  } catch {
    return null;
  }
}
