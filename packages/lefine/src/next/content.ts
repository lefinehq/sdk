// lefine/next content: a Lefine Content client for the Next.js App Router, and the draft mode routes. Server only.
//
// The published client reads the edge through Next's cache (createNextFetch, unstable_cache: works with and without Cache
// Components) under CONTENT_TAG; the publish webhook (revalidate) expires that tag on content.entry.published and
// content.entry.unpublished, so a publish shows without a deploy. Draft mode (Next's draftMode()) switches to the preview
// client, which reads drafts with a secret key and is never cached.

import { draftMode } from "next/headers";
import { redirect } from "next/navigation";
import { createContentClient, type ContentClient, type ContentClientConfig } from "../content/client.js";
import type { PreviewOptions } from "../content/preview.js";
import type { ContentModels } from "../content/types.js";
import { createNextFetch } from "./fetch.js";
import { CONTENT_TAG } from "./revalidate.js";

export { CONTENT_TAG };

const contentFetch = createNextFetch(CONTENT_TAG, "lefine-content-edge");

/** The published client under Next's cache. Keep it at module level, as with createContentClient. */
export function createNextContentClient<M extends object = ContentModels>(
  config: Omit<ContentClientConfig, "fetch" | "fetchInit" | "preview">,
): ContentClient<M> {
  // manifestTtlMs 0: the loader's own copy must not outlive a publish webhook (Next's cache is the one copy, as for strings).
  return createContentClient<M>({ manifestTtlMs: 0, ...config, fetch: (input, init) => contentFetch(input, init) });
}

export interface NextContentConfig extends Omit<ContentClientConfig, "fetch" | "fetchInit" | "preview"> {
  /** A Lefine key (`lfn_...`) with `content:read`, for draft mode. Without it, draft mode reads what is published. */
  preview?: PreviewOptions;
  /** The secret the enable route checks (?secret=). Default process.env.LEFINE_PREVIEW_SECRET. */
  previewSecret?: string;
}

const same = (a: string, b: string): boolean => {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
};

/** Only a path on this site: "/x" yes; "//evil.test", "https://..." and "/\evil" no. */
// Same-origin path only. Control characters and backslashes are refused first: browsers strip
// tab/newline, so "/\t/evil.com" would otherwise become the protocol-relative "//evil.com".
const safePath = (value: string | null, base: string): string => {
  if (!value || /[\u0000-\u001F\u007F\\]/.test(value) || !/^\/(?!\/)/.test(value)) return "/";
  const target = new URL(value, base);
  return target.origin === new URL(base).origin ? target.pathname + target.search + target.hash : "/";
};

/**
 * `const content = createNextContent({...})`:
 *  - `content.get()`: in draft mode the preview client, else the published one. `await content.get()` in a Server Component.
 *  - `content.published`: the published client, whatever the mode.
 *  - `content.draft.enable` / `content.draft.disable`: GET handlers for app/api/lefine/draft/route.ts (enable) and
 *    app/api/lefine/draft/disable/route.ts. Enable needs `?secret=` and sends the editor to `?redirect=` (a path on this site).
 */
export function createNextContent<M extends object = ContentModels>(config: NextContentConfig) {
  const { preview, previewSecret, ...rest } = config;
  const published = createNextContentClient<M>(rest);
  const drafts = preview ? createContentClient<M>({ ...rest, preview }) : null;

  return {
    published,

    async get(): Promise<ContentClient<M>> {
      if (!drafts) return published;
      return (await draftMode()).isEnabled ? drafts : published;
    },

    draft: {
      async enable(request: Request): Promise<Response> {
        const expected = previewSecret ?? process.env.LEFINE_PREVIEW_SECRET;
        if (!expected) {
          return Response.json({ error: "Set LEFINE_PREVIEW_SECRET (or previewSecret) to a long random string, and use it as ?secret= in the preview URL." }, { status: 500 });
        }
        const url = new URL(request.url);
        if (!same(url.searchParams.get("secret") ?? "", expected)) return Response.json({ error: "bad secret" }, { status: 401 });
        (await draftMode()).enable();
        redirect(safePath(url.searchParams.get("redirect"), request.url));
      },

      async disable(request: Request): Promise<Response> {
        (await draftMode()).disable();
        redirect(safePath(new URL(request.url).searchParams.get("redirect"), request.url));
      },
    },
  };
}
