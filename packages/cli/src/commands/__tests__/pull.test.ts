import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pullCommand } from "../pull.js";

const realFetch = globalThis.fetch;
const realExit = process.exit;
const realLog = console.log;
let dir: string;
let logs: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pull-test-"));
  logs = [];
  console.log = (...a: unknown[]) => {
    logs.push(a.join(" "));
  };
  // pull exits the process on failure; turn that into a throw the test can read.
  process.exit = ((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as typeof process.exit;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.exit = realExit;
  console.log = realLog;
  rmSync(dir, { recursive: true, force: true });
});

const BODY = JSON.stringify({ common: { hello: "Hello", bye: "Bye" } });
const SHA = createHash("sha256").update(BODY).digest("hex");

function edge(manifest: Record<string, unknown>, files: Record<string, string>) {
  const urls: string[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith("/manifest.json")) return Promise.resolve(new Response(JSON.stringify(manifest)));
    if (url.endsWith("/changes.json")) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            revision: 4,
            version: "aaaaaa02-aaaa",
            previousVersion: "aaaaaa01-aaaa",
            publishedAt: "2026-10-22T10:00:00.000Z",
            locales: {
              en: { added: 1, changed: 0, removed: 0, keys: { added: [["common", "bye"]], changed: [], removed: [] }, truncated: false },
            },
          }),
        ),
      );
    }
    for (const [suffix, body] of Object.entries(files)) {
      if (url.endsWith(suffix)) return Promise.resolve(new Response(body));
    }
    return Promise.resolve(new Response("nope", { status: 404 }));
  }) as typeof fetch;
  return urls;
}

const run = (extra: Record<string, unknown> = {}) =>
  pullCommand({ project: "org/proj", output: dir, dir, ...extra } as Parameters<typeof pullCommand>[0]);

describe("pull", () => {
  it("fails a locale whose file has 0 keys while the manifest counts keys, and writes nothing", async () => {
    edge(
      { languages: [{ code: "en", keyCount: 2 }], files: { en: { url: "https://cdn.better-i18n.com/org/proj/en/translations.json" } } },
      { "/en/translations.json": "{}" },
    );
    await expect(run()).rejects.toThrow("exit:1");
    expect(existsSync(join(dir, "en.json"))).toBe(false);
  });

  it("schema 2: per-file keyCount decides, not the language row", async () => {
    edge(
      {
        schema: 2,
        revision: 4,
        languages: [{ code: "en", keyCount: 0 }],
        files: { en: { url: "x", version: "aaaaaa02-aaaa", sha256: SHA, keyCount: 5 } },
      },
      { "/v/aaaaaa02-aaaa/en/translations.json": BODY },
    );
    await expect(run()).rejects.toThrow("exit:1");
    expect(existsSync(join(dir, "en.json"))).toBe(false);
  });

  it("schema 2 happy path: snapshot URL, verified bytes written", async () => {
    const urls = edge(
      {
        schema: 2,
        revision: 4,
        languages: [{ code: "en", keyCount: 2 }],
        files: { en: { url: "x", version: "aaaaaa02-aaaa", sha256: SHA, keyCount: 2 } },
      },
      { "/v/aaaaaa02-aaaa/en/translations.json": BODY },
    );
    await run();
    expect(urls.some((u) => u.endsWith("/v/aaaaaa02-aaaa/en/translations.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "en.json"), "utf-8"))).toEqual(JSON.parse(BODY));
  });

  it("schema 2: a second pull downloads only the locales whose sha256 changed; --force downloads all", async () => {
    const BODY_DE = JSON.stringify({ common: { hello: "Hallo" } });
    const SHA_DE = createHash("sha256").update(BODY_DE).digest("hex");
    const manifest = (version: string, enSha: string) => ({
      schema: 2,
      revision: 4,
      languages: [{ code: "en", keyCount: 2 }, { code: "de", keyCount: 1 }],
      files: {
        en: { url: "x", version, sha256: enSha, keyCount: 2 },
        de: { url: "x", version: "aaaaaa01-aaaa", sha256: SHA_DE, keyCount: 1 },
      },
    });
    const files = { "/v/aaaaaa01-aaaa/en/translations.json": BODY, "/v/aaaaaa01-aaaa/de/translations.json": BODY_DE };

    let urls = edge(manifest("aaaaaa01-aaaa", SHA), files);
    await run();
    expect(urls.filter((u) => u.endsWith("translations.json"))).toHaveLength(2);

    // Nothing changed: nothing is downloaded.
    urls = edge(manifest("aaaaaa01-aaaa", SHA), files);
    await run();
    expect(urls.filter((u) => u.endsWith("translations.json"))).toHaveLength(0);
    expect(logs.join("\n")).toContain("unchanged");

    // en changes: only en is downloaded.
    const BODY2 = JSON.stringify({ common: { hello: "Hello!", bye: "Bye" } });
    const SHA2 = createHash("sha256").update(BODY2).digest("hex");
    urls = edge(manifest("aaaaaa02-aaaa", SHA2), { ...files, "/v/aaaaaa02-aaaa/en/translations.json": BODY2 });
    await run();
    expect(urls.filter((u) => u.endsWith("translations.json"))).toEqual([expect.stringContaining("/v/aaaaaa02-aaaa/en/")]);
    expect(JSON.parse(readFileSync(join(dir, "en.json"), "utf-8"))).toEqual(JSON.parse(BODY2));

    // A missing file is fetched again, and --force fetches everything.
    rmSync(join(dir, "de.json"));
    urls = edge(manifest("aaaaaa02-aaaa", SHA2), { ...files, "/v/aaaaaa02-aaaa/en/translations.json": BODY2 });
    await run();
    expect(urls.filter((u) => u.endsWith("translations.json"))).toHaveLength(1);
    urls = edge(manifest("aaaaaa02-aaaa", SHA2), { ...files, "/v/aaaaaa02-aaaa/en/translations.json": BODY2 });
    await run({ force: true });
    expect(urls.filter((u) => u.endsWith("translations.json"))).toHaveLength(2);
  });

  it("--since lists the change before downloading", async () => {
    edge(
      {
        schema: 2,
        revision: 4,
        changesUrl: "https://cdn.better-i18n.com/org/proj/v/aaaaaa02-aaaa/changes.json",
        languages: [{ code: "en", keyCount: 2 }],
        files: { en: { url: "x", version: "aaaaaa02-aaaa", sha256: SHA, keyCount: 2 } },
      },
      { "/v/aaaaaa02-aaaa/en/translations.json": BODY },
    );
    await run({ since: "3" });
    const out = logs.join("\n");
    expect(out).toContain("Changes since revision 3 (now 4):");
    expect(out).toContain("+ common:bye");
    expect(existsSync(join(dir, "en.json"))).toBe(true);
  });

  it("--cdn-url points pull at another CDN origin", async () => {
    const urls = edge(
      { languages: [{ code: "en", keyCount: 2 }], files: {} },
      { "/en/translations.json": BODY },
    );
    await run({ cdnUrl: "http://localhost:8788/" });
    expect(urls[0]).toBe("http://localhost:8788/org/proj/manifest.json");
    expect(urls[1]).toBe("http://localhost:8788/org/proj/en/translations.json");
  });

  it("--since with a bad value stops before downloading", async () => {
    edge({ schema: 2, revision: 4, languages: [{ code: "en", keyCount: 2 }], files: {} }, {});
    await expect(run({ since: "abc" })).rejects.toThrow("exit:1");
    expect(existsSync(join(dir, "en.json"))).toBe(false);
  });
});
