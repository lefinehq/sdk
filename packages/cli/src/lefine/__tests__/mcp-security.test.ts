/** One test per attack on the local MCP tools (security review of a20de99, 9b9674f, 6a3095f). */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_OPTIONS } from "../mcp-config.js";
import { createBridge } from "../mcp-bridge.js";
import { PathError, allowedRoots, mediaTypeOf, resolveInside } from "../mcp-paths.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]);
const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof PathError ? e.code : `other:${String(e)}`;
  }
  return undefined;
};

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "lefine-sec-")));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("P3: the denylist ignores case and covers more secrets", () => {
  test.each([".SSH/id_x.png", ".Git/config", ".AWS/credentials", ".GnuPG/x", "Node_Modules/x.png", ".CONFIG/x.png"])("folder %s is refused in any case", (rel) => {
    mkdirSync(join(dir, rel, ".."), { recursive: true });
    writeFileSync(join(dir, rel), "x");
    const roots = allowedRoots(dir);
    expect(code(() => resolveInside(rel, roots, dir))).toBe("DENIED");
  });
  test.each([".git-credentials", ".pgpass", ".netrc", ".NPMRC", ".pypirc", "server.PEM", "tls.key", "a.p12", "b.pfx", ".htpasswd", "id_rsa_work", "ID_ED25519", "id_ed25519.pub", ".bash_history", ".zsh_history", ".ENV", ".env.production"])("file %s is refused", (name) => {
    writeFileSync(join(dir, name), "x");
    expect(code(() => resolveInside(name, allowedRoots(dir), dir))).toBe("DENIED");
  });
  test("a normal file is still read", () => {
    writeFileSync(join(dir, "en.json"), "{}");
    expect(code(() => resolveInside("en.json", allowedRoots(dir), dir))).toBeUndefined();
  });
});

describe("P4: no broad or secret root", () => {
  let home: string;
  beforeEach(() => {
    home = join(dir, "home", "me");
    for (const d of [".ssh", ".aws", "proj"]) mkdirSync(join(home, d), { recursive: true });
  });
  test("cwd = home, no --allow-dir: no root, one stderr warning, reads refused", () => {
    const warns: string[] = [];
    const roots = allowedRoots(home, [], { home, warn: (l) => warns.push(l) });
    expect(roots).toEqual([]);
    expect(warns).toHaveLength(1);
    expect(warns[0]).toContain("local file tools are off");
    writeFileSync(join(home, "a.png"), PNG);
    expect(code(() => resolveInside("a.png", roots, home))).toBe("OUTSIDE");
  });
  test("cwd = a parent of home (/Users, /home) and cwd = / are refused like home", () => {
    for (const cwd of [join(dir, "home"), dir, "/"]) {
      const warns: string[] = [];
      expect(allowedRoots(cwd, [], { home, warn: (l) => warns.push(l) })).toEqual([]);
      expect(warns).toHaveLength(1);
    }
  });
  test("--allow-dir naming a safe folder turns it back on, with the broad cwd left out", () => {
    const roots = allowedRoots(home, [join(home, "proj")], { home, warn: () => {} });
    expect(roots).toEqual([realpathSync(join(home, "proj"))]);
  });
  test.each([".ssh", ".aws", ".", "..", "../.."])("--allow-dir %s (a denied folder, home, or above it) throws", (d) => {
    expect(code(() => allowedRoots(join(home, "proj"), [join(home, d)], { home }))).toBe("DENIED");
  });
  test("--allow-dir / throws; a folder inside ~/.ssh throws", () => {
    expect(code(() => allowedRoots(join(home, "proj"), ["/"], { home }))).toBe("DENIED");
    mkdirSync(join(home, ".ssh", "sub"));
    expect(code(() => allowedRoots(join(home, "proj"), [join(home, ".SSH", "sub")], { home }))).toBe("DENIED");
  });
  test("a project folder inside home is a fine root", () => {
    expect(allowedRoots(join(home, "proj"), [], { home })).toEqual([realpathSync(join(home, "proj"))]);
  });
  test("the bridge says it on stderr and the local file tools read nothing when started in the home directory", async () => {
    const logs: string[] = [];
    const out: Array<{ result?: { isError?: boolean; content?: Array<{ text: string }> } }> = [];
    const bridge = createBridge({ auth: { token: "t", apiUrl: "http://x" }, fetch: (async () => Response.json({})) as typeof fetch, write: (l) => void out.push(JSON.parse(l)), log: (l) => void logs.push(l), clientVersion: "t", cwd: homedir() });
    expect(logs.filter((l) => l.includes("local file tools are off"))).toHaveLength(1);
    await bridge.handle(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lefine_upload_file", arguments: { path: "Desktop/x.png" } } }));
    expect(out[0]!.result!.isError).toBe(true);
  });
});

/** A Lefine API stub: reads on /v1/ops, the server's own MCP on /v1/mcp. */
function api(opts: { writeResult?: (action: string, input: any) => unknown; level?: string[] } = {}) {
  const ops: string[] = [];
  const mcp: Array<{ url: string; body: any }> = [];
  const previews: any[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url.includes("/v1/mcp")) {
      mcp.push({ url, body });
      if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "lefine_write", inputSchema: {} }] } });
      const a = body.params.arguments;
      const result = opts.writeResult ? opts.writeResult(a.action, a.input) : { content: [{ type: "text", text: "ok" }], structuredContent: { data: { mediaId: "med_1", url: "https://cdn/x.png", run: { status: "succeeded" }, id: "key_1" } } };
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    }
    const op = url.split("/v1/ops/")[1]!;
    ops.push(op);
    const ok = (data: unknown) => Response.json({ ok: true, data });
    if (op === "strings.apps.list") return ok({ items: [{ id: "app_web123", name: "Web", slug: "web", sourceLocale: "en", targetLocales: ["de"] }] });
    if (op === "content.projects.list") return ok({ items: [{ id: "prj_one1", slug: "one", name: "One" }] });
    if (op === "strings.app.get") return ok({ app: { sourceLocale: "en" }, namespaces: [{ name: "nav" }] });
    if (op === "strings.keys.list") return ok({ items: [] });
    if (op === "strings.import.preview") {
      previews.push(body.input);
      return ok({ digest: "a".repeat(64), tally: { created: 1, updated: 0, skipped: 0, dropped: 0 }, dropped: [] });
    }
    return Response.json({ ok: false, error: { code: "NOT_FOUND", message: op } }, { status: 404 });
  }) as typeof globalThis.fetch;
  const out: Array<{ result?: { isError?: boolean; content?: Array<{ text: string }> } }> = [];
  const make = (options = DEFAULT_OPTIONS) => createBridge({ auth: { token: "t", apiUrl: "http://api.test" }, fetch, write: (l) => void out.push(JSON.parse(l)), log: () => {}, clientVersion: "t", cwd: dir, options });
  let id = 0;
  const call = async (bridge: ReturnType<typeof make>, name: string, args: object) => {
    await bridge.handle(JSON.stringify({ jsonrpc: "2.0", id: ++id, method: "tools/call", params: { name, arguments: args } }));
    const r = out.at(-1)!.result!;
    return { text: r.content![0]!.text, isError: r.isError === true };
  };
  globalThis.fetch = fetch; // createOpClient (reads) uses the global fetch
  const writes = () => mcp.filter((m) => m.body.method === "tools/call").map((m) => ({ url: m.url, action: m.body.params.arguments.action, input: m.body.params.arguments.input }));
  return { make, call, ops, writes, previews };
}
const WRITE_OPS = /\.(create|apply|upload|update|set|delete|publish)$/;

describe("P1: local writes go through the server's MCP (lefine_write)", () => {
  test("add_key: strings.keys.create is sent as lefine_write, never to /v1/ops", async () => {
    const t = api();
    const r = await t.call(t.make(), "lefine_add_key", { appId: "app_web123", namespace: "nav", key: "save", sourceText: "Save" });
    expect(r.isError).toBe(false);
    expect(t.writes().map((w) => w.action)).toEqual(["strings.keys.create"]);
    expect(t.ops.filter((o) => WRITE_OPS.test(o))).toEqual([]);
  });
  test("upload_file: content.media.upload is sent as lefine_write", async () => {
    writeFileSync(join(dir, "hero.png"), PNG);
    const t = api();
    const r = await t.call(t.make(), "lefine_upload_file", { path: "hero.png", project: "one" });
    expect(r.isError).toBe(false);
    expect(t.writes()).toMatchObject([{ action: "content.media.upload", input: { projectId: "prj_one1", filename: "hero.png" } }]);
    expect(t.ops.filter((o) => WRITE_OPS.test(o))).toEqual([]);
  });
  test("import: the dry run writes nothing; the apply is lefine_write strings.import.apply with the fresh digest", async () => {
    writeFileSync(join(dir, "en.json"), JSON.stringify({ nav: { save: "Save" } }));
    const t = api();
    const b = t.make();
    const dry = await t.call(b, "lefine_import_locale_files", { path: "en.json", app: "web" });
    expect(dry.isError).toBe(false);
    expect(t.writes()).toEqual([]);
    // No confirmPlan: it is not consent, the server's approval is.
    const done = await t.call(b, "lefine_import_locale_files", { path: "en.json", app: "web", dryRun: false });
    expect(done.isError).toBe(false);
    expect(t.writes()).toMatchObject([{ action: "strings.import.apply", input: { appId: "app_web123", locale: "en", namespace: "nav", digest: "a".repeat(64) } }]);
    expect(t.ops.filter((o) => WRITE_OPS.test(o))).toEqual([]);
  });
  test("needs_approval from the server: nothing is reported as written, the server's words are passed on, the import stops", async () => {
    writeFileSync(join(dir, "en.json"), JSON.stringify({ nav: { save: "Save" } }));
    writeFileSync(join(dir, "hero.png"), PNG);
    const t = api({ writeResult: () => ({ content: [{ type: "text", text: "needs_approval: ask an admin at https://dash.lefine.ai/approvals/apr_1" }], structuredContent: { status: "needs_approval" } }) });
    const b = t.make();
    const imp = await t.call(b, "lefine_import_locale_files", { path: "en.json", app: "web", dryRun: false });
    expect(imp.isError).toBe(true);
    expect(imp.text).toContain("approval");
    expect(imp.text).toContain("apr_1");
    expect(imp.text).not.toMatch(/^Imported 1/);
    const up = await t.call(b, "lefine_upload_file", { path: "hero.png", project: "one" });
    expect(up.isError).toBe(true);
    expect(up.text).toContain("approve");
    const key = await t.call(b, "lefine_add_key", { appId: "app_web123", namespace: "nav", key: "save", sourceText: "Save" });
    expect(key.isError).toBe(true);
    expect(key.text).toContain("approve");
  });
  test("a server refusal (isError) is a failure, not a success", async () => {
    writeFileSync(join(dir, "hero.png"), PNG);
    const t = api({ writeResult: () => ({ isError: true, content: [{ type: "text", text: "FORBIDDEN: key is read-only" }] }) });
    const r = await t.call(t.make(), "lefine_upload_file", { path: "hero.png", project: "one" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("read-only");
  });
  test("--read-only: the local write tools are off and nothing is sent to the server as a write", async () => {
    writeFileSync(join(dir, "hero.png"), PNG);
    const t = api();
    const b = t.make({ ...DEFAULT_OPTIONS, readOnly: true });
    for (const [name, args] of [["lefine_upload_file", { path: "hero.png" }], ["lefine_add_key", { appId: "app_web123", namespace: "nav", key: "k", sourceText: "K" }], ["lefine_import_locale_files", { path: ".", dryRun: false }]] as const) {
      const r = await t.call(b, name, args);
      expect(r.isError).toBe(true);
      expect(r.text).toContain("--read-only");
    }
    expect(t.writes()).toEqual([]);
  });
  test("a toolset that is off refuses the local write's action too", async () => {
    writeFileSync(join(dir, "hero.png"), PNG);
    const t = api();
    const b = t.make({ ...DEFAULT_OPTIONS, toolsets: new Set(["strings"]) });
    const r = await t.call(b, "lefine_upload_file", { path: "hero.png", project: "one" });
    expect(r.isError).toBe(true);
    expect(t.writes()).toEqual([]);
  });
});

describe("P2: locale import reads only locale file types", () => {
  test.each(["secret.pem", ".env", "id_rsa", "notes.txt", "config.toml"])("%s is refused even with format given, and is never read or previewed", async (name) => {
    writeFileSync(join(dir, name), "KEY=value\n");
    const t = api();
    const b = t.make();
    for (const format of [undefined, "json", "properties", "yaml"]) {
      const r = await t.call(b, "lefine_import_locale_files", { path: name, app: "web", ...(format ? { format } : {}) });
      expect(r.isError).toBe(true);
    }
    expect(t.previews).toEqual([]);
  });
  test("a folder: only locale files are previewed; .env and .pem next to them are skipped", async () => {
    writeFileSync(join(dir, "en.json"), JSON.stringify({ nav: { a: "A" } }));
    writeFileSync(join(dir, "prod.env"), "SECRET=1");
    writeFileSync(join(dir, "a.pem"), "-----BEGIN");
    const t = api();
    const r = await t.call(t.make(), "lefine_import_locale_files", { path: ".", app: "web", format: "json" });
    expect(r.isError).toBe(false);
    expect(JSON.stringify(t.previews)).not.toContain("SECRET");
    expect(JSON.stringify(t.previews)).not.toContain("BEGIN");
    expect(t.previews).toHaveLength(1);
  });
  test("the locale types the CLI parses are read", async () => {
    writeFileSync(join(dir, "en.arb"), JSON.stringify({ save: "Save" }));
    const t = api();
    const r = await t.call(t.make(), "lefine_import_locale_files", { path: "en.arb", app: "web", namespace: "nav" });
    expect(r.isError).toBe(false);
  });
});

describe("P5: svg is not uploaded", () => {
  test("mediaTypeOf refuses .svg and an svg file never reaches the server", async () => {
    expect(mediaTypeOf("logo.svg")).toBeNull();
    writeFileSync(join(dir, "logo.svg"), '<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const t = api();
    const r = await t.call(t.make(), "lefine_upload_file", { path: "logo.svg", project: "one" });
    expect(r.isError).toBe(true);
    expect(t.writes()).toEqual([]);
  });
});
