import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { appBase } from "../../utils/cdn-client.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appsCommand, keysCreateCommand, keysDeleteCommand, keysListCommand, languagesAddCommand, runsCommand } from "../strings-manage.js";

const realFetch = globalThis.fetch;
const realExit = process.exit;
const realLog = console.log;
const realErr = console.error;
const realTty = process.stdin.isTTY;
let dir: string;
let logs: string[];
let calls: Array<{ name: string; input: any; approval?: string }>;
let approvalAnswers: string[];

const ME = { user: {}, workspace: { id: "ws_1", slug: "acme", name: "Acme" }, scopes: ["strings:write"], apps: [] };
const APP = { id: "app_web1", slug: "web", name: "Web", sourceLocale: "en", targetLocales: ["tr"], keyCount: 2 };
const APPROVAL = { id: "apr_9", url: "https://dash.lefine.ai/approvals/apr_9", expiresAt: "2026-10-27T10:30:00.000Z" };
const KEY = (id: string, namespace: string, key: string, en: string) => ({ id, appId: APP.id, namespace, key, translations: { en: { text: en, state: "approved" } } });
const RUN = { id: "run_1", kind: "publish", status: "failed", createdAt: "2026-10-27T09:00:00Z", steps: [{ name: "Build snapshot", status: "failed", detail: "not valid ICU" }], counts: { source: 2, pushed: 0, live: null }, tally: { created: 0, updated: 0, skipped: 0, dropped: 0 }, failure: { step: "Build snapshot", reason: "nav.home is not valid ICU.", fixAction: "Fix the text in Lefine and publish again" } };

const ASKS_FIRST = new Set(["strings.keys.delete", "strings.locales.add"]);
function server() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/me")) {
      calls.push({ name: "me", input: null });
      return Response.json(ME);
    }
    if (url.includes("/v1/approvals/")) return Response.json({ ok: true, data: { status: approvalAnswers.shift() ?? "pending" } });
    const name = url.split("/v1/ops/")[1]!;
    const body = JSON.parse(String(init?.body));
    calls.push({ name, input: body.input, ...(body.approval ? { approval: body.approval } : {}) });
    if (ASKS_FIRST.has(name) && body.approval !== APPROVAL.id) return Response.json({ ok: false, error: { code: "APPROVAL_REQUIRED", message: "ask" }, approval: APPROVAL }, { status: 428 });
    const data: Record<string, unknown> = {
      "strings.apps.list": { items: [APP] },
      "strings.keys.list": body.input.cursor
        ? { items: [KEY("key_b", "nav", "about", "About")], nextCursor: null }
        : { items: [KEY("key_a", "nav", "home", "Home"), KEY("key_x", "nav", "homepage", "Home page")], nextCursor: "c2" },
      "strings.keys.create": KEY("key_n", body.input.namespace, body.input.key, body.input.sourceText ?? ""),
      "strings.keys.delete": { deleted: body.input.keyIds?.length },
      "strings.runs.list": { items: [RUN] },
      "strings.runs.get": RUN,
      "strings.locales.add": { app: { ...APP, targetLocales: ["tr", body.input.locale] } },
    };
    return name in data ? Response.json({ ok: true, data: data[name] }) : Response.json({ ok: false, error: { code: "NOT_FOUND", message: name } }, { status: 404 });
  }) as typeof fetch;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lefine-manage-"));
  process.env.LEFINE_HOME = join(dir, "home");
  process.env.LEFINE_TOKEN = "lfn_test_token_value";
  process.env.LEFINE_API_URL = "http://api.test";
  logs = [];
  calls = [];
  approvalAnswers = ["approved"];
  const strip = (a: unknown[]) => a.join(" ").replace(/\u001b\[[0-9;]*m/g, "");
  console.log = (...a: unknown[]) => void logs.push(strip(a));
  console.error = (...a: unknown[]) => void logs.push(strip(a));
  process.exit = ((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as typeof process.exit;
  (process.stdin as { isTTY?: boolean }).isTTY = false;
  server();
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.exit = realExit;
  console.log = realLog;
  console.error = realErr;
  (process.stdin as { isTTY?: boolean }).isTTY = realTty;
  delete process.env.LEFINE_HOME;
  delete process.env.LEFINE_TOKEN;
  delete process.env.LEFINE_API_URL;
  rmSync(dir, { recursive: true, force: true });
});

const opts = () => ({ project: "acme/web", dir });
const text = () => logs.join("\n");
const fast = { openBrowser: () => {}, sleep: async () => {} };

describe("lefine apps", () => {
  it("lists the apps with their ids", async () => {
    await appsCommand({});
    expect(text()).toContain("Web (web)  app_web1");
    expect(text()).toContain("en, tr  ·  2 keys");
  });
});

describe("lefine strings keys", () => {
  it("list: one page by default (says how to get more); --all follows the cursor", async () => {
    await keysListCommand(opts());
    expect(text()).toContain("nav.home  Home");
    expect(text()).toContain("2 keys, more: add --all");
    logs = [];
    await keysListCommand({ ...opts(), all: true, limit: "2" });
    expect(text()).toContain("nav.about  About");
    expect(calls.filter((c) => c.name === "strings.keys.list").map((c) => c.input.limit)).toEqual([50, 2, 2]);
  });

  it("create takes namespace.key and the source text", async () => {
    await keysCreateCommand("nav.pricing", { ...opts(), text: "Pricing" });
    expect(calls.find((c) => c.name === "strings.keys.create")?.input).toEqual({ appId: "app_web1", namespace: "nav", key: "pricing", sourceText: "Pricing" });
    await expect(keysCreateCommand("pricing", opts())).rejects.toThrow("exit:1");
    expect(text()).toContain("namespace.key");
  });

  it("delete finds the exact key (nav.home, not nav.homepage), asks here, then a person approves in Lefine", async () => {
    await keysDeleteCommand(["nav.home", "key_z"], { ...opts(), yes: true }, fast);
    const deletes = calls.filter((c) => c.name === "strings.keys.delete");
    expect(deletes.map((c) => [c.input.keyIds, c.approval])).toEqual([
      [["key_a", "key_z"], undefined],
      [["key_a", "key_z"], "apr_9"],
    ]);
    expect(text()).toContain("Deleting keys cannot be undone, so a person approves it in Lefine");
    expect(text()).toContain("Deleted 2 keys.");
  });

  it("delete without --yes in CI deletes nothing; a key that is not there is an error", async () => {
    await expect(keysDeleteCommand(["nav.home"], opts(), fast)).rejects.toThrow("exit:1");
    expect(text()).toContain("--yes");
    await expect(keysDeleteCommand(["nav.nope"], { ...opts(), yes: true }, fast)).rejects.toThrow("exit:1");
    expect(text()).toContain("No key nav.nope in this app.");
    expect(calls.some((c) => c.name === "strings.keys.delete")).toBe(false);
  });
});

describe("lefine strings runs", () => {
  it("lists runs; with an id shows its steps and why it failed", async () => {
    await runsCommand(undefined, opts());
    expect(text()).toContain("run_1  publish  failed");
    logs = [];
    await runsCommand("run_1", opts());
    expect(calls.at(-1)).toEqual({ name: "strings.runs.get", input: { appId: "app_web1", runId: "run_1" } });
    expect(text()).toContain("Build snapshot");
    expect(text()).toContain("nav.home is not valid ICU. Fix the text in Lefine and publish again");
  });
});

describe("lefine strings languages add", () => {
  it("takes any spelling of the tag; a person approves it; unanswered, it names the --approval rerun", async () => {
    await languagesAddCommand("pt_br", opts(), fast);
    expect(calls.filter((c) => c.name === "strings.locales.add").map((c) => c.input.locale)).toEqual(["pt-BR", "pt-BR"]);
    expect(text()).toContain("Added pt-BR. Languages now: en, tr, pt-BR.");

    approvalAnswers = [];
    let t = 0;
    await expect(languagesAddCommand("de", opts(), { ...fast, now: () => (t += 60_000), approvalWaitMs: 100_000 })).rejects.toThrow("exit:1");
    expect(text()).toContain("run lefine strings languages add de --approval apr_9");
  });
});

describe("--project is the app id (workspace/app is only an alias)", () => {
  it("an id needs no workspace check: the key's own app list decides", async () => {
    await runsCommand(undefined, { project: "app_web1", dir });
    expect(calls.map((c) => c.name)).toEqual(["strings.apps.list", "strings.runs.list"]);
    await expect(runsCommand(undefined, { project: "app_other", dir })).rejects.toThrow("exit:1");
    expect(text()).toContain("no app app_other for this key");
  });

  it("with no --project, the id lefine init wrote into lefine.ts (or src/lefine.ts) is used", async () => {
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "lefine.ts"), 'export const strings = createStrings({ project: "app_web1" });\n');
    await runsCommand(undefined, { dir });
    expect(calls.find((c) => c.name === "strings.runs.list")?.input.appId).toBe("app_web1");
    expect(calls.some((c) => c.name === "me")).toBe(false);
  });

  it("nothing to go on: the error names init and the app id", async () => {
    await expect(runsCommand(undefined, { dir })).rejects.toThrow("exit:1");
    expect(text()).toContain("Run `npx lefine init`, or pass --project with the app id");
  });

  it("the CDN path of an id is /{appId}/..., of the alias /{workspace}/{app}/...", () => {
    expect(appBase("https://cdn.lefine.ai", "app_web1", "")).toBe("https://cdn.lefine.ai/app_web1");
    expect(appBase("https://cdn.lefine.ai", "acme", "web")).toBe("https://cdn.lefine.ai/acme/web");
  });
});
