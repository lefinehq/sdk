/**
 * Byte verification for schema-2 manifests (Lefine CDN contract, section 2b).
 *
 * A schema-2 manifest names, per locale, the SHA-256 of the exact bytes served
 * at the snapshot URL and the number of texts in the file. The SDK checks both
 * before a download is allowed to replace the cached copy.
 */
import type { ManifestFileEntry, ManifestResponse } from "./types.js";

export type IntegrityFailure = "empty" | "hash" | "count";

/** Thrown when a download does not match what the manifest promised. */
export class IntegrityError extends Error {
  readonly code: IntegrityFailure;
  constructor(code: IntegrityFailure, message: string) {
    super(`[better-i18n] ${message}`);
    this.name = "IntegrityError";
    this.code = code;
  }
}

/** `true` for a Lefine manifest (`schema: 2` or higher). Better i18n manifests have no `schema`. */
export const isSchema2 = (
  manifest: Pick<ManifestResponse, "schema"> | null | undefined,
): boolean => typeof manifest?.schema === "number" && manifest.schema >= 2;

/** Texts in a served `{ namespace: { key: text } }` object. Anything that is not an object is a text. */
export const countKeys = (messages: unknown): number => {
  if (messages === null || typeof messages !== "object") return 0;
  let total = 0;
  for (const value of Object.values(messages)) {
    total += value !== null && typeof value === "object" ? countKeys(value) : 1;
  }
  return total;
};

/**
 * Hex SHA-256 of `bytes`, or `null` when Web Crypto is not available
 * (React Native / Hermes has no `crypto.subtle` unless a polyfill is installed).
 * Callers skip the hash check on `null` and still enforce `keyCount`.
 */
export const sha256Hex = async (
  bytes: ArrayBuffer | Uint8Array,
): Promise<string | null> => {
  const subtle = (globalThis as { crypto?: { subtle?: SubtleCrypto } }).crypto
    ?.subtle;
  if (!subtle) return null;
  const digest = await subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(digest), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
};

/** What a download has to match, when the manifest says anything about it. */
export const hasIntegrityClaims = (
  entry: ManifestFileEntry | undefined,
): entry is ManifestFileEntry =>
  !!entry && (typeof entry.sha256 === "string" || typeof entry.keyCount === "number");

/**
 * Verify a downloaded locale file against its manifest entry and return the
 * parsed messages. Throws {@link IntegrityError} on any mismatch, and on a body
 * that is not a JSON object (an error object or `{}` is never accepted as
 * messages when the manifest promised texts).
 *
 * `onHashUnavailable` is called once per verification when Web Crypto is
 * missing, so the caller can log it.
 */
export const verifyLocaleBytes = async (
  bytes: ArrayBuffer,
  entry: ManifestFileEntry,
  locale: string,
  onHashUnavailable?: () => void,
): Promise<Record<string, unknown>> => {
  const expectedKeys = entry.keyCount;
  const text = new TextDecoder().decode(bytes);

  if (text.trim() === "" || text.trim() === "{}") {
    throw new IntegrityError(
      "empty",
      `Locale "${locale}" came back empty${typeof expectedKeys === "number" ? ` (${expectedKeys} texts expected)` : ""}`,
    );
  }

  if (typeof entry.sha256 === "string") {
    const actual = await sha256Hex(bytes);
    if (actual === null) onHashUnavailable?.();
    else if (actual !== entry.sha256.toLowerCase()) {
      throw new IntegrityError(
        "hash",
        `Locale "${locale}" does not match the manifest sha256`,
      );
    }
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new IntegrityError("empty", `Locale "${locale}" is not valid JSON`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new IntegrityError("empty", `Locale "${locale}" is not a JSON object`);
  }

  if (typeof expectedKeys === "number") {
    const served = countKeys(parsed);
    if (served !== expectedKeys) {
      throw new IntegrityError(
        "count",
        `Locale "${locale}" holds ${served} texts, the manifest says ${expectedKeys}`,
      );
    }
  }

  return parsed as Record<string, unknown>;
};
