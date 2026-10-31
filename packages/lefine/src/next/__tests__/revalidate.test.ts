import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const revalidateTag = vi.fn();
vi.mock("next/cache", () => ({ revalidateTag }));
const { revalidate, TAG } = await import("../revalidate.js");

const SECRET = "whsec_test";
const NOW = 1_800_000_000_000;
const body = JSON.stringify({ event: "strings.release.published", data: { app: { id: "app_web1" } } });
const signed = (t: number, payload = body, secret = SECRET) => `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${payload}`).digest("hex")}`;
const call = (headers: Record<string, string>, payload = body) =>
  revalidate(new Request("https://acme.test/api/lefine", { method: "POST", body: payload, headers }), NOW);

beforeEach(() => {
  process.env.LEFINE_WEBHOOK_SECRET = SECRET;
  revalidateTag.mockClear();
});
afterEach(() => {
  delete process.env.LEFINE_WEBHOOK_SECRET;
});

describe("revalidate (the publish webhook)", () => {
  it("a signed strings.release.published expires the strings tag at once", async () => {
    const res = await call({ "x-lefine-signature": signed(NOW / 1000), "x-lefine-event": "strings.release.published" });
    expect(res.status).toBe(200);
    expect(revalidateTag).toHaveBeenCalledWith(TAG, { expire: 0 });
  });

  it("a wrong, old or missing signature is 401 and changes nothing", async () => {
    const event = { "x-lefine-event": "strings.release.published" };
    expect((await call({ ...event, "x-lefine-signature": signed(NOW / 1000, body, "other") })).status).toBe(401);
    expect((await call({ ...event, "x-lefine-signature": signed(NOW / 1000 - 301) })).status).toBe(401);
    expect((await call({ ...event, "x-lefine-signature": signed(NOW / 1000) }, body + " "))).toMatchObject({ status: 401 });
    expect((await call(event)).status).toBe(401);
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("another event is acknowledged and ignored", async () => {
    const res = await call({ "x-lefine-signature": signed(NOW / 1000), "x-lefine-event": "content.page.published" });
    expect(await res.json()).toEqual({ ignored: true });
    expect(revalidateTag).not.toHaveBeenCalled();
  });

  it("without LEFINE_WEBHOOK_SECRET it says what to set", async () => {
    delete process.env.LEFINE_WEBHOOK_SECRET;
    const res = await call({});
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toContain("LEFINE_WEBHOOK_SECRET");
  });
});
