import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeText } from "../safe-text.js";
import { canonicalLocale, stringsCheckCommand, stringsPublishCommand, stringsPushCommand, stringsStatusCommand } from "../strings-commands.js";

const realFetch = globalThis.fetch;
const realExit = process.exit;
const realLog = console.log;
const realErr = console.error;
const realStdinTty = process.stdin.isTTY;
let dir: string;
let logs: string[];
let calls: Array<{ name: string; body: any; auth: string | null }>;

const TOKEN = "lfn_test_token_value";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lefine-strings-"));
  mkdirSync(join(dir, "locales"));
  writeFileSync(join(dir, "locales", "en.json"), JSON.stringify({ common: { hello: "Hello" } }));
  process.env.LEFINE_HOME = join(dir, "home");
  process.env.LEFINE_TOKEN = TOKEN;
  process.env.LEFINE_API_URL = "http://api.test";
  logs = [];
  calls = [];
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  console.error = (...a: unknown[]) => void logs.push(a.join(" "));
  process.exit = ((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as typeof process.exit;
  // CI: nobody can answer a prompt.
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

const ME = { user: {}, workspace: { id: "ws_1", slug: "acme", name: "Acme" }, scopes: ["strings:publish"], apps: [] };
const APP = { id: "app_web1", slug: "web", name: "Web", sourceLocale: "en", targetLocales: ["tr"], keyCount: 1 };

/** What a person does in Lefine while the CLI waits: one answer per poll of /v1/approvals/:id. */
let approvalAnswers: string[] = ["approved"];
const APPROVAL = { id: "apr_1", url: "https://dash.lefine.ai/approvals/apr_1", expiresAt: "2026-10-26T10:30:00.000Z" };

/**
 * Fake API: `/v1/me`, `strings.apps.list`, and `/v1/ops/:name` answered by `handlers[name]`. A publish asks first, as
 * on the server (#55): without an approval id it answers APPROVAL_REQUIRED with the link, and only runs with one.
 */
function opsServer(handlers: Record<string, (input: any, n: number) => unknown>, me: unknown = ME) {
  const counts: Record<string, number> = {};
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/me")) return new Response(JSON.stringify(me));
    if (url.includes("/v1/approvals/")) {
      calls.push({ name: `approval:${url.split("/v1/approvals/")[1]}`, body: null, auth: null });
      return new Response(JSON.stringify({ ok: true, data: { status: approvalAnswers.shift() ?? "pending" } }));
    }
    const name = url.split("/v1/ops/")[1]!;
    const body = JSON.parse(String(init?.body));
    const auth = (init?.headers as Record<string, string>).Authorization ?? null;
    calls.push({ name, body, auth });
    if (name === "strings.releases.publish" && body.approval !== APPROVAL.id) {
      return new Response(JSON.stringify({ ok: false, error: { code: "APPROVAL_REQUIRED", message: "A person must approve this" }, approval: APPROVAL }), { status: 428 });
    }
    counts[name] = (counts[name] ?? 0) + 1;
    const result = name === "strings.apps.list" ? { items: [APP] } : handlers[name]?.(body.input, counts[name]!);
    if (result && typeof result === "object" && "error" in result) {
      return new Response(JSON.stringify({ ok: false, error: (result as any).error }), { status: 403 });
    }
    return new Response(JSON.stringify({ ok: true, data: result }));
  }) as typeof fetch;
}

const DIGEST = "a".repeat(64);
const PREVIEW = {
  digest: DIGEST,
  source: 1,
  tally: { created: 1, updated: 0, skipped: 0, dropped: 0 },
  dropped: [],
  newNamespace: true,
  alreadyImported: null,
  changes: {
    locales: [
      {
        locale: "en",
        added: 1,
        edited: 0,
        removed: 0,
        truncated: false,
        items: [{ namespace: "common", key: "hello", kind: "added", before: null, after: "Hello", author: null }],
      },
    ],
  },
};
const RUN = (status: string, extra: object = {}) => ({
  run: { id: "run_1", status, steps: [{ name: "upload", status: status === "succeeded" ? "succeeded" : "failed", detail: "5 files" }], counts: { source: 3, pushed: 3, live: 3 }, tally: { created: 1, updated: 0, skipped: 0, dropped: 0 }, ...extra },
  replayed: false,
});
const target = () => ({ project: "acme/web", dir });
const ops = (log: typeof calls) => log.map((c) => c.name).filter((n) => n !== "strings.apps.list");

describe("lefine strings push", () => {
  it("--all pushes the source first, then each language of the app; a language the app lacks is skipped", async () => {
    writeFileSync(join(dir, "locales", "tr.json"), JSON.stringify({ common: { hello: "Merhaba" } }));
    writeFileSync(join(dir, "locales", "fr.json"), JSON.stringify({ common: { hello: "Bonjour" } }));
    opsServer({ "strings.import.preview": () => PREVIEW, "strings.import.apply": () => RUN("succeeded") });
    await stringsPushCommand({ ...target(), all: true, yes: true });
    const applies = calls.filter((c) => c.name === "strings.import.apply").map((c) => [c.body.input.locale, c.body.input.content]);
    expect(applies).toEqual([
      ["en", JSON.stringify({ hello: "Hello" })],
      ["tr", JSON.stringify({ hello: "Merhaba" })],
    ]);
    const text = logs.join("\n");
    expect(text).toContain("Skipped fr: not a language of this app");
    // A language file that names a key Lefine lacks says the key would come with no source text.
    expect(text).toContain("would be added with only the tr text");
  });

  it("--all reads i18next's <locale>/<namespace>.json folders", async () => {
    const folder = join(dir, "public", "locales");
    mkdirSync(join(folder, "en"), { recursive: true });
    mkdirSync(join(folder, "tr"));
    writeFileSync(join(folder, "en", "common.json"), JSON.stringify({ hello: "Hello" }));
    writeFileSync(join(folder, "en", "nav.json"), JSON.stringify({ home: "Home" }));
    writeFileSync(join(folder, "tr", "common.json"), JSON.stringify({ hello: "Merhaba" }));
    opsServer({ "strings.import.preview": () => PREVIEW, "strings.import.apply": () => RUN("succeeded") });
    await stringsPushCommand({ ...target(), all: folder, yes: true, json: true });
    const applies = calls.filter((c) => c.name === "strings.import.apply").map((c) => `${c.body.input.locale}/${c.body.input.namespace}`);
    expect(applies).toEqual(["en/common", "en/nav", "tr/common"]);
    const result = JSON.parse(logs.at(-1)!);
    expect(result).toMatchObject({ ok: true, applied: true, skipped: [] });
    expect(result.locales.map((l: { locale: string }) => l.locale)).toEqual(["en", "tr"]);
  });

  it("--all with no source file refuses before anything is read on the server", async () => {
    const folder = join(dir, "only-tr");
    mkdirSync(folder);
    writeFileSync(join(folder, "tr.json"), JSON.stringify({ common: { hello: "Merhaba" } }));
    opsServer({ "strings.import.preview": () => PREVIEW, "strings.import.apply": () => RUN("succeeded") });
    await expect(stringsPushCommand({ ...target(), all: folder, yes: true })).rejects.toThrow("exit:1");
    expect(logs.join("\n")).toContain("No en file");
    expect(ops(calls)).toEqual([]);
  });

  it("--all in CI without --yes shows the source plan and applies nothing", async () => {
    writeFileSync(join(dir, "locales", "tr.json"), JSON.stringify({ common: { hello: "Merhaba" } }));
    opsServer({ "strings.import.preview": () => PREVIEW, "strings.import.apply": () => RUN("succeeded") });
    await expect(stringsPushCommand({ ...target(), all: true })).rejects.toThrow("exit:1");
    expect(ops(calls)).toEqual(["strings.import.preview"]);
  });

  it("fails in CI without --yes, after showing the counts, and applies nothing", async () => {
    opsServer({ "strings.import.preview": () => PREVIEW, "strings.import.apply": () => ({}) });
    await expect(stringsPushCommand({ ...target() })).rejects.toThrow("exit:1");
    expect(logs.join("\n")).toContain("common");
    expect(logs.join("\n")).toContain("1 new");
    expect(logs.join("\n")).toContain("common.hello");
    expect(logs.join("\n")).toContain("Hello");
    expect(logs.join("\n")).toContain("--yes");
    expect(ops(calls)).toEqual(["strings.import.preview"]);
  });

  it("with --yes imports per namespace with the app id, and hands back each preview digest", async () => {
    opsServer({ "strings.import.preview": () => PREVIEW, "strings.import.apply": () => RUN("succeeded") });
    await stringsPushCommand({ ...target(), yes: true });
    expect(ops(calls)).toEqual(["strings.import.preview", "strings.import.apply"]);
    const preview = calls.find((c) => c.name === "strings.import.preview")!;
    expect(preview.body.input).toEqual({
      appId: "app_web1",
      locale: "en",
      namespace: "common",
      fileName: "common.json",
      content: JSON.stringify({ hello: "Hello" }),
    });
    const apply = calls.find((c) => c.name === "strings.import.apply")!;
    expect(apply.body.input.digest).toBe(DIGEST);
    expect(apply.body.input.namespace).toBe("common");
    expect(apply.auth).toBe(`Bearer ${TOKEN}`);
    expect(logs.join("\n")).not.toContain(TOKEN);
  });

  it("a YAML, XLIFF, Android XML or .properties file goes to the API as it is, under the namespace its name gives (#77)", async () => {
    opsServer({ "strings.import.preview": () => PREVIEW, "strings.import.apply": () => RUN("succeeded") });
    const yaml = "hello: Hello\nnav:\n  home: Home\n";
    writeFileSync(join(dir, "marketing.yaml"), yaml);
    await stringsPushCommand({ ...target(), file: join(dir, "marketing.yaml"), locale: "de", yes: true });
    expect(calls.find((c) => c.name === "strings.import.preview")!.body.input).toEqual({ appId: "app_web1", locale: "de", namespace: "marketing", fileName: "marketing.yaml", content: yaml });
    expect(calls.find((c) => c.name === "strings.import.apply")!.body.input).toMatchObject({ namespace: "marketing", fileName: "marketing.yaml", digest: DIGEST });
  });

  it("a file named for its language needs --namespace; with it, .properties and strings.xml go the same way", async () => {
    opsServer({ "strings.import.preview": () => PREVIEW, "strings.import.apply": () => RUN("succeeded") });
    writeFileSync(join(dir, "pt_BR.properties"), "hello=Olá\n");
    await expect(stringsPushCommand({ ...target(), file: join(dir, "pt_BR.properties"), yes: true })).rejects.toThrow("exit:1");
    expect(logs.join("\n")).toContain("pt_BR.properties is named for a language");
    expect(calls.some((c) => c.name === "strings.import.preview")).toBe(false);
    await stringsPushCommand({ ...target(), file: join(dir, "pt_BR.properties"), namespace: "common", locale: "pt-BR", yes: true });
    expect(calls.find((c) => c.name === "strings.import.preview")!.body.input).toMatchObject({ namespace: "common", locale: "pt-BR", fileName: "pt_BR.properties", content: "hello=Olá\n" });
    calls.length = 0;
    writeFileSync(join(dir, "strings.xml"), '<resources><string name="hello">Hallo</string></resources>');
    await stringsPushCommand({ ...target(), file: join(dir, "strings.xml"), locale: "de", yes: true });
    expect(calls.find((c) => c.name === "strings.import.preview")!.body.input).toMatchObject({ namespace: "strings", fileName: "strings.xml" });
  });

  it("with several namespaces previews each again before its apply and uses the fresh digest", async () => {
    writeFileSync(join(dir, "locales", "en.json"), JSON.stringify({ common: { hello: "Hello" }, aboutPage: { hello: "Hello" } }));
    const FRESH = "b".repeat(64);
    // The first apply moves the app's marker, so the second namespace's first digest is stale.
    opsServer({
      "strings.import.preview": (_input, n) => ({ ...PREVIEW, digest: n <= 2 ? DIGEST : FRESH }),
      "strings.import.apply": (input) => (input.digest === DIGEST || input.digest === FRESH ? RUN("succeeded") : { error: { code: "CONFLICT" } }),
    });
    await stringsPushCommand({ ...target(), yes: true });
    expect(ops(calls)).toEqual(["strings.import.preview", "strings.import.preview", "strings.import.apply", "strings.import.preview", "strings.import.apply"]);
    const applies = calls.filter((c) => c.name === "strings.import.apply");
    expect(applies.map((c) => [c.body.input.namespace, c.body.input.digest])).toEqual([
      ["common", DIGEST],
      ["aboutPage", FRESH],
    ]);
  });

  it("stops before a namespace whose changes differ from what was shown", async () => {
    writeFileSync(join(dir, "locales", "en.json"), JSON.stringify({ common: { hello: "Hello" }, aboutPage: { hello: "Hello" } }));
    opsServer({
      "strings.import.preview": (_input, n) => (n <= 2 ? PREVIEW : { ...PREVIEW, tally: { created: 0, updated: 1, skipped: 0, dropped: 0 } }),
      "strings.import.apply": () => RUN("succeeded"),
    });
    await expect(stringsPushCommand({ ...target(), yes: true })).rejects.toThrow("exit:1");
    expect(calls.filter((c) => c.name === "strings.import.apply").map((c) => c.body.input.namespace)).toEqual(["common"]);
    expect(logs.join("\n")).toContain("aboutPage");
  });

  it("sends the canonical tag (zh-Hans) and reads the lower-case file (zh-hans.json)", async () => {
    writeFileSync(join(dir, "locales", "zh-hans.json"), JSON.stringify({ common: { hello: "你好" } }));
    opsServer({ "strings.import.preview": () => PREVIEW, "strings.import.apply": () => RUN("succeeded") });
    await stringsPushCommand({ ...target(), locale: "zh-hans", yes: true });
    expect(calls.find((c) => c.name === "strings.import.preview")!.body.input.locale).toBe("zh-Hans");
    expect(canonicalLocale("pt_br")).toBe("pt-BR");
    expect(() => canonicalLocale("not a tag")).toThrow("not a language tag");
  });

  it("does not apply when there is nothing new", async () => {
    opsServer({ "strings.import.preview": () => ({ ...PREVIEW, tally: { created: 0, updated: 0, skipped: 1, dropped: 0 } }) });
    await stringsPushCommand({ ...target(), yes: true });
    expect(ops(calls)).toEqual(["strings.import.preview"]);
    expect(logs.join("\n")).toContain("Nothing to push");
  });

  it("asks in a terminal and applies nothing when the answer is no", async () => {
    (process.stdin as { isTTY?: boolean }).isTTY = true;
    const stdoutTty = process.stdout.isTTY;
    (process.stdout as { isTTY?: boolean }).isTTY = true;
    try {
      opsServer({ "strings.import.preview": () => PREVIEW, "strings.import.apply": () => ({}) });
      await stringsPushCommand({ ...target() }, async () => false);
      expect(ops(calls)).toEqual(["strings.import.preview"]);
      expect(logs.join("\n")).toContain("Nothing was changed");
    } finally {
      (process.stdout as { isTTY?: boolean }).isTTY = stdoutTty;
    }
  });

  it("maps FORBIDDEN to the missing scope and exits 1", async () => {
    opsServer({ "strings.import.preview": () => ({ error: { code: "FORBIDDEN", message: "missing scope strings:write" } }) });
    await expect(stringsPushCommand({ ...target(), yes: true })).rejects.toThrow("exit:1");
    expect(logs.join("\n")).toContain("strings:write");
  });

  it("maps MODULE_OFF to a plain sentence", async () => {
    opsServer({ "strings.import.preview": () => ({ error: { code: "MODULE_OFF", message: "off" } }) });
    await expect(stringsPushCommand({ ...target(), yes: true })).rejects.toThrow("exit:1");
    expect(logs.join("\n")).toContain("does not have Strings");
  });

  it("says so when the workspace has no such app", async () => {
    opsServer({});
    await expect(stringsPushCommand({ project: "acme/missing", dir, yes: true })).rejects.toThrow("exit:1");
    expect(logs.join("\n")).toContain('no app "missing"');
  });
});

describe("the key's workspace must be the project's workspace", () => {
  it("refuses push, publish, check and status before any action runs", async () => {
    opsServer({ "strings.import.preview": () => PREVIEW }, { ...ME, workspace: { id: "ws_b", slug: "other", name: "Other" } });
    const wrong = { project: "acme/web", dir, yes: true };
    for (const run of [
      () => stringsPushCommand(wrong),
      () => stringsPublishCommand(wrong),
      () => stringsCheckCommand(wrong),
      () => stringsStatusCommand(wrong),
    ]) {
      logs.length = 0;
      await expect(run()).rejects.toThrow("exit:1");
      expect(logs.join("\n")).toContain("Your key is for workspace other, but this project is acme/web. Run `lefine login` and pick acme.");
    }
    expect(calls).toEqual([]);
  });

  it("accepts the workspace id as well as the slug", async () => {
    opsServer({ "strings.import.preview": () => ({ ...PREVIEW, tally: { created: 0, updated: 0, skipped: 1, dropped: 0 } }) });
    await stringsPushCommand({ project: "ws_1/web", dir, yes: true });
    expect(ops(calls)).toEqual(["strings.import.preview"]);
  });
});

describe("terminal escape injection", () => {
  const ESC = String.fromCharCode(27);

  it("safeText turns control characters into visible escapes and keeps tabs and normal text", () => {
    expect(safeText(`a${ESC}[2Jb`)).toBe("a\\x1b[2Jb");
    expect(safeText("x\ny\rz")).toBe("x\\x0ay\\x0dz");
    expect(safeText("\u009b31m")).toBe("\\x9b31m");
    expect(safeText("‮evil")).toBe("\\u202eevil");
    expect(safeText("tab\there ünï")).toBe("tab\there ünï");
  });

  it("push prints a hostile key and reason without a raw ESC", async () => {
    opsServer({
      "strings.import.preview": () => ({
        ...PREVIEW,
        tally: { ...PREVIEW.tally, dropped: 1 },
        dropped: [{ key: `bad${ESC}[2Jkey`, reason: `${ESC}[1A${ESC}[2K✓ published` }],
      }),
    });
    await expect(stringsPushCommand({ ...target() })).rejects.toThrow("exit:1");
    const text = logs.join("\n");
    expect(text).not.toContain(ESC + "[2J");
    expect(text).not.toContain(ESC + "[1A");
    expect(text).toContain("bad\\x1b[2Jkey");
  });

  it("push prints a hostile change kind and non-numeric counts without a raw ESC", async () => {
    const hostile = `${ESC}[2J`;
    opsServer({
      "strings.import.preview": () => ({
        ...PREVIEW,
        tally: { created: hostile, updated: 1, skipped: hostile, dropped: hostile },
        changes: { locales: [{ locale: "en", added: 1, edited: 0, removed: 0, truncated: false, items: [{ namespace: "common", key: "hello", kind: hostile, before: null, after: "Hello", author: null }] }] },
      }),
    });
    await expect(stringsPushCommand({ ...target() })).rejects.toThrow("exit:1");
    expect(logs.join("\n")).not.toContain(`${ESC}[2J`); // the CLI's own colours use ESC, the hostile clear-screen must not appear
    expect(logs.join("\n")).toContain("\\x1b[2J");
  });

  it("publish prints hostile delivery counts and step text without a raw ESC", async () => {
    const hostile = `${ESC}[2J`;
    opsServer({
      "strings.releases.preview": () => ({ appId: "app_web1", cdnEnabled: true, liveVersion: "v1", keysAdded: 1, keysChanged: 0, keysRemoved: 0, blocker: null, locales: [{ locale: "en", willServe: hostile, draftsExcluded: hostile, added: hostile, edited: 1, removed: hostile }] }),
      "strings.releases.publish": () => RUN("running"),
      "strings.delivery.checks": () => ({ version: "v2", checks: [{ locale: `e${ESC}n`, version: "v2", expectedKeys: hostile, servedKeys: hostile, status: "partial" }] }),
    });
    await expect(stringsPublishCommand({ ...target(), yes: true }, { sleep: async () => {}, now: () => 0 })).rejects.toThrow("exit:1");
    expect(logs.join("\n")).not.toContain(`${ESC}[2J`); // the CLI's own colours use ESC, the hostile clear-screen must not appear
  });

  it("error messages from the server are escaped too", async () => {
    opsServer({ "strings.import.preview": () => ({ error: { code: "BAD_INPUT", message: `${ESC}[2Jnope` } }) });
    await expect(stringsPushCommand({ ...target(), yes: true })).rejects.toThrow("exit:1");
    expect(logs.join("\n")).not.toContain(ESC + "[2J");
    expect(logs.join("\n")).toContain("\\x1b[2Jnope");
  });

  it("--json stays JSON-encoded", async () => {
    opsServer({ "strings.import.preview": () => ({ error: { code: "BAD_INPUT", message: `${ESC}[2Jnope` } }) });
    await expect(stringsPushCommand({ ...target(), yes: true, json: true })).rejects.toThrow("exit:1");
    expect(JSON.parse(logs.at(-1)!).ok).toBe(false);
  });
});

describe("lefine strings publish", () => {
  const preview = {
    appId: "app_web1",
    cdnEnabled: true,
    liveVersion: "v1",
    locales: [
      { locale: "en", willServe: 3, draftsExcluded: 0, added: 1, edited: 1, removed: 0 },
      { locale: "tr", willServe: 3, draftsExcluded: 1, added: 1, edited: 0, removed: 0 },
    ],
    keysAdded: 1,
    keysChanged: 1,
    keysRemoved: 0,
    blocker: null,
  };
  const check = (locale: string, status: string) => ({ locale, version: "v2", expectedKeys: 3, servedKeys: status === "ok" ? 3 : 0, status });
  let opened: string[] = [];
  const quick = { sleep: async () => {}, now: () => 0, openBrowser: (url: string) => void opened.push(url) };
  beforeEach(() => {
    approvalAnswers = ["approved"];
    opened = [];
  });

  it("a person approves in Lefine: the CLI shows the link, waits, then publishes once with the approval id; never confirm (#55)", async () => {
    approvalAnswers = ["pending", "pending", "approved"];
    opsServer({ "strings.releases.preview": () => preview, "strings.releases.publish": () => RUN("succeeded") });
    await stringsPublishCommand({ ...target(), yes: true }, quick);
    // The fixture is a fake id on another host than the API (api.test): printed, never opened (approvalUrlToOpen).
    expect(opened).toEqual([]);
    expect(logs.join("\n")).toContain(APPROVAL.url);
    expect(logs.join("\n")).toContain(APPROVAL.url);
    const publishes = calls.filter((c) => c.name === "strings.releases.publish");
    expect(publishes).toHaveLength(2);
    expect(publishes.every((c) => c.body.confirm === undefined)).toBe(true);
    expect(publishes[0]!.body.approval).toBeUndefined();
    expect(publishes[1]!.body.approval).toBe("apr_1");
    // The same call both times: one request id, so the approval (bound to the exact input) holds.
    expect(publishes[1]!.body.input).toEqual(publishes[0]!.body.input);
    expect(publishes[0]!.body.input.appId).toBe("app_web1");
    expect(calls.filter((c) => c.name === "approval:apr_1")).toHaveLength(3);
    expect(logs.join("\n")).toContain("Verified on the CDN");
  });

  it("a hostile approval link is printed without escape sequences", async () => {
    const ESC2 = String.fromCharCode(27);
    APPROVAL.url = `https://dash.lefine.ai/approvals/apr_1${ESC2}[2J`;
    try {
      opsServer({ "strings.releases.preview": () => preview, "strings.releases.publish": () => RUN("succeeded") });
      await stringsPublishCommand({ ...target(), yes: true }, quick);
      // The CLI's own colours use ESC; the server's text may not: its sequence shows as a visible escape.
      expect(logs.join("\n")).not.toContain(`${ESC2}[2J`);
      expect(logs.join("\n")).toContain("apr_1\\x1b[2J");
    } finally {
      APPROVAL.url = "https://dash.lefine.ai/approvals/apr_1";
    }
  });

  it("a decline in Lefine publishes nothing (exit 1)", async () => {
    approvalAnswers = ["pending", "declined"];
    opsServer({ "strings.releases.preview": () => preview, "strings.releases.publish": () => RUN("succeeded") });
    await expect(stringsPublishCommand({ ...target(), yes: true }, quick)).rejects.toThrow("exit:1");
    expect(calls.filter((c) => c.name === "strings.releases.publish")).toHaveLength(1);
    expect(logs.join("\n")).toContain("declined");
  });

  it("nobody answering (CI) stops after the wait and publishes nothing; --yes cannot approve", async () => {
    approvalAnswers = [];
    let t = 0;
    opsServer({ "strings.releases.preview": () => preview, "strings.releases.publish": () => RUN("succeeded") });
    await expect(
      stringsPublishCommand({ ...target(), yes: true }, { ...quick, sleep: async () => void (t += 60_000), now: () => t, approvalWaitMs: 120_000 }),
    ).rejects.toThrow("exit:1");
    expect(calls.filter((c) => c.name === "strings.releases.publish")).toHaveLength(1);
    expect(logs.join("\n")).toContain(APPROVAL.url);
  });

  it("a run still going waits for the new version's checks, ignoring the old live version", async () => {
    opsServer({
      "strings.releases.preview": () => preview,
      "strings.releases.publish": () => RUN("waiting"),
      "strings.delivery.checks": (_i, n) =>
        n === 1 ? { version: "v1", checks: [check("en", "ok")] } : n === 2 ? { version: "v2", checks: [] } : { version: "v2", checks: [check("en", "ok"), check("tr", "ok")] },
    });
    await stringsPublishCommand({ ...target(), yes: true }, quick);
    expect(calls.filter((c) => c.name === "strings.delivery.checks")).toHaveLength(3);
    expect(logs.join("\n")).toContain("Verified on the CDN");
  });

  it("exits 1 for a partial or failed run and shows the failing steps", async () => {
    opsServer({ "strings.releases.preview": () => preview, "strings.releases.publish": () => RUN("partial") });
    await expect(stringsPublishCommand({ ...target(), yes: true }, quick)).rejects.toThrow("exit:1");
    expect(logs.join("\n")).toContain("not every locale is verified");
    expect(logs.join("\n")).toContain("5 files");
  });

  it("a run that failed at the CDN check is not called published: Lefine took it back (exit 1, json published false)", async () => {
    const failure = { step: "Verify delivery", reason: "Version v2 is uploaded, but the CDN does not serve all of it: en serves 0 of 3. It was taken back: the previous release is live again.", fixAction: "Publish again" };
    opsServer({ "strings.releases.preview": () => preview, "strings.releases.publish": () => RUN("failed", { failure }) });
    await expect(stringsPublishCommand({ ...target(), yes: true }, quick)).rejects.toThrow("exit:1");
    const text = logs.join("\n");
    expect(text).not.toContain("Published.");
    expect(text).not.toContain("Published, but");
    expect(text).toContain("The publish failed");
    expect(text).toContain("It was taken back");

    logs.length = 0;
    approvalAnswers = ["approved"]; // the person approves the second run too
    await expect(stringsPublishCommand({ ...target(), yes: true, json: true }, quick)).rejects.toThrow("exit:1");
    const json = JSON.parse(logs.find((l) => l.trim().startsWith("{")) ?? "{}");
    expect(json.published).toBe(false);
    expect(json.verified).toBe(false);
  });

  it("exits 1 when a check of the new version is not ok", async () => {
    opsServer({
      "strings.releases.preview": () => preview,
      "strings.releases.publish": () => RUN("running"),
      "strings.delivery.checks": () => ({ version: "v2", checks: [check("en", "ok"), check("tr", "partial")] }),
    });
    await expect(stringsPublishCommand({ ...target(), yes: true }, quick)).rejects.toThrow("exit:1");
  });

  it("exits 1 when the CDN never answers before the timeout", async () => {
    let t = 0;
    opsServer({
      "strings.releases.preview": () => preview,
      "strings.releases.publish": () => RUN("running"),
      "strings.delivery.checks": () => ({ version: "v1", checks: [check("en", "ok")] }),
    });
    await expect(
      stringsPublishCommand({ ...target(), yes: true }, { sleep: async () => void (t += 60_000), now: () => t, verifyTimeoutMs: 120_000 }),
    ).rejects.toThrow("exit:1");
  });

  it("needs --yes in CI and does not publish without it", async () => {
    opsServer({ "strings.releases.preview": () => preview, "strings.releases.publish": () => RUN("succeeded") });
    await expect(stringsPublishCommand({ ...target() }, quick)).rejects.toThrow("exit:1");
    expect(ops(calls)).toEqual(["strings.releases.preview"]);
  });

  it("publishes nothing when every language is already live (exit 0)", async () => {
    opsServer({
      "strings.releases.preview": () => ({ ...preview, locales: preview.locales.map((l) => ({ ...l, added: 0, edited: 0 })), blocker: "Nothing to publish: every language is already live." }),
    });
    await stringsPublishCommand({ ...target(), yes: true }, quick);
    expect(ops(calls)).toEqual(["strings.releases.preview"]);
  });

  it("stops with the reason when publishing is blocked", async () => {
    opsServer({ "strings.releases.preview": () => ({ ...preview, blocker: "CDN is off for this app" }) });
    await expect(stringsPublishCommand({ ...target(), yes: true }, quick)).rejects.toThrow("exit:1");
    expect(logs.join("\n")).toContain("CDN is off for this app");
  });
});

describe("lefine strings status", () => {
  it("prints the live version, pending changes and the CDN check; --json is machine readable", async () => {
    opsServer({
      "strings.releases.preview": () => ({
        appId: "app_web1", cdnEnabled: true, liveVersion: "v4", keysAdded: 3, keysChanged: 0, keysRemoved: 0, blocker: null,
        locales: [{ locale: "en", willServe: 3, draftsExcluded: 0, added: 3, edited: 0, removed: 0 }],
      }),
      "strings.delivery.checks": () => ({ version: "v4", checks: [{ locale: "en", version: "v4", expectedKeys: 3, servedKeys: 3, status: "ok" }] }),
    });
    await stringsStatusCommand({ ...target(), json: true });
    expect(JSON.parse(logs[0]!)).toMatchObject({ ok: true, app: "web", pending: 3, liveVersion: "v4" });
  });
});


describe("lefine strings check", () => {
  it("reads every page, groups problems by key and exits 1", async () => {
    const pages = [
      { keys: 1, checked: 1, problems: [{ namespace: "common", key: "hello", locale: "tr", reason: "variable", message: "changed a variable" }], nextCursor: "c2" },
      { keys: 1, checked: 1, problems: [], nextCursor: null },
    ];
    opsServer({ "strings.check": () => pages.shift() });
    await expect(stringsCheckCommand({ ...target() })).rejects.toThrow("exit:1");
    const checks = calls.filter((c) => c.name === "strings.check");
    expect(checks).toHaveLength(2);
    expect(checks[1]!.body.input.cursor).toBe("c2");
    expect(logs.join("\n")).toContain("common/hello");
    expect(logs.join("\n")).toContain("changed a variable");
  });
});
