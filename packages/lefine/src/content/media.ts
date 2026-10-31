/**
 * `lefine/content/media`: the URL of a library file from its media id (an upload field holds only `med_...`). The edge serves
 * it at {cdn}/{workspaceId}/{projectId}/media/{mediaId}/{variant}, kept an hour by browsers and
 * the edge (a recrop can change it). Its own entry, so lefine/content stays small for sites that show no images.
 *
 *   const src = mediaUrl(lefineContent, page.data.cover, "large");
 *   <RichText data={page.data.body} uploadToSrc={(n) => mediaUrl(lefineContent, n.value)} />
 */
import { DEFAULT_CDN_URL } from "./client.js";

/** The sizes Lefine keeps of an image. A file that is not an image has only "original". */
export const MEDIA_VARIANTS = ["original", "thumbnail", "medium", "large"] as const;
export type MediaVariant = (typeof MEDIA_VARIANTS)[number];

/** `project`: the same ids (and cdnUrl) as createContentClient's config. Throws on anything that is not a media id or a size. */
export function mediaUrl(project: { workspaceId: string; projectId: string; cdnUrl?: string }, mediaId: string, variant: MediaVariant = "original"): string {
  // Only an id and a size go in the path.
  if (!/^med_[\w-]+$/.test(mediaId) || !MEDIA_VARIANTS.includes(variant)) throw new Error(`[lefine/content] not a media id and size: ${mediaId} ${variant}`);
  return `${(project.cdnUrl ?? DEFAULT_CDN_URL).replace(/\/+$/, "")}/${project.workspaceId}/${project.projectId}/media/${mediaId}/${variant}`;
}
