// How lefine/next reads the edge: through Next's cache with unstable_cache, not fetch's `next` options. Cache
// Components (on in create-next-app 16.4) ignore fetch's cache options, so a `next: { revalidate }` fetch is
// "uncached data" and `next build` stops ("encountered uncached or runtime data during prerendering"). Next 16 keeps
// unstable_cache working with and without Cache Components (docs: migrating-to-cache-components, "unstable_cache:
// no change required"), and revalidateTag(TAG) empties it, so the publish webhook still works.
//
// A versioned file never changes, so a 200 is kept until a webhook; the manifest, and any answer that is not a 200,
// for 60 s (the edge's own max-age). The body is kept as text: the loader checks its sha256.

import { unstable_cache } from "next/cache";
import { TAG } from "./revalidate.js";

interface Got {
  status: number;
  body: string;
  type: string | null;
  etag: string | null;
}

const VERSIONED = /\/v\/[a-z0-9]{6,12}-[a-z0-9]{4,12}\//;

const get = async (url: string): Promise<Got> => {
  const res = await fetch(url);
  return { status: res.status, body: await res.text(), type: res.headers.get("content-type"), etag: res.headers.get("etag") };
};

class NotOk extends Error {
  constructor(readonly got: Got) {
    super(`HTTP ${got.status}`);
  }
}

// A thrown error is not cached, so a versioned file that is not there yet is asked again (through `minute`).
const forever = unstable_cache(
  async (url: string) => {
    const got = await get(url);
    if (got.status !== 200) throw new NotOk(got);
    return got;
  },
  ["lefine-edge-file"],
  { tags: [TAG], revalidate: false },
);
const minute = unstable_cache(get, ["lefine-edge"], { tags: [TAG], revalidate: 60 });

async function cached(url: string): Promise<Got> {
  if (!VERSIONED.test(url)) return minute(url);
  try {
    return await forever(url);
  } catch (err) {
    if (err instanceof NotOk) return minute(url);
    throw err;
  }
}

/** The loader's fetch under Next. Headers (If-None-Match) are not sent: the cache answers with the whole body. */
export const nextFetch: typeof fetch = (input, init) => {
  const url = input instanceof Request ? input.url : String(input);
  const answer = cached(url).then(
    (got) => new Response(got.body, { status: got.status, headers: { ...(got.type ? { "content-type": got.type } : {}), ...(got.etag ? { etag: got.etag } : {}) } }),
  );
  // The loader's timeout still ends a call that waits too long, even though the cached read cannot be cancelled.
  const signal = init?.signal;
  if (!signal) return answer;
  if (signal.aborted) return Promise.reject(signal.reason);
  return Promise.race([answer, new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))]);
};
