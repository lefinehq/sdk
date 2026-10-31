"use client";
/**
 * `lefine/content/live-preview/react`: `<RefreshOnSave refresh={router.refresh} />` on a draft page makes it follow Lefine's
 * editor (Payload's RefreshRouteOnSave, payloadcms/payload@09dab7ea68 packages/live-preview-react, MIT). It tells the editor the
 * page is ready and calls `refresh` after each save. Renders nothing. A client component: its own entry, so lefine/content/react
 * stays usable in server components.
 */
import { useEffect, useRef } from "react";
import { type DocumentSaved, onDocumentSaved } from "./live-preview.js";

export function RefreshOnSave({ refresh, editorOrigin, onSaved }: { refresh: () => void; editorOrigin?: string; onSaved?: (event: DocumentSaved) => void }) {
  // The latest callbacks, without subscribing again on every render.
  const latest = useRef({ refresh, onSaved });
  useEffect(() => {
    latest.current = { refresh, onSaved };
  });
  useEffect(
    () =>
      onDocumentSaved((event) => {
        latest.current.onSaved?.(event);
        latest.current.refresh();
      }, editorOrigin),
    [editorOrigin],
  );
  return null;
}
