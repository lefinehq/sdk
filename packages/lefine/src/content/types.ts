/**
 * The shapes the Lefine edge serves for Content (the manifest and page files on the CDN), and what the client returns.
 * Kept as a copy on purpose: this package has no dependency on the Lefine monorepo. The fixture tests hold the two together.
 */

/** `{ws}/{prj}/c/manifest.json`. */
export interface ContentManifest {
  schema: 1;
  projectId: string;
  /** +1 per delivery that changed something. A higher number is newer. */
  revision: number;
  version: string;
  publishedAt: string;
  /** Lowercase locales that have at least one file. */
  languages: string[];
  /** The project's source language. Absent in older manifests. */
  sourceLocale?: string;
  /** Where a missing translation reads from; null when fallback is off. Absent before #67. */
  fallbackLocale?: string | null;
  /** `{ [locale]: { [collectionSlug]: file } }`. A language or content type with no live page is absent. */
  files: Record<string, Record<string, ContentManifestFile>>;
}

export interface ContentManifestFile {
  version: string;
  /** SHA-256 (hex) of the file's bytes. */
  sha256: string;
  size: number;
  entryCount: number;
  publishedAt: string;
}

/** One field that shows another language's value because it is empty in this one (#37). */
export interface FieldFallback {
  path: string;
  from: string;
}

/** One page in `v/{version}/{locale}/{collection}.json`. Field fallback is already applied. */
export interface ContentFileEntry<T = Record<string, unknown>> {
  id: string;
  slug: string | null;
  publishedAt: string;
  data: T;
  fallbacks: FieldFallback[];
}

export interface ContentFile<T = Record<string, unknown>> {
  collection: string;
  /** A global (one document, like a footer): `entries` holds that one document. Absent on a content type with a list. */
  kind?: "global";
  locale: string;
  entries: Array<ContentFileEntry<T>>;
}

/** A page as the client returns it. */
export interface ContentEntry<T = Record<string, unknown>> {
  id: string;
  slug: string | null;
  /** When this language went live. Null for a draft read in preview. */
  publishedAt: string | null;
  data: T;
  /** Fields that came from another language. */
  fallbacks: FieldFallback[];
  /** The language this page was read in (lowercase). Differs from the one asked for when `isFallback` is true. */
  locale: string;
  /** The page is not live in the language asked for; this is the next language of the chain. */
  isFallback: boolean;
  /** Read from the draft (preview), not from what is published. */
  draft: boolean;
}

/** Rich text as Lefine stores it (Lexical JSON). Render it with your own renderer; the node set is closed (see ./richtext.ts). */
export interface LefineRichText {
  root: RichTextNode & { type: "root"; children: RichTextNode[] };
}

export interface RichTextNode {
  type: string;
  children?: RichTextNode[];
  text?: string;
  [key: string]: unknown;
}

/**
 * Content type slug to the shape of a page's data. `lefine content types` generates one (`LefineContent`); without it every page's
 * data is a plain record. Any interface fits: the client's type parameter is `M extends object`.
 */
export type ContentModels = Record<string, Record<string, unknown>>;

/** One ops API error, from preview. `code` is the server's (UNAUTHORIZED, FORBIDDEN, MODULE_OFF, ...). */
export class ContentPreviewError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ContentPreviewError";
  }
}

/** The edge could not be read and there is no earlier copy to serve. */
export class ContentFetchError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "ContentFetchError";
  }
}

/** A file's bytes do not match the SHA-256 in the manifest. It is not cached and not served. */
export class ContentIntegrityError extends Error {
  constructor(readonly url: string) {
    super(
      `The content file ${url} does not match its checksum in the manifest`,
    );
    this.name = "ContentIntegrityError";
  }
}
