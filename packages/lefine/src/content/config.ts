/**
 * `lefine/content/config`: content types kept in your repo, pushed with `npx lefine content push`.
 *
 *   // lefine.config.ts
 *   import { defineContent } from "lefine/content/config";
 *   export default defineContent({
 *     project: "prj_...",
 *     types: [{ slug: "posts", labels: { singular: "Post" }, useAsTitle: "title", fields: [{ type: "text", name: "title", localized: true }] }],
 *   });
 *
 * The push shows what would change first (each field change as safe, breaking or destructive, with the pages it touches) and
 * changes nothing until you say yes. A breaking or destructive change also waits for a person in Lefine. A type that is in
 * Lefine and not in the file is left alone: the push never deletes.
 */

/** A field as Lefine's content model has it (`lefine content types` and the dashboard use the same shape). */
export interface ContentFieldConfig {
  type: string;
  name?: string;
  [option: string]: unknown;
}

export interface ContentTypeConfig {
  /** The type's web address in Lefine; it never changes once pushed. */
  slug: string;
  /** "collection" (many pages, the default) or "global" (one document, like the footer). Fixed once pushed. */
  kind?: "collection" | "global";
  labels: { singular: string; plural?: string };
  /** The field lists show as each page's title (a short text field). */
  useAsTitle?: string;
  fields: ContentFieldConfig[];
}

export interface ContentConfig {
  /** `prj_...` or the project's slug. Without it: the workspace's only project, or `--project`. */
  project?: string;
  types: ContentTypeConfig[];
}

/** Types the config; returns it unchanged. */
export function defineContent(config: ContentConfig): ContentConfig {
  return config;
}
