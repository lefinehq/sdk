import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ciTrustAddCommand, ciTrustListCommand, repositoryIdOf, workflowSnippet } from "../ci-commands.js";
import { forgetTradedKeys, githubActionsAuth, inGithubActionsWithOidc } from "../github-oidc.js";
import { openSession } from "../strings-commands.js";

const ENV = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "acme/web",
  ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.actions.test/idtoken?api-version=2.0",
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-request-token",
};
const GITHUB_JWT = "header.payload.signature";
const TRADED = "lfn_traded_key_value_0000000000000000000000000";

let calls: Array<{ url: string; init?: RequestInit }>;
let answer: { status: number; body: unknown };

const fakeFetch = async (url: string, init?: RequestInit) => {
  calls.push({ url, init });
  if (url.startsWith("https://pipelines.actions.test/")) return Response.json({ value: GITHUB_JWT });
  if (url.endsWith("/v1/oidc/github")) return Response.json(answer.body, { status: answer.status });
  return new Response("?", { status: 404 });
};

beforeEach(() => {
  calls = [];
  answer = { status: 200, body: { access_token: TRADED, token_type: "Bearer", expires_in: 900, app_id: "app_web1", scopes: ["strings:read", "strings:write"] } };
  forgetTradedKeys();
});

describe("githubActionsAuth", () => {
  it("outside GitHub Actions, or without id-token: write, does nothing", async () => {
    expect(inGithubActionsWithOidc({})).toBe(false);
    expect(inGithubActionsWithOidc({ ...ENV, ACTIONS_ID_TOKEN_REQUEST_TOKEN: "" })).toBe(false);
    expect(await githubActionsAuth("app_web1", {}, { fetch: fakeFetch, env: {} })).toBeNull();
    expect(calls).toEqual([]);
  });

  it("asks GitHub for the app's audience, trades the token at /v1/oidc/github, and keeps the key for the run", async () => {
    const auth = await githubActionsAuth("app_web1", { apiUrl: "http://api.test" }, { fetch: fakeFetch, env: ENV });
    expect(auth).toEqual({ token: TRADED, apiUrl: "http://api.test", source: "oidc" });
    const ask = new URL(calls[0]!.url);
    expect(ask.searchParams.get("audience")).toBe("lefine:app_web1");
    expect(ask.searchParams.get("api-version")).toBe("2.0");
    expect((calls[0]!.init!.headers as Record<string, string>).Authorization).toBe("bearer runner-request-token");
    expect(calls[1]!.url).toBe("http://api.test/v1/oidc/github");
    expect(JSON.parse(String(calls[1]!.init!.body))).toEqual({ appId: "app_web1", token: GITHUB_JWT });
    // The runner's request token never goes to Lefine.
    expect(JSON.stringify(calls[1])).not.toContain("runner-request-token");
    await githubActionsAuth("app_web1", { apiUrl: "http://api.test" }, { fetch: fakeFetch, env: ENV });
    expect(calls.length).toBe(2);
  });

  it("a refusal says how to set the trust up, and shows no token", async () => {
    answer = { status: 401, body: { error: "access_denied", error_description: "This GitHub token cannot sign in to this app." } };
    const err = await githubActionsAuth("app_web1", { apiUrl: "http://api.test" }, { fetch: fakeFetch, env: ENV }).catch((e: Error) => e);
    expect(String(err)).toContain("lefine ci trust add acme/web --project app_web1");
    expect(String(err)).not.toContain(GITHUB_JWT);
    expect(String(err)).not.toContain("runner-request-token");
  });

  it("no OIDC token from GitHub names the permission the job needs", async () => {
    const noToken = async (url: string) => (url.startsWith("https://pipelines") ? new Response("no", { status: 403 }) : fakeFetch(url));
    const err = await githubActionsAuth("app_web1", {}, { fetch: noToken, env: ENV }).catch((e: Error) => e);
    expect(String(err)).toContain("id-token: write");
  });
});

describe("openSession in GitHub Actions", () => {
  const realFetch = globalThis.fetch;
  const saved = { ...process.env };
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lefine-oidc-"));
    delete process.env.LEFINE_TOKEN;
    process.env.LEFINE_HOME = join(dir, "home");
    process.env.LEFINE_API_URL = "http://api.test";
    Object.assign(process.env, ENV);
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/v1/ops/strings.apps.list")) {
        calls.push({ url, init });
        return Response.json({ ok: true, data: { items: [{ id: "app_web1", slug: "web", name: "Web", sourceLocale: "en", targetLocales: [], keyCount: 0 }] } });
      }
      return fakeFetch(url, init);
    }) as typeof fetch;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    process.env = { ...saved };
    rmSync(dir, { recursive: true, force: true });
  });

  it("with no LEFINE_TOKEN signs in with the run's GitHub token for the app it names", async () => {
    const session = await openSession({ project: "app_web1", dir }, { appId: "app_web1", workspace: "", app: "app_web1", context: null, rootDir: dir });
    expect(session.appId).toBe("app_web1");
    const opCall = calls.find((c) => c.url.includes("/v1/ops/"))!;
    expect((opCall.init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${TRADED}`);
  });
});

describe("lefine ci trust", () => {
  it("finds the repository id with gh, else GitHub's API, else asks for --repository-id", async () => {
    expect(await repositoryIdOf("acme/web", "42")).toBe("42");
    await expect(repositoryIdOf("acme/web", "abc")).rejects.toThrow("numeric id");
    expect(await repositoryIdOf("acme/web", undefined, { gh: async () => "123456" })).toBe("123456");
    const api = async () => Response.json({ id: 777 });
    expect(await repositoryIdOf("acme/web", undefined, { gh: async () => null, fetch: api, env: {} })).toBe("777");
    const missing = async () => Response.json({ message: "Not Found" }, { status: 404 });
    await expect(repositoryIdOf("acme/secret", undefined, { gh: async () => null, fetch: missing, env: {} })).rejects.toThrow("--repository-id");
  });

  it("the workflow lines need id-token: write and no LEFINE_TOKEN", () => {
    const snippet = workflowSnippet("app_web1");
    expect(snippet).toContain("id-token: write");
    expect(snippet).toContain("--project app_web1");
    expect(snippet).not.toContain("secrets.");
  });

  describe("commands", () => {
    const realFetch = globalThis.fetch;
    const realExit = process.exit;
    const realLog = console.log;
    const realErr = console.error;
    const saved = { ...process.env };
    let logs: string[];
    let ops: Array<{ name: string; input: any; approval?: string }>;
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "lefine-ci-"));
      logs = [];
      ops = [];
      process.env.LEFINE_HOME = join(dir, "home");
      process.env.LEFINE_TOKEN = "lfn_test_token_value";
      process.env.LEFINE_API_URL = "http://api.test";
      delete process.env.GITHUB_ACTIONS;
      console.log = (...a: unknown[]) => void logs.push(a.join(" "));
      console.error = (...a: unknown[]) => void logs.push(a.join(" "));
      process.exit = ((code?: number) => {
        throw new Error(`exit:${code ?? 0}`);
      }) as typeof process.exit;
      const trust = { id: "ght_1", appId: "app_web1", repository: "acme/web", repositoryId: "123456", ref: "refs/heads/main", environment: null, scopes: ["strings:read", "strings:write"], audience: "lefine:app_web1", lastUsedAt: null };
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes("/v1/approvals/")) return Response.json({ ok: true, data: { status: "approved" } });
        const name = url.split("/v1/ops/")[1]!;
        const body = JSON.parse(String(init?.body));
        ops.push({ name, input: body.input, ...(body.approval ? { approval: body.approval } : {}) });
        if (name === "strings.apps.list") return Response.json({ ok: true, data: { items: [{ id: "app_web1", slug: "web", name: "Web", sourceLocale: "en", targetLocales: [], keyCount: 0 }] } });
        if (name === "strings.ci.trusts.add" && !body.approval) {
          return Response.json({ ok: false, error: { code: "APPROVAL_REQUIRED", message: "ask" }, approval: { id: "apr_3", url: "https://dash.lefine.ai/approvals/apr_3", expiresAt: "x" } }, { status: 428 });
        }
        if (name === "strings.ci.trusts.add") return Response.json({ ok: true, data: trust });
        if (name === "strings.ci.trusts.list") return Response.json({ ok: true, data: { items: [trust] } });
        return Response.json({ ok: false, error: { code: "NOT_FOUND", message: "?" } }, { status: 404 });
      }) as typeof fetch;
    });
    afterEach(() => {
      globalThis.fetch = realFetch;
      process.exit = realExit;
      console.log = realLog;
      console.error = realErr;
      process.env = { ...saved };
      rmSync(dir, { recursive: true, force: true });
    });

    it("add: a branch name becomes refs/heads/..., a person approves, then the workflow lines are shown", async () => {
      await ciTrustAddCommand("acme/web", { project: "app_web1", dir, ref: "main" }, { gh: async () => "123456", openBrowser: () => {}, sleep: async () => {} });
      const adds = ops.filter((o) => o.name === "strings.ci.trusts.add");
      expect(adds.length).toBe(2);
      expect(adds[1]).toEqual({ name: "strings.ci.trusts.add", input: { appId: "app_web1", repository: "acme/web", repositoryId: "123456", level: "write", ref: "refs/heads/main" }, approval: "apr_3" });
      const text = logs.join("\n");
      expect(text).toContain("https://dash.lefine.ai/approvals/apr_3");
      expect(text).toContain("id-token: write");
    });

    it("add refuses a name that is not owner/name before any call", async () => {
      await expect(ciTrustAddCommand("not a repo", { project: "app_web1", dir })).rejects.toThrow("exit:1");
      expect(ops).toEqual([]);
    });

    it("list shows each trust and the audience", async () => {
      await ciTrustListCommand({ project: "app_web1", dir });
      const text = logs.join("\n");
      expect(text).toContain("ght_1");
      expect(text).toContain("acme/web");
      expect(text).toContain("lefine:app_web1");
    });
  });
});
