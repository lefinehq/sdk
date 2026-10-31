import { revalidateTag } from "next/cache";

export const TAG = "lefine-strings";
const TOLERANCE_S = 300;

const enc = new TextEncoder();

async function sign(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(payload)));
  return Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
}

function same(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * The publish webhook: `export const POST = lefine.revalidate` in app/api/lefine/route.ts, and that URL as a
 * webhook in Lefine. Checks X-Lefine-Signature (`t=<unix>,v1=<hmac-sha256 of "t.body">`, Lefine's scheme) with
 * LEFINE_WEBHOOK_SECRET, then expires the strings cache tag, so the next request reads the new release.
 */
export async function revalidate(request: Request, now = Date.now()): Promise<Response> {
  const secret = process.env.LEFINE_WEBHOOK_SECRET;
  if (!secret) {
    return Response.json({ error: "Set LEFINE_WEBHOOK_SECRET to the signing secret Lefine showed when you added this webhook." }, { status: 500 });
  }
  const body = await request.text();
  const header = request.headers.get("x-lefine-signature") ?? "";
  const t = /(?:^|,)t=(\d+)/.exec(header)?.[1];
  const v1 = /(?:^|,)v1=([0-9a-f]{64})/.exec(header)?.[1];
  if (!t || !v1 || Math.abs(now / 1000 - Number(t)) > TOLERANCE_S || !same(v1, await sign(secret, `${t}.${body}`))) {
    return Response.json({ error: "bad signature" }, { status: 401 });
  }
  if (request.headers.get("x-lefine-event") !== "strings.release.published") return Response.json({ ignored: true });
  // Next 16 takes a profile; expire: 0 means the next request waits for fresh texts instead of getting stale ones.
  (revalidateTag as (tag: string, profile?: { expire: number }) => void)(TAG, { expire: 0 });
  return Response.json({ revalidated: true });
}
