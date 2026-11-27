import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LefineError, type OpClient } from "../client.js";
import { globToRegExp, uploadFile, uploadFolder } from "../mcp-files.js";
import { callLocal } from "../mcp-local.js";
import { DEFAULT_OPTIONS } from "../mcp-config.js";
import { allowedRoots } from "../mcp-paths.js";
import { readProjectInfo } from "../mcp-project.js";
import { planCode, planFiles } from "../mcp-locale.js";
import type { LocalCtx } from "../mcp-result.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(24)]);
const PROJECTS = [
  { id: "prj_onecup1", slug: "onecup", name: "OneCup" },
  { id: "prj_z5k0001", slug: "z5k", name: "z5k" },
];
const APPS = [{ id: "app_web123", slug: "web", name: "Web app", sourceLocale: "en", targetLocales: ["de", "tr"], keyCount: 3 }];

let dir: string;
let calls: Array<{ name: string; input: any }>;
let ctx: LocalCtx;

/** A stub of the Lefine actions the local tools call. `overrides` answer by action name. */
function stubOps(overrides: Record<string, (input: any) => unknown> = {}): OpClient {
  return {
    async callOp(name: string, input: any) {
      calls.push({ name, input });
      if (overrides[name]) return overrides[name]!(input) as never;
      if (name === "content.projects.list") return { items: PROJECTS } as never;
      if (name === "strings.apps.list") return { items: APPS } as never;
      if (name === "content.media.upload") return { mediaId: `med_${input.filename}`, url: `https://cdn.example/${input.filename}`, filename: input.filename, mimeType: input.contentType, byteSize: 1, width: 4, height: 3 } as never;
      throw new LefineError("NOT_FOUND", name);
    },
    async approvalStatus() {
      return "pending";
    },
  };
}
const mkctx = (ops: OpClient = stubOps()): LocalCtx => ({ ops, cwd: dir, roots: allowedRoots(dir) });

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "lefine-local-")));
  calls = [];
  ctx = mkctx();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("lefine_upload_file", () => {
  test("uploads a local picture by project NAME and answers mediaId and url", async () => {
    mkdirSync(join(dir, "public"));
    writeFileSync(join(dir, "public", "hero.png"), PNG);
    const r = await uploadFile(ctx, { path: "public/hero.png", project: "OneCup", alt: "A cup" });
    expect(r.isError).toBeUndefined();
    expect(r.structuredContent).toMatchObject({ mediaId: "med_hero.png", url: "https://cdn.example/hero.png", width: 4, height: 3 });
    const up = calls.find((c) => c.name === "content.media.upload")!;
    expect(up.input).toMatchObject({ projectId: "prj_onecup1", filename: "hero.png", contentType: "image/png", alt: "A cup" });
    expect(Buffer.from(up.input.bytesBase64, "base64").equals(PNG)).toBe(true);
  });
  test("an id goes straight through; no project falls back to lefine.config.*, then to the only project", async () => {
    writeFileSync(join(dir, "a.png"), PNG);
    await uploadFile(ctx, { path: "a.png", project: "prj_z5k0001" });
    expect(calls.map((c) => c.name)).toEqual(["content.media.upload"]);
    writeFileSync(join(dir, "lefine.config.ts"), 'export default defineContent({ project: "z5k", types: [] })');
    calls = [];
    await uploadFile(ctx, { path: "a.png" });
    expect(calls.find((c) => c.name === "content.media.upload")!.input.projectId).toBe("prj_z5k0001");
    rmSync(join(dir, "lefine.config.ts"));
    const r = await uploadFile(ctx, { path: "a.png" });
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain("Which project?");
  });
  test("an unclear or unknown project name says what exists and uploads nothing", async () => {
    writeFileSync(join(dir, "a.png"), PNG);
    const none = await uploadFile(ctx, { path: "a.png", project: "nothing" });
    expect(none.isError).toBe(true);
    expect(none.content[0]!.text).toContain("OneCup");
    expect(calls.some((c) => c.name === "content.media.upload")).toBe(false);
  });
  test("a path outside, a link out, a wrong type, a fake picture and an oversize file are refused before any upload", async () => {
    const out = realpathSync(mkdtempSync(join(tmpdir(), "lefine-out-")));
    try {
      writeFileSync(join(out, "s.png"), PNG);
      symlinkSync(join(out, "s.png"), join(dir, "link.png"));
      writeFileSync(join(dir, "notes.txt"), "hello");
      writeFileSync(join(dir, "fake.png"), "API_KEY=secret");
      writeFileSync(join(dir, "huge.png"), Buffer.concat([PNG, Buffer.alloc(8 * 1024 * 1024)]));
      for (const p of [join(out, "s.png"), "../x.png", "link.png", "notes.txt", "fake.png", "huge.png", "missing.png"]) {
        const r = await uploadFile(ctx, { path: p, project: "OneCup" });
        expect(r.isError).toBe(true);
      }
      expect(calls.some((c) => c.name === "content.media.upload")).toBe(false);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });
  test("the server's refusal is passed on as a sentence, and a malformed answer is an error", async () => {
    writeFileSync(join(dir, "a.png"), PNG);
    const refused = await uploadFile(mkctx(stubOps({ "content.media.upload": () => { throw new LefineError("FORBIDDEN", "missing content:write"); } })), { path: "a.png", project: "prj_z5k0001" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("FORBIDDEN");
    const bad = await uploadFile(mkctx(stubOps({ "content.media.upload": () => ({ nope: 1 }) })), { path: "a.png", project: "prj_z5k0001" });
    expect(bad.isError).toBe(true);
  });
});

describe("lefine_upload_folder", () => {
  test("uploads what the pattern matches, skips other types and links, answers a table", async () => {
    mkdirSync(join(dir, "img", "sub"), { recursive: true });
    writeFileSync(join(dir, "img", "a.png"), PNG);
    writeFileSync(join(dir, "img", "b.png"), PNG);
    writeFileSync(join(dir, "img", "sub", "c.png"), PNG);
    writeFileSync(join(dir, "img", "readme.txt"), "x");
    symlinkSync(join(dir, "img", "a.png"), join(dir, "img", "ln.png"));
    const top = await uploadFolder(ctx, { path: "img", project: "OneCup" });
    expect(top.structuredContent).toMatchObject({ uploaded: 2, failed: 0, remaining: 0 });
    expect(top.content[0]!.text).toContain("| a.png | uploaded | med_a.png |");
    expect(top.content[0]!.text).toContain("1 link(s) were not followed");
    calls = [];
    const deep = await uploadFolder(ctx, { path: "img", project: "OneCup", pattern: "**/*.png" });
    expect(deep.structuredContent).toMatchObject({ uploaded: 3 });
  });
  test("at most 50 per call, with skip for the rest", async () => {
    mkdirSync(join(dir, "many"));
    for (let i = 0; i < 53; i++) writeFileSync(join(dir, "many", `p${String(i).padStart(2, "0")}.png`), PNG);
    const first = await uploadFolder(ctx, { path: "many", project: "OneCup" });
    expect(first.structuredContent).toMatchObject({ uploaded: 50, remaining: 3 });
    expect(first.content[0]!.text).toContain("skip: 50");
    calls = [];
    const rest = await uploadFolder(ctx, { path: "many", project: "OneCup", skip: 50 });
    expect(rest.structuredContent).toMatchObject({ uploaded: 3, remaining: 0 });
    expect(calls.filter((c) => c.name === "content.media.upload").map((c) => c.input.filename)).toEqual(["p50.png", "p51.png", "p52.png"]);
  });
  test("one failing file does not stop the others; all failing is an error", async () => {
    mkdirSync(join(dir, "f"));
    writeFileSync(join(dir, "f", "ok.png"), PNG);
    writeFileSync(join(dir, "f", "fake.png"), "not a picture");
    const r = await uploadFolder(ctx, { path: "f", project: "OneCup" });
    expect(r.structuredContent).toMatchObject({ uploaded: 1, failed: 1 });
    expect(r.isError).toBeUndefined();
    const allBad = await uploadFolder(mkctx(stubOps({ "content.media.upload": () => { throw new LefineError("INTERNAL", "boom"); } })), { path: "f", project: "OneCup" });
    expect(allBad.isError).toBe(true);
  });
  test("a folder outside, a file instead of a folder, and an empty match are answered, not thrown", async () => {
    writeFileSync(join(dir, "a.png"), PNG);
    expect((await uploadFolder(ctx, { path: "/tmp", project: "OneCup" })).isError).toBe(true);
    expect((await uploadFolder(ctx, { path: "a.png", project: "OneCup" })).isError).toBe(true);
    mkdirSync(join(dir, "empty"));
    const none = await uploadFolder(ctx, { path: "empty", project: "OneCup" });
    expect(none.isError).toBeUndefined();
    expect(none.structuredContent).toMatchObject({ uploaded: 0 });
  });
  test("glob: * stays in one folder, ** goes deep, {a,b} and ? work, the rest is literal", () => {
    expect(globToRegExp("*.png").test("a.png")).toBe(true);
    expect(globToRegExp("*.png").test("d/a.png")).toBe(false);
    expect(globToRegExp("**/*.png").test("d/e/a.png")).toBe(true);
    expect(globToRegExp("**/*.png").test("a.png")).toBe(true);
    expect(globToRegExp("*.{png,jpg}").test("a.jpg")).toBe(true);
    expect(globToRegExp("a?.png").test("ab.png")).toBe(true);
    expect(globToRegExp("a.png").test("aXpng")).toBe(false);
    expect(() => globToRegExp("*.{png")).toThrow();
  });
});

describe("lefine_project", () => {
  test("reads lefine.ts and lefine.config.* as TEXT: nothing in them runs", async () => {
    writeFileSync(join(dir, "lefine.ts"), 'import "node:fs"; throw new Error("must not run");\nexport const lefine = createLefine({ project: "app_web123", locales: ["en", "de"] });');
    writeFileSync(join(dir, "lefine.config.ts"), 'process.exit(9);\nexport default defineContent({ project: "prj_z5k0001", types: [{ slug: "page" }, { slug: "blog-post" }] })');
    const info = readProjectInfo(dir);
    expect(info).toMatchObject({ appId: "app_web123", appFile: "lefine.ts", locales: ["en", "de"], contentProject: "prj_z5k0001", contentFile: "lefine.config.ts", contentTypes: ["page", "blog-post"] });
    const r = await callLocal("lefine_project", {}, ctx, DEFAULT_OPTIONS);
    expect(r!.structuredContent).toMatchObject({ found: true, appId: "app_web123" });
    expect(calls.length).toBe(0);
  });
  test("an empty folder says so, and src/lefine.ts and lefine.config.json are found", async () => {
    expect((await callLocal("lefine_project", {}, ctx, DEFAULT_OPTIONS))!.structuredContent).toMatchObject({ found: false });
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "lefine.ts"), "export default { project: 'app_abc123' }");
    writeFileSync(join(dir, "lefine.config.json"), JSON.stringify({ project: "z5k", types: [] }));
    expect(readProjectInfo(dir)).toMatchObject({ appId: "app_abc123", contentProject: "z5k" });
  });
});

describe("lefine_import_locale_files", () => {
  const preview = (created = 2, updated = 1) => ({ digest: "a".repeat(64), source: 3, tally: { created, updated, skipped: 0, dropped: 0 }, dropped: [], newNamespace: false, alreadyImported: null, changes: { locales: [{ locale: "en", added: created, edited: updated, removed: 0, items: [], truncated: false }] } });
  const run = (status = "succeeded") => ({ run: { id: "run_1", status, steps: [], counts: { source: 0, pushed: 0, live: null }, tally: { created: 0, updated: 0, skipped: 0, dropped: 0 } }, replayed: false });

  test("planFiles: de.json (namespaces inside), de/common.yaml, common.yaml, and a language the app lacks is left to the caller", () => {
    const app = { id: "app_web123", sourceLocale: "en" };
    const items = planFiles(
      [
        { rel: "de.json", format: "json", text: JSON.stringify({ nav: { save: "Speichern" }, auth: { login: "Anmelden" } }) },
        { rel: "tr/common.yaml", format: "yaml", text: "hi: Merhaba" },
        { rel: "common.properties", format: "properties", text: "hi=Hello" },
      ],
      app,
      {},
    );
    expect(items.map((i) => [i.input.locale, i.input.namespace, i.input.fileName])).toEqual([
      ["de", "nav", "nav.json"],
      ["de", "auth", "auth.json"],
      ["tr", "common", "common.yaml"],
      ["en", "common", "common.properties"],
    ]);
    // "nav" and "app" are 3 letters and not languages of this app: namespaces. "ui" is 2 letters: a language, until --locale says otherwise.
    expect(planFiles([{ rel: "nav.yaml", format: "yaml", text: "a: b" }], app, {})[0]!.input).toMatchObject({ locale: "en", namespace: "nav" });
    expect(planFiles([{ rel: "ui.yaml", format: "yaml", text: "a: b" }], app, { locale: "en" })[0]!.input).toMatchObject({ locale: "en", namespace: "ui" });
    expect(() => planFiles([{ rel: "de.yaml", format: "yaml", text: "a: b" }], app, {})).toThrow(/namespace/);
    expect(() => planFiles([{ rel: "de.json", format: "json", text: "[1]" }], app, {})).toThrow(/object/);
    expect(() => planFiles([{ rel: "de.json", format: "json", text: JSON.stringify({ nav: "flat" }) }], app, {})).toThrow(/object of keys/);
  });
  test("planFiles reads .po through the shared reader", () => {
    const po = 'msgid ""\nmsgstr ""\n"Language: de\\n"\n\nmsgid "Save"\nmsgstr "Speichern"\n';
    const items = planFiles([{ rel: "app.po", format: "po", text: po }], { id: "app_web123", sourceLocale: "en", targetLocales: ["de"] }, { locale: "de", namespace: "app" });
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]!.input).toMatchObject({ locale: "de", namespace: "app" });
  });

  test("dry run (the default) writes nothing, shows counts and a confirmPlan; apply needs that code", async () => {
    writeFileSync(join(dir, "en.json"), JSON.stringify({ nav: { save: "Save" } }));
    writeFileSync(join(dir, "fr.json"), JSON.stringify({ nav: { save: "Enregistrer" } }));
    const ops = stubOps({ "strings.import.preview": () => preview(), "strings.import.apply": () => run() });
    const c = mkctx(ops);
    const dry = await callLocal("lefine_import_locale_files", { path: ".", app: "Web app" }, c, DEFAULT_OPTIONS);
    expect(dry!.isError).toBeUndefined();
    expect(dry!.structuredContent).toMatchObject({ dryRun: true, created: 2, updated: 1, files: 1 });
    expect(dry!.content[0]!.text).toContain("Nothing was written");
    expect(dry!.content[0]!.text).toContain("not a language of this app: fr");
    expect(calls.some((x) => x.name === "strings.import.apply")).toBe(false);
    const code = dry!.structuredContent!.confirmPlan as string;

    const noCode = await callLocal("lefine_import_locale_files", { path: ".", app: "web", dryRun: false }, c, DEFAULT_OPTIONS);
    expect(noCode!.isError).toBe(true);
    const wrong = await callLocal("lefine_import_locale_files", { path: ".", app: "web", dryRun: false, confirmPlan: "deadbeef" }, c, DEFAULT_OPTIONS);
    expect(wrong!.isError).toBe(true);
    expect(calls.some((x) => x.name === "strings.import.apply")).toBe(false);

    const done = await callLocal("lefine_import_locale_files", { path: ".", app: "web", dryRun: false, confirmPlan: code }, c, DEFAULT_OPTIONS);
    expect(done!.isError).toBeUndefined();
    expect(done!.structuredContent).toMatchObject({ dryRun: false, applied: 1 });
    const applied = calls.find((x) => x.name === "strings.import.apply")!;
    expect(applied.input).toMatchObject({ appId: "app_web123", locale: "en", namespace: "nav", digest: "a".repeat(64) });
  });
  test("the plan code changes when what the server would do changes: the apply is refused", async () => {
    writeFileSync(join(dir, "en.json"), JSON.stringify({ nav: { save: "Save" } }));
    let digest = "a".repeat(64);
    const ops = stubOps({ "strings.import.preview": () => ({ ...preview(), digest }), "strings.import.apply": () => run() });
    const c = mkctx(ops);
    const dry = await callLocal("lefine_import_locale_files", { path: "en.json", app: "web" }, c, DEFAULT_OPTIONS);
    digest = "b".repeat(64);
    const r = await callLocal("lefine_import_locale_files", { path: "en.json", app: "web", dryRun: false, confirmPlan: dry!.structuredContent!.confirmPlan }, c, DEFAULT_OPTIONS);
    expect(r!.isError).toBe(true);
    expect(calls.some((x) => x.name === "strings.import.apply")).toBe(false);
  });
  test("a run that does not finish cleanly stops the rest and says so", async () => {
    writeFileSync(join(dir, "en.json"), JSON.stringify({ a: { x: "1" }, b: { y: "2" } }));
    const ops = stubOps({ "strings.import.preview": () => preview(), "strings.import.apply": () => run("failed") });
    const c = mkctx(ops);
    const dry = await callLocal("lefine_import_locale_files", { path: "en.json", app: "web" }, c, DEFAULT_OPTIONS);
    const r = await callLocal("lefine_import_locale_files", { path: "en.json", app: "web", dryRun: false, confirmPlan: dry!.structuredContent!.confirmPlan }, c, DEFAULT_OPTIONS);
    expect(r!.isError).toBe(true);
    expect(r!.content[0]!.text).toContain("did not finish cleanly");
    expect(calls.filter((x) => x.name === "strings.import.apply").length).toBe(1);
  });
  test("paths outside the folder and unknown formats are refused; planCode is stable for the same previews", async () => {
    const out = await callLocal("lefine_import_locale_files", { path: "/etc/hosts", app: "web" }, ctx, DEFAULT_OPTIONS);
    expect(out!.isError).toBe(true);
    const fmt = await callLocal("lefine_import_locale_files", { path: ".", app: "web", format: "docx" }, ctx, DEFAULT_OPTIONS);
    expect(fmt!.isError).toBe(true);
    const item = { input: { appId: "a", locale: "en", namespace: "n", fileName: "n.json", content: "{}" }, preview: preview() as never };
    expect(planCode([item])).toBe(planCode([item]));
    expect(planCode([item])).not.toBe(planCode([{ ...item, preview: { ...preview(), digest: "c".repeat(64) } as never }]));
  });
});

describe("read-only and toolsets on local tools", () => {
  test("a write tool is refused under --read-only even when called by name", async () => {
    writeFileSync(join(dir, "a.png"), PNG);
    const r = await callLocal("lefine_upload_file", { path: "a.png", project: "OneCup" }, ctx, { ...DEFAULT_OPTIONS, readOnly: true });
    expect(r!.isError).toBe(true);
    expect(calls.length).toBe(0);
    expect(await callLocal("lefine_unknown", {}, ctx, DEFAULT_OPTIONS)).toBeNull();
  });
});
