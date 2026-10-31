import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Issue } from "../../analyzer/types.js";
import { lefineDoctorCommand } from "../doctor-command.js";
import { stringsMissingCommand, stringsUnusedCommand, toPattern, usageQuery } from "../strings-usage.js";

const realFetch = globalThis.fetch;
const realExit = process.exit;
const realLog = console.log;
const realErr = console.error;
const realTty = process.stdin.isTTY;
let dir: string;
let logs: string[];
let calls: Array<{ name: string; input: any; approval?: string }>;

const ME = { user: {}, workspace: { id: "ws_1", slug: "acme", name: "Acme" }, scopes: ["strings:write"], apps: [] };
const APP = { id: "app_web1", slug: "web", name: "Web", sourceLocale: "en", targetLocales: ["tr"], keyCount: 3 };
const APPROVAL = { id: "apr_1", url: "https://dash.lefine.ai/approvals/apr_1", expiresAt: "2026-10-27T10:30:00.000Z" };
let approvalAnswers: string[];

const issue = (extra: Partial<Issue>): Issue => ({ file: "a.tsx", line: 1, column: 1, text: "", type: "string-variable", severity: "info", message: "", ...extra });

/** The server's strings.keys.usage over a fixed key list, with its matching rule (full names, * in one segment, prefixes). */
const KEYS = [
  { keyId: "key_1", namespace: "nav", key: "home" },
  { keyId: "key_2", namespace: "nav", key: "old" },
  { keyId: "key_3", namespace: "plans", key: "pro.name" },
  { keyId: "key_4", namespace: "footer", key: "links.a" },
  { keyId: "key_5", namespace: "footer", key: "links.b" },
];
function usage(input: { codeKeys: string[]; patterns: string[]; prefixes: string[] }) {
  const full = (k: (typeof KEYS)[number]) => `${k.namespace}.${k.key}`;
  const match = (p: string, name: string) => new RegExp(`^${p.split("*").map((x) => x.replace(/[.]/g, "\\.")).join("[^.]+")}$`).test(name);
  const used = KEYS.filter(
    (k) => input.codeKeys.some((c) => c === full(k) || c === k.key) || input.patterns.some((p) => match(p, full(k))) || input.prefixes.some((p) => full(k).startsWith(`${p}.`) || k.namespace === p),
  );
  const unused = KEYS.filter((k) => !used.includes(k));
  const missing = input.codeKeys.filter((c) => !KEYS.some((k) => c === full(k) || c === k.key));
  return { keys: KEYS.length, used: used.length, unusedTotal: unused.length, unused, missingTotal: missing.length, missing };
}

function server() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/v1/me")) return Response.json(ME);
    if (!url.startsWith("http://api.test/")) {
      calls.push({ name: `other:${url}`, input: null });
      return Response.json({}, { status: 404 });
    }
    if (url.includes("/v1/approvals/")) return Response.json({ ok: true, data: { status: approvalAnswers.shift() ?? "pending" } });
    const name = url.split("/v1/ops/")[1]!;
    const body = JSON.parse(String(init?.body));
    calls.push({ name, input: body.input, ...(body.approval ? { approval: body.approval } : {}) });
    if (name === "strings.apps.list") return Response.json({ ok: true, data: { items: [APP] } });
    if (name === "strings.keys.usage") return Response.json({ ok: true, data: usage(body.input) });
    if (name === "strings.check")
      return Response.json({ ok: true, data: { keys: 5, checked: 5, nextCursor: null, problems: [{ namespace: "nav", key: "home", locale: "tr", reason: "icu", message: "not valid ICU\u001b]8;;https://evil.test\u0007" }] } });
    if (name === "strings.keys.delete") {
      if (body.approval !== APPROVAL.id) return Response.json({ ok: false, error: { code: "APPROVAL_REQUIRED", message: "ask" }, approval: APPROVAL }, { status: 428 });
      return Response.json({ ok: true, data: { deleted: body.input.keyIds.length } });
    }
    return Response.json({ ok: false, error: { code: "NOT_FOUND", message: name } }, { status: 404 });
  }) as typeof fetch;
}

/** The code: nav.home used, plans.${id}.name dynamic, a translator bound to footer reading t.raw("links")... */
const CODE: Issue[] = [
  issue({ key: "nav.home", bindingType: "root-scoped" }),
  issue({ key: "plans.${id}.name", isDynamic: true, pattern: "plans.${id}.name" }),
  issue({ key: "footer.links", bindingType: "root-scoped" }),
  issue({ key: "nav.gone", bindingType: "root-scoped" }),
];
const scan = (issues: Issue[]) => async () => ({ issues, files: 3 });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lefine-usage-"));
  process.env.LEFINE_HOME = join(dir, "home");
  process.env.LEFINE_TOKEN = "lfn_test_token_value";
  process.env.LEFINE_API_URL = "http://api.test";
  logs = [];
  calls = [];
  approvalAnswers = ["approved"];
  console.log = (...a: unknown[]) => void logs.push(a.join(" ").replace(/\u001b\[[0-9;]*m/g, ""));
  console.error = (...a: unknown[]) => void logs.push(a.join(" ").replace(/\u001b\[[0-9;]*m/g, ""));
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

/** The app, in this test's directory (read when called: dir is set in beforeEach). */
const opts = {
  project: "acme/web",
  get dir() {
    return dir;
  },
};
const text = () => logs.join("\n");
const usageCalls = () => calls.filter((c) => c.name === "strings.keys.usage");

describe("what the scan sends", () => {
  it("full keys as written, dynamic keys as patterns, bound namespaces as prefixes, partial keys as patterns under any prefix", () => {
    const q = usageQuery([
      ...CODE,
      issue({ key: "title", bindingType: "bound-scoped", namespace: "hero" }),
      issue({ key: "cta", bindingType: "unknown-scoped" }),
      issue({ key: "${k}", isDynamic: true, pattern: "${k}" }),
    ]);
    expect(q.codeKeys).toEqual(["nav.home", "footer.links", "nav.gone", "title"]);
    expect(q.patterns).toEqual(["plans.*.name", "*.cta", "*.*.cta", "*.*.*.cta"]);
    expect(q.prefixes).toEqual(["hero"]);
    // t(key) could be any key: not sent (it would match everything), and reported.
    expect(q.skipped).toEqual(["${k}"]);
  });

  it("toPattern: one * per run-time part, and nothing that is only * and dots", () => {
    expect(toPattern("a.${x}${y}.b")).toBe("a.*.b");
    expect(toPattern("${ns}.${k}")).toBeNull();
    expect(toPattern("plain")).toBeNull();
  });
});

describe("lefine strings unused", () => {
  it("lists the keys the code never uses; an object read (t.raw) is not missing and covers its children", async () => {
    await stringsUnusedCommand(opts, { scan: scan(CODE) });
    const out = logs.join("\n");
    expect(out).toContain("1 of 5 keys are not used");
    expect(out).toContain("nav.old");
    expect(out).not.toContain("footer.links.a");
    // The second call asked the missing names as prefixes: footer.links reads an object.
    expect(usageCalls().map((c) => c.input.prefixes)).toEqual([[], ["footer.links", "nav.gone"]]);
  });

  it("--ci exits 1 when a key is unused; --json prints the server's answer", async () => {
    await expect(stringsUnusedCommand({ ...opts, ci: true, json: true }, { scan: scan(CODE) })).rejects.toThrow("exit:1");
    const json = JSON.parse(logs.find((l) => l.startsWith("{"))!);
    expect(json.unused).toEqual([{ keyId: "key_2", namespace: "nav", key: "old" }]);
    expect(json.unusedTotal).toBe(1);
  });

  it("--delete asks here (--yes in CI), then a person approves in Lefine; the CLI waits and deletes", async () => {
    await expect(stringsUnusedCommand({ ...opts, delete: true }, { scan: scan(CODE) })).rejects.toThrow("exit:1");
    expect(logs.join("\n")).toContain("needs confirmation. Run it again with --yes");
    expect(calls.some((c) => c.name === "strings.keys.delete")).toBe(false);

    logs = [];
    const opened: string[] = [];
    await stringsUnusedCommand({ ...opts, delete: true, yes: true }, { scan: scan(CODE), openBrowser: (u) => opened.push(u), sleep: async () => {} });
    // A fake id on another host than the API: printed, never opened (approvalUrlToOpen).
    expect(opened).toEqual([]);
    expect(logs.join("\n")).toContain(APPROVAL.url);
    expect(logs.join("\n")).toContain("Deleting keys cannot be undone, so a person approves it in Lefine");
    expect(calls.filter((c) => c.name === "strings.keys.delete").map((c) => [c.input.keyIds, c.approval])).toEqual([
      [["key_2"], undefined],
      [["key_2"], "apr_1"],
    ]);
    expect(logs.join("\n")).toContain("Deleted 1 keys.");
  });

  it("nobody answers in time: the error gives the link and the --approval rerun; the rerun deletes without waiting", async () => {
    approvalAnswers = [];
    let t = 0;
    await expect(
      stringsUnusedCommand({ ...opts, delete: true, yes: true }, { scan: scan(CODE), openBrowser: () => {}, sleep: async () => {}, now: () => (t += 60_000), approvalWaitMs: 100_000 }),
    ).rejects.toThrow("exit:1");
    expect(logs.join("\n")).toContain("run this again with --approval apr_1");

    calls = [];
    await stringsUnusedCommand({ ...opts, delete: true, yes: true, approval: "apr_1" }, { scan: scan(CODE) });
    expect(calls.filter((c) => c.name === "strings.keys.delete").map((c) => c.approval)).toEqual(["apr_1"]);
  });
});

describe("lefine strings missing", () => {
  it("names in the code with no key in Lefine; exit 1", async () => {
    await expect(stringsMissingCommand(opts, { scan: scan(CODE) })).rejects.toThrow("exit:1");
    const out = logs.join("\n");
    expect(out).toContain("1 names in the code have no key in Lefine");
    expect(out).toContain("nav.gone");
    expect(out).not.toContain("footer.links");
  });

  it("all there: exit 0", async () => {
    await stringsMissingCommand(opts, { scan: scan([issue({ key: "nav.home", bindingType: "root-scoped" })]) });
    expect(logs.join("\n")).toContain("Every key the code names exists in Web");
  });
});

describe("lefine doctor", () => {
  it("one report: hard-coded text from the code scan, the server's checks, missing and unused keys, and a score", async () => {
    mkdirSync(join(dir, "src"));
    writeFileSync(
      join(dir, "src", "page.tsx"),
      'import { useTranslations } from "next-intl";\nexport function Page() {\n  const t = useTranslations();\n  return <main><h1>{t("nav.home")}</h1><p>{t("nav.gone")}</p><p>Hard-coded welcome text</p></main>;\n}\n',
    );
    await expect(lefineDoctorCommand({ ...opts, json: true, threshold: "99" })).rejects.toThrow("exit:1");
    const report = JSON.parse(logs.find((l) => l.trimStart().startsWith("{"))!);
    const rules = new Set(report.diagnostics.map((d: { rule: string }) => d.rule));
    expect(rules).toContain("lefine-check");
    expect(rules).toContain("missing-in-remote");
    expect(rules).toContain("unused-remote-key");
    // The local code rules (Better's analyzer): the hard-coded paragraph.
    expect(report.diagnostics.some((d: { category: string; message: string }) => d.category === "Code" && /Hard-coded welcome text/.test(d.message))).toBe(true);
    expect(report.missingTotal).toBe(1);
    expect(report.score.total).toBeLessThan(100);
    expect(report.score.passThreshold).toBe(99);
  }, 30_000);

  it("prints server and code text without escape sequences, and reads no CDN a project config names", async () => {
    writeFileSync(join(dir, "i18n.config.ts"), 'export const project = "acme/web";\nexport const i18nWorkspaceConfig = { cdnBaseUrl: "http://169.254.169.254" };\n');
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "page.tsx"), 'export function Page() {\n  return <p>Plain text</p>;\n}\n');
    await lefineDoctorCommand({ ...opts, verbose: true, threshold: "0" });
    expect(text()).not.toContain("\u001b]8");
    expect(text()).toContain("not valid ICU");
    expect(calls.filter((c) => c.name.startsWith("other:"))).toEqual([]);
  }, 30_000);

  it("--threshold must be 0 to 100", async () => {
    await expect(lefineDoctorCommand({ ...opts, threshold: "abc" })).rejects.toThrow("exit:1");
    expect(logs.join("\n")).toContain("--threshold takes a whole number from 0 to 100");
  });
});
