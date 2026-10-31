/**
 * A local stand-in for the Lefine edge's Content routes (the CDN paths lefine/content reads), serving the fixture folder:
 * the same URL shapes, a lowercase locale, ETag + 304, a 404 JSON for anything missing. Records every request.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const FIXTURE_ROOT = fileURLToPath(
  new URL("./fixtures/edge", import.meta.url),
);
export const CDN = "https://cdn.test";
export const PROJECT = {
  workspaceId: "ws_acme",
  projectId: "prj_site",
} as const;

const MANIFEST = /^\/(ws_[a-z0-9_-]+)\/(prj_[a-z0-9_-]+)\/c\/manifest\.json$/;
const FILE =
  /^\/(ws_[a-z0-9_-]+)\/(prj_[a-z0-9_-]+)\/c\/v\/([a-z0-9]{6,12}-[a-z0-9]{4,12})\/([^/]+)\/([a-z0-9]+(?:-[a-z0-9]+)*\.json)$/;

export interface FakeEdge {
  fetch: (input: string, init?: RequestInit) => Promise<Response>;
  requests: Array<{
    path: string;
    ifNoneMatch: string | null;
    init?: RequestInit;
  }>;
  /** Replace the bytes of one path (tamper, or a newer manifest). */
  override: Map<string, string>;
  down: boolean;
}

export function createFakeEdge(): FakeEdge {
  const edge: FakeEdge = {
    requests: [],
    override: new Map(),
    down: false,
    async fetch(input, init) {
      const url = new URL(input);
      const headers = new Headers(init?.headers);
      edge.requests.push({
        path: url.pathname,
        ifNoneMatch: headers.get("if-none-match"),
        init,
      });
      if (edge.down) throw new TypeError("fetch failed");
      if (url.origin !== CDN) return notFound();
      let path: string | null = null;
      if (MANIFEST.test(url.pathname)) path = url.pathname;
      const file = FILE.exec(url.pathname);
      if (file)
        path = `/${file[1]}/${file[2]}/c/v/${file[3]}/${file[4]!.toLowerCase()}/${file[5]}`;
      if (!path) return notFound();
      const onDisk = join(FIXTURE_ROOT, path);
      const body =
        edge.override.get(path) ??
        (existsSync(onDisk) ? readFileSync(onDisk, "utf-8") : null);
      if (body === null)
        return notFound(MANIFEST.test(path) ? "not_published" : "not_found");
      const etag = `"${createHash("md5").update(body).digest("hex")}"`;
      const common = {
        "Content-Type": "application/json; charset=utf-8",
        ETag: etag,
      };
      if (headers.get("if-none-match") === etag)
        return new Response(null, { status: 304, headers: common });
      return new Response(body, { status: 200, headers: common });
    },
  };
  return edge;
}

function notFound(error = "not_found"): Response {
  return new Response(JSON.stringify({ error }), {
    status: 404,
    headers: { "Content-Type": "application/json" },
  });
}

export function readFixture(path: string): string {
  return readFileSync(join(FIXTURE_ROOT, path), "utf-8");
}
