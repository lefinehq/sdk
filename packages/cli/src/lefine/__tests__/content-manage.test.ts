import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentPageCommand, contentPagesCommand, contentProjectsCommand, contentPublishCommand, parseWhere } from "../content-manage.js";

const realFetch = globalThis.fetch;
const realExit = process.exit;
const realLog = console.log;
const realErr = console.error;
const realStdinTty = process.stdin.isTTY;
let dir: string;
let logs: string[];
let calls: Array<{ name: string; input: any; approval?: string }>;
let approvalAnswers: string[];
let handlers: Record<string, (input: any) => unknown>;

const TOKEN = "lfn_test_token_value";
const APPROVAL = { id: "apr_7", url: "https://dash.lefine.ai/approvals/apr_7", expiresAt: "2026-10-30T10:30:00.000Z" };
const PROJECT = { id: "prj_site", slug: "site", name: "Site", sourceLocale: "en", targetLocales: ["de", "pt-BR"], fallbackLocale: "en", collectionCount: 1, entryCount: 2 };
const TYPES = [{ id: "col_posts", slug: "posts", kind: "collection", labels: { singular: "Post", plural: "Posts" }, entryCount: 2 }];
const PAGE = {
  id: "ent_hello",
  collectionId: "col_posts",
  slug: "hello",
  title: "Hello",
  headVersionNo: 4,
  updatedAt: "2026-10-30T08:00:00.000Z",
  locales: [
    { locale: "en", status: "published", publishedVersionNo: 3 },
    { locale: "de", status: "changed", publishedVersionNo: 2 },
    { locale: "pt-BR", status: "not-published", publishedVersionNo: null },
  ],
  schemaVersion: 1,
  data: { title: { en: "Hello", de: "Hallo" } },
  fallbacks: {},
};

/** Fake API: /v1/ops/:name answered by `handlers`; a publish asks first, as on the server. */
function server() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/v1/approvals/")) return Response.json({ ok: true, data: { status: approvalAnswers.shift() ?? "pending" } });
    const name = url.split("/v1/ops/")[1]!;
    const body = JSON.parse(String(init?.body));
    calls.push({ name, input: body.input, ...(body.approval ? { approval: body.approval } : {}) });
    if (name === "content.entries.publish" && body.approval !== APPROVAL.id) {
      return Response.json({ ok: false, error: { code: "APPROVAL_REQUIRED", message: "ask" }, approval: APPROVAL }, { status: 428 });
    }
    const result = handlers[name]?.(body.input);
    if (result && typeof result === "object" && "error" in result) return Response.json({ ok: false, error: (result as any).error }, { status: 403 });
    return Response.json({ ok: true, data: result });
  }) as typeof fetch;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lefine-content-"));
  process.env.LEFINE_HOME = join(dir, "home");
  process.env.LEFINE_TOKEN = TOKEN;
  process.env.LEFINE_API_URL = "http://api.test";
  logs = [];
  calls = [];
  approvalAnswers = ["approved"];
  handlers = {
    "content.projects.list": () => ({ items: [PROJECT] }),
    "content.collections.list": () => ({ items: TYPES }),
    "content.entries.list": (input) => ({ items: input.offset === 0 ? [PAGE] : [{ ...PAGE, id: "ent_two", title: "Two" }], total: 2 }),
    "content.entries.get": () => PAGE,
    "content.entries.publish": (input) => ({ id: PAGE.id, headVersionNo: 4, locales: input.locales.map((l: string) => ({ locale: l, status: "published", publishedVersionNo: 4 })) }),
  };
  server();
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  console.error = (...a: unknown[]) => void logs.push(a.join(" "));
  process.exit = ((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as typeof process.exit;
  (process.stdin as { isTTY?: boolean }).isTTY = false;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.exit = realExit;
  console.log = realLog;
  console.error = realErr;
  (process.stdin as { isTTY?: boolean }).isTTY = realStdinTty;
  delete process.env.LEFINE_HOME;
  delete process.env.LEFINE_TOKEN;
  delete process.env.LEFINE_API_URL;
  rmSync(dir, { recursive: true, force: true });
});

const noWait = { openBrowser: () => {}, sleep: async () => {} };

describe("lefine content projects", () => {
  it("lists the projects with ids and languages", async () => {
    await contentProjectsCommand({});
    const text = logs.join("\n");
    expect(text).toContain("prj_site");
    expect(text).toContain("en, de, pt-BR");
    expect(text).not.toContain(TOKEN);
  });

  it("a workspace without Content says so in words", async () => {
    handlers["content.projects.list"] = () => ({ error: { code: "MODULE_OFF", message: "off" } });
    await expect(contentProjectsCommand({})).rejects.toThrow("exit:1");
    expect(logs.join("\n")).toContain("does not have Content");
  });
});

describe("lefine content pages", () => {
  it("--type by slug, --missing as the canonical tag, --all reads every page", async () => {
    await contentPagesCommand({ type: "posts", missing: "pt_br", limit: "1", all: true, json: true });
    const lists = calls.filter((c) => c.name === "content.entries.list").map((c) => c.input);
    expect(lists).toEqual([
      { projectId: "prj_site", limit: 1, offset: 0, collectionId: "col_posts", missingLocale: "pt-BR" },
      { projectId: "prj_site", limit: 1, offset: 1, collectionId: "col_posts", missingLocale: "pt-BR" },
    ]);
    const result = JSON.parse(logs.at(-1)!);
    expect(result.items.map((p: { id: string }) => p.id)).toEqual(["ent_hello", "ent_two"]);
    expect(result.total).toBe(2);
  });

  it("each language's state reads without color: de* changed, pt-BR- not live", async () => {
    await contentPagesCommand({});
    expect(logs.join("\n")).toContain("en de* pt-BR-");
  });

  it("an unknown type names the types there are", async () => {
    await expect(contentPagesCommand({ type: "blog" })).rejects.toThrow("exit:1");
    expect(logs.join("\n")).toContain('No content type "blog" in Site. Types: posts.');
  });
});

describe("lefine content page", () => {
  it("prints the page's languages and data", async () => {
    await contentPageCommand("ent_hello", {});
    const text = logs.join("\n");
    expect(text).toContain("Hello");
    expect(text).toContain('"de": "Hallo"');
  });

  it("a page that is not there points at content pages, not at Strings' apps", async () => {
    handlers["content.entries.get"] = () => ({ error: { code: "NOT_FOUND", message: "Page not found" } });
    await expect(contentPageCommand("ent_gone", {})).rejects.toThrow("exit:1");
    const text = logs.join("\n");
    expect(text).toContain("lefine content pages");
    expect(text).not.toContain("whoami");
  });

  it("refuses an id that is not a page id, before any page read", async () => {
    await expect(contentPageCommand("../x", {})).rejects.toThrow("exit:1");
    expect(calls.some((c) => c.name === "content.entries.get")).toBe(false);
  });
});

describe("lefine content publish", () => {
  it("in CI without --yes asks for it and publishes nothing", async () => {
    await expect(contentPublishCommand("ent_hello", {}, noWait)).rejects.toThrow("exit:1");
    expect(logs.join("\n")).toContain("--yes");
    expect(calls.some((c) => c.name === "content.entries.publish")).toBe(false);
  });

  it("waits for the person's approval, then publishes the version shown in every language", async () => {
    await contentPublishCommand("ent_hello", { yes: true }, noWait);
    const publishes = calls.filter((c) => c.name === "content.entries.publish");
    expect(publishes.length).toBe(2);
    expect(publishes[1]!.approval).toBe(APPROVAL.id);
    expect(publishes[1]!.input).toEqual({ projectId: "prj_site", entryId: "ent_hello", locales: ["en", "de", "pt-BR"], expectedVersionNo: 4 });
    const text = logs.join("\n");
    expect(text).toContain(APPROVAL.url);
    expect(text).toContain("Published Hello");
  });

  it("the question shows the page title without escape sequences", async () => {
    handlers["content.entries.get"] = () => ({ ...PAGE, title: "Hi\u001b]0;pwned\u0007" });
    let asked = "";
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    const tty = process.stdout.isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = true;
    try {
      await contentPublishCommand("ent_hello", {}, { ...noWait, ask: async ({ message }) => ((asked = message), false) });
    } finally {
      (process.stdout as { isTTY?: boolean }).isTTY = tty;
    }
    expect(asked).toContain("Publish");
    expect(asked).not.toContain("\u001b");
    expect(asked).not.toContain("\u0007");
  });

  it("--locales takes only the project's languages", async () => {
    await expect(contentPublishCommand("ent_hello", { yes: true, locales: "de,fr" }, noWait)).rejects.toThrow("exit:1");
    expect(logs.join("\n")).toContain("fr: not a language of Site");
    expect(calls.some((c) => c.name === "content.entries.publish")).toBe(false);
  });

  it("a decline publishes nothing and says so", async () => {
    approvalAnswers = ["declined"];
    await expect(contentPublishCommand("ent_hello", { yes: true, locales: "de" }, noWait)).rejects.toThrow("exit:1");
    expect(calls.filter((c) => c.name === "content.entries.publish").length).toBe(1);
    expect(logs.join("\n")).toContain("declined");
  });

  it("nobody answering in time names the rerun with --approval", async () => {
    approvalAnswers = [];
    let t = 0;
    await expect(contentPublishCommand("ent_hello", { yes: true, locales: "de" }, { ...noWait, now: () => (t += 60_000), approvalWaitMs: 1 })).rejects.toThrow("exit:1");
    expect(logs.join("\n")).toContain("lefine content publish ent_hello --locales de --yes --approval apr_7");
  });
});

describe("lefine content pages filters", () => {
  const lastList = () => calls.filter((c) => c.name === "content.entries.list").at(-1)!.input;

  it("--slug, --status, --locale, --sort and --order go to the API as the action's filters", async () => {
    await contentPagesCommand({ slug: "pricing, about", status: "published", locale: "pt_br", sort: "createdAt", order: "asc", json: true });
    expect(lastList()).toEqual({ projectId: "prj_site", limit: 20, offset: 0, slugs: ["pricing", "about"], status: "published", locale: "pt-BR", sort: "createdAt", order: "asc" });
  });

  it("--where field=value is text, field:=json a typed value; with --type they become where", async () => {
    await contentPagesCommand({ type: "posts", where: ["category=guides", "featured:=true", "views:=3", "note=a=b"], json: true });
    expect(lastList()).toMatchObject({ collectionId: "col_posts", where: { category: "guides", featured: true, views: 3, note: "a=b" } });
    expect(parseWhere(["title:=\"Hello\"", "gone:=null"])).toEqual({ title: "Hello", gone: null });
    expect(parseWhere([])).toBeUndefined();
    expect(() => parseWhere(["bad"])).toThrow("field=value");
    expect(() => parseWhere(["x:=[1]"])).toThrow("one value");
    expect(() => parseWhere(["x:=nope"])).toThrow("takes JSON");
    expect(() => parseWhere(["a=1", "a=2"])).toThrow("twice");
  });

  it("--where and --expand need --type, and bad values are refused before any page read", async () => {
    for (const options of [{ where: ["category=guides"] }, { expand: "author" }, { status: "live" }, { sort: "title" }, { expand: "a,b,c,d,e,f", type: "posts" }]) {
      logs.length = 0;
      await expect(contentPagesCommand(options)).rejects.toThrow("exit:1");
    }
    expect(calls.some((c) => c.name === "content.entries.list")).toBe(false);
    await expect(contentPagesCommand({ where: ["category=guides"] })).rejects.toThrow("exit:1");
    expect(logs.join("\n")).toContain("add --type <slug>");
  });

  it("--expand shows each relation under its page, none when empty", async () => {
    handlers["content.entries.list"] = () => ({
      items: [
        { ...PAGE, relations: { author: { id: "ent_ada", slug: "ada", title: "Ada\u001b[2J" }, tags: [] } },
        { ...PAGE, id: "ent_two", relations: { author: null, tags: [{ id: "ent_t1", slug: "t1", title: "Guides" }] } },
      ],
      total: 2,
    });
    await contentPagesCommand({ type: "posts", expand: "author,tags" });
    expect(lastList()).toMatchObject({ expand: ["author", "tags"] });
    const text = logs.join("\n");
    expect(text).toContain("author: Ada\\x1b[2J (ent_ada)");
    expect(text).toContain("tags: none");
    expect(text).toContain("author: none");
    expect(text).toContain("tags: Guides (ent_t1)");
    expect(text).not.toContain("\u001b[2J");
  });

  it("a filter that matches nothing says so", async () => {
    handlers["content.entries.list"] = () => ({ items: [], total: 0 });
    await contentPagesCommand({ status: "scheduled" });
    expect(logs.join("\n")).toContain("No page matches.");
  });
});
