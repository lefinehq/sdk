import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { createElement as h } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StringsProvider, useStrings } from "../../react/index.js";
import { createStrings } from "../index.js";

const V = "mh3k2lc0-a1b2c3d4";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const TEXTS: Record<string, string> = {
  en: JSON.stringify({ nav: { pricing: "Pricing", items: "{n, plural, one {# item} other {# items}}" }, admin: { secret: "x" } }),
  tr: JSON.stringify({ nav: { pricing: "Fiyatlar", items: "{n} öğe" }, admin: { secret: "x" } }),
};

let n = 0;
/** The app id the last edge() serves. */
const currentApp = () => `app_${String(n).padStart(32, "0")}`;
function edge() {
  const app = `app_${String(++n).padStart(32, "0")}`;
  const seen: string[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(String(input)).pathname;
    seen.push(path);
    if (path === `/${app}/manifest.json`) {
      const files = Object.fromEntries(Object.entries(TEXTS).map(([lc, body]) => [lc, { version: V, sha256: sha(body), keyCount: 3 }]));
      return Response.json({
        schema: 2,
        revision: 1,
        languages: [
          { code: "tr", name: "Turkish", nativeName: "Türkçe", flagUrl: "https://cdn.test/flags/tr.svg" },
          { code: "en", name: "English", nativeName: "English", isSource: true },
        ],
        files,
      });
    }
    const m = /\/v\/[^/]+\/([^/]+)\/translations\.json$/.exec(path);
    return m ? new Response(TEXTS[m[1]!]) : new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { strings: createStrings({ project: app, cdn: "https://cdn.test" }), seen };
}

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("lefine/server: strings for any React SSR app (TanStack Start first)", () => {
  it("getStrings on the server, as in a loader or server function", async () => {
    const { strings } = edge();
    const t = await strings.getStrings("tr", "nav");
    expect(t("pricing")).toBe("Fiyatlar");
    expect(t("items", { n: 3 })).toBe("3 öğe");
  });

  it("load gives plain JSON for a route loader: only the named namespaces; StringsProvider renders it on server and client alike", async () => {
    const { strings } = edge();
    const props = await strings.load("en", ["nav"]);
    expect(Object.keys(props.messages)).toEqual(["nav"]);
    // A route loader serializes what it returns (TanStack Start uses seroval); JSON is the strictest case.
    const sent = JSON.parse(JSON.stringify(props)) as typeof props;
    function Nav() {
      const t = useStrings("nav");
      return h("p", null, t("pricing"), " · ", t("items", { n: 1 }));
    }
    const render = (p: typeof props) => renderToString(h(StringsProvider, p, h(Nav)));
    expect(render(sent)).toBe(render(props));
    expect(render(sent)).toContain("Pricing");
    expect(render(sent)).toContain("1 item");
  });

  it("in development, load says where the manifest is and the revision it rendered, for the 'strings updated' toast", async () => {
    const { strings } = edge();
    expect((await strings.load("en", ["nav"])).live).toEqual({ base: `https://cdn.test/${currentApp()}`, revision: 1 });
  });

  it("keeps the manifest 60 s like the edge: a second render does not ask again", async () => {
    const { strings, seen } = edge();
    await strings.getStrings("en");
    await strings.getStrings("en");
    expect(seen.filter((p) => p.endsWith("manifest.json"))).toHaveLength(1);
  });

  it("texts gives the source texts of the named namespaces as published, braces as written (for copy read as data)", async () => {
    const { strings } = edge();
    expect(await strings.texts("en", ["nav", "missing"])).toEqual({ nav: { pricing: "Pricing", items: "{n, plural, one {# item} other {# items}}" } });
  });

  it("languages lists the published languages, source first, with names and flag", async () => {
    const { strings } = edge();
    expect(await strings.languages()).toEqual([
      { code: "en", name: "English", nativeName: "English", flagUrl: null, isSource: true },
      { code: "tr", name: "Turkish", nativeName: "Türkçe", flagUrl: "https://cdn.test/flags/tr.svg", isSource: false },
    ]);
  });

  it("an unknown locale says it is not published", async () => {
    const { strings } = edge();
    await expect(strings.getStrings("fr")).rejects.toThrow("fr is not published");
  });

  it("imports nothing from Next or React, so a Vue, Svelte or Hono app can use it (framework-support.md)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lefine-server-bundle-"));
    try {
      const entry = join(dir, "entry.ts");
      writeFileSync(entry, `import { createStrings } from ${JSON.stringify(fileURLToPath(new URL("../index.ts", import.meta.url)))};\nglobalThis.x = createStrings;\n`);
      const code = execFileSync("bun", ["build", entry, "--target=node", "--format=esm", "--external", "react"], { encoding: "utf-8" });
      expect(code).not.toMatch(/["']next\//);
      // Until 2026-10-27 it imported react (t.rich keys) and failed to load in a Vue app without React.
      expect(code).not.toMatch(/from ["']react["']/);
      // On a device (React Native) or in a browser it ships whole, compiler included: budget 9 KB gzip (about 7.6 KB with
      // the device storage, 2026-10-27; 8.5 KB with the synchronous SHA-256 that Cache Components need, 2026-10-28).
      const min = execFileSync("bun", ["build", entry, "--minify", "--target=browser", "--format=esm"], { encoding: "utf-8" });
      const gz = gzipSync(min).length;
      console.log(`lefine/server (device or browser): ${gz} B gzip`);
      expect(gz).toBeLessThan(9216);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("a build-time snapshot (createSnapshot, createStrings({ snapshot }))", () => {
  it("the first request after a deploy is served from the snapshot without waiting for the edge, which is asked in the background", async () => {
    const { createSnapshot } = await import("../index.js");
    edge();
    const snap = await createSnapshot({ project: currentApp(), cdn: "https://cdn.test" });
    expect(Object.keys(snap).sort()).toEqual([`lefine:${currentApp()}:en`, `lefine:${currentApp()}:manifest`, `lefine:${currentApp()}:tr`]);
    // The edge goes away: a new process with the snapshot still renders, at once.
    globalThis.fetch = vi.fn(async () => {
      throw new Error("offline");
    }) as typeof fetch;
    const strings = createStrings({ project: currentApp(), cdn: "https://cdn.test", snapshot: snap });
    const t = await strings.getStrings("tr", "nav");
    expect(t("pricing")).toBe("Fiyatlar");
  });
});
