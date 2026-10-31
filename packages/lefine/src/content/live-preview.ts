/**
 * `lefine/content/live-preview`: the page side of Lefine's live preview.
 * Adapted from Payload's live-preview (payloadcms/payload@09dab7ea68 packages/live-preview/src/ready.ts, isDocumentEvent.ts; MIT,
 * Copyright (c) 2018-2026 Payload CMS, LLC). Lefine's editor shows your page in a frame. The page says it is ready; the editor says
 * when the document was saved; the page reads its draft again (with a preview client). No content crosses the frame, and a
 * message from any other origin than the editor's is ignored.
 */

/** Message types; the editor sends and expects exactly these strings. */
export const LIVE_PREVIEW_READY = "lefine-live-preview";
export const LIVE_PREVIEW_SAVED = "lefine-document-event";
/** The editor's origin. Pass yours for a self-hosted or local Lefine. */
export const DEFAULT_EDITOR_ORIGIN = "https://dash.lefine.ai";

/** What the editor says after a save (autosave included). */
export interface DocumentSaved {
  type: typeof LIVE_PREVIEW_SAVED;
  /** The content type's slug. */
  collection: string;
  entryId: string;
  versionNo: number;
  locale: string;
  global: boolean;
}

/** True for a saved event from `editorOrigin`, never from anyone else. */
export function isDocumentSaved(event: { origin: string; data: unknown }, editorOrigin = DEFAULT_EDITOR_ORIGIN): event is { origin: string; data: DocumentSaved } {
  const d = event.data as Partial<DocumentSaved> | null;
  return event.origin === editorOrigin && typeof d === "object" && d !== null && d.type === LIVE_PREVIEW_SAVED && typeof d.entryId === "string";
}

/** Tells the editor this page listens. Does nothing outside a frame or popup. */
export function ready(editorOrigin = DEFAULT_EDITOR_ORIGIN): void {
  if (typeof window === "undefined") return;
  const parent: Window | null = (window.opener as Window | null) ?? (window.parent !== window ? window.parent : null);
  parent?.postMessage({ type: LIVE_PREVIEW_READY, ready: true }, editorOrigin);
}

/**
 * Calls `onSaved` each time the editor saved the document, and tells the editor the page is ready. Returns the unsubscribe.
 * In the callback, read the draft again: `router.refresh()` in Next.js, or your preview client's get().
 */
export function onDocumentSaved(onSaved: (event: DocumentSaved) => void, editorOrigin = DEFAULT_EDITOR_ORIGIN): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (event: MessageEvent) => {
    if (isDocumentSaved(event, editorOrigin)) onSaved(event.data);
  };
  window.addEventListener("message", listener);
  ready(editorOrigin);
  return () => window.removeEventListener("message", listener);
}
