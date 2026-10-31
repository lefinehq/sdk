// lefine content push: the diff comes first, --dry-run writes nothing, a new type is created, a
// changed type waits for a person's yes in Lefine, a type only in Lefine is left alone, and a bad config is a sentence.
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkConfig, contentPushCommand } from "../content-push.js";

const POSTS_FIELDS = [{ type: "text", name: "title", localized: true }, { type: "textarea", name: "summary" }];

describe("lefine content push", () => {
  const realFetch = globalThis.fetch;
  const realExit = process.exit;
  const realLog = console.log;
  const realErr = console.error;
  let dir: string;
  let logs: string[];
  let calls: Array<{ name: string; input: Record<string, unknown>; approval?: string }>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lefine-push-"));
    process.env.LEFINE_HOME = join(dir, "home");
    process.env.LEFINE_TOKEN = "lfn_test_token_value";
    process.env.LEFINE_API_URL = "http://api.test";
    logs = [];
    calls = [];
    console.log = (...a: unknown[]) => void logs.push(a.join(" "));
    console.error = (...a: unknown[]) => void logs.push(a.join(" "));
    process.exit = ((code?: number) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as typeof process.exit;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    process.exit = realExit;
    console.log = realLog;
    console.error = realErr;
    delete process.env.LEFINE_HOME;
    delete process.env.LEFINE_TOKEN;
    delete process.env.LEFINE_API_URL;
    rmSync(dir, { recursive: true, force: true });
  });

  /** Lefine with one project holding `posts` (title only) and `legacy`; posts' field change is breaking. */
  function api(approvalAnswer: "approved" | "declined" = "approved") {
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const ok = (data: unknown) => new Response(JSON.stringify({ ok: true, data }));
      if (url.includes("/v1/approvals/")) return new Response(JSON.stringify({ data: { status: approvalAnswer } }));
      const name = url.split("/v1/ops/")[1] ?? "";
      const body = JSON.parse(String(init?.body ?? "{}")) as { input: Record<string, unknown>; approval?: string };
      calls.push({ name, input: body.input, ...(body.approval ? { approval: body.approval } : {}) });
      switch (name) {
        case "content.projects.list":
          return ok({ items: [{ id: "prj_site", slug: "site", name: "Site", sourceLocale: "en", targetLocales: ["de"] }] });
        case "content.collections.list":
          return ok({ items: [{ id: "col_posts", slug: "posts", kind: "collection" }, { id: "col_legacy", slug: "legacy", kind: "collection" }] });
        case "content.collections.get":
          return ok({ id: "col_posts", slug: "posts", kind: "collection", labels: { singular: "Post", plural: "Posts" }, schemaVersion: 3, useAsTitle: "title", fields: [POSTS_FIELDS[0]] });
        case "content.collections.previewChange": {
          const same = JSON.stringify(body.input.fields) === JSON.stringify([POSTS_FIELDS[0]]);
          return ok(same ? { class: "safe", digest: "d", totalPages: 2, changes: [] } : { class: "breaking", digest: "d", totalPages: 2, changes: [{ path: "summary", label: "Summary", kind: "added", class: "breaking", note: "a new field", pages: 2, examples: [] }] });
        }
        case "content.collections.create":
          return ok({ id: "col_footer", slug: "footer", kind: "global", schemaVersion: 1, fieldNames: ["copyright"] });
        case "content.collections.update":
          if (!body.approval) return new Response(JSON.stringify({ ok: false, error: { code: "APPROVAL_REQUIRED", message: "asks first" }, approval: { id: "apr_1", url: "http://web.test/approvals/apr_1" } }), { status: 403 });
          return ok({ id: "col_posts", slug: "posts", kind: "collection", schemaVersion: 4, fieldNames: ["title", "summary"] });
        default:
          return new Response(JSON.stringify({ ok: false, error: { code: "NOT_FOUND", message: name } }), { status: 404 });
      }
    }) as typeof fetch;
  }
  const writeConfig = (types: unknown[], file = "lefine.config.json") => writeFileSync(join(dir, file), JSON.stringify({ types }));
  const CONFIG = [
    { slug: "posts", labels: { singular: "Post" }, useAsTitle: "title", fields: POSTS_FIELDS },
    { slug: "footer", kind: "global", labels: { singular: "Footer" }, fields: [{ type: "text", name: "copyright", localized: true }] },
  ];
  const writes = () => calls.filter((c) => c.name === "content.collections.create" || c.name === "content.collections.update");
  const quiet = { openBrowser: () => {}, sleep: async () => {} };

  it("--dry-run shows each type (new, changed with its class and pages, only in Lefine) and writes nothing", async () => {
    api();
    writeConfig(CONFIG);
    await contentPushCommand({ dir, dryRun: true });
    const text = logs.join("\n");
    expect(text).toContain("+ footer");
    expect(text).toContain("~ posts breaking");
    expect(text).toContain("Summary: a new field (2 pages)");
    expect(text).toContain("legacy in Lefine, not in the file: left alone");
    expect(text).toContain("Dry run: 2 types would change. Nothing was written.");
    expect(writes()).toEqual([]);
  });

  it("with the yes: the new type is created, the changed one waits for the person in Lefine and is then updated; nothing is deleted", async () => {
    api();
    writeConfig(CONFIG);
    await contentPushCommand({ dir, yes: true }, quiet);
    // New types first, so a changed type can link to one of them.
    expect(writes().map((c) => [c.name, c.approval ?? null])).toEqual([
      ["content.collections.create", null],
      ["content.collections.update", null],
      ["content.collections.update", "apr_1"],
    ]);
    const update = writes().find((c) => c.approval === "apr_1")!;
    expect(update.input).toMatchObject({ projectId: "prj_site", collectionId: "col_posts", expectedSchemaVersion: 3, labels: { singular: "Post", plural: "Posts" }, fields: POSTS_FIELDS });
    expect(writes().find((c) => c.name === "content.collections.create")?.input).toMatchObject({ slug: "footer", kind: "global", labels: { singular: "Footer" } });
    expect(calls.some((c) => c.name.includes("delete"))).toBe(false);
    expect(logs.join("\n")).toContain("Pushed 2 types.");
  });

  it("a type change the person declines stops the push with the reason", async () => {
    api("declined");
    writeConfig([CONFIG[0]]);
    await expect(contentPushCommand({ dir, yes: true }, quiet)).rejects.toThrow("exit:1");
    expect(logs.join("\n")).toContain("declined in Lefine");
    expect(writes().filter((c) => c.approval)).toEqual([]);
  });

  it("the file matches Lefine: nothing to push, no question", async () => {
    api();
    writeConfig([{ slug: "posts", labels: { singular: "Post" }, fields: [POSTS_FIELDS[0]] }]);
    await contentPushCommand({ dir });
    expect(logs.join("\n")).toContain("Lefine already matches the file.");
    expect(writes()).toEqual([]);
  });

  it("a kind that changed is refused; without --yes in CI it asks for --yes", async () => {
    api();
    writeConfig([{ ...CONFIG[0], kind: "global" }]);
    await expect(contentPushCommand({ dir, yes: true }, quiet)).rejects.toThrow("exit:1");
    expect(logs.join("\n")).toContain("A type's kind cannot change");
    logs.length = 0;
    writeConfig(CONFIG);
    await expect(contentPushCommand({ dir }, quiet)).rejects.toThrow("exit:1");
    expect(logs.join("\n")).toContain("Run it again with --yes");
    expect(writes()).toEqual([]);
  });

  it("reads an .mjs config with defineContent's shape; a missing file names the files it looks for", async () => {
    api();
    writeFileSync(join(dir, "lefine.config.mjs"), `export default { types: ${JSON.stringify([CONFIG[1]])} };`);
    await contentPushCommand({ dir, dryRun: true });
    expect(logs.join("\n")).toContain("+ footer");
    logs.length = 0;
    rmSync(join(dir, "lefine.config.mjs"));
    await expect(contentPushCommand({ dir, dryRun: true })).rejects.toThrow("exit:1");
    expect(logs.join("\n")).toContain("No lefine.config.ts, lefine.config.mts, lefine.config.mjs, lefine.config.js, lefine.config.json here");
  });

  it("checkConfig says what is wrong in the file", () => {
    expect(() => checkConfig({}, "f")).toThrow("must export default defineContent");
    expect(() => checkConfig({ types: [{ slug: "Posts", labels: { singular: "P" }, fields: [{}] }] }, "f")).toThrow("lowercase");
    expect(() => checkConfig({ types: [CONFIG[0], CONFIG[0]] }, "f")).toThrow("in the file twice");
    expect(() => checkConfig({ types: [{ slug: "p", labels: { singular: "P" }, fields: [] }] }, "f")).toThrow("at least one field");
    expect(checkConfig({ default: { types: [CONFIG[1]] } }, "f").types[0]?.slug).toBe("footer");
  });
});
