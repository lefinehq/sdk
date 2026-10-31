import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loginCommand, logoutCommand, whoamiCommand } from "../auth-commands.js";
import { credentialsPath, loadCredentials, resolveLefineAuth } from "../credentials.js";

const realFetch = globalThis.fetch;
const realExit = process.exit;
const realLog = console.log;
const realErr = console.error;
let home: string;
let logs: string[];

const WORKSPACE = { id: "ws_1", slug: "acme", name: "Acme" };
const TOKEN = "lfn_test_token_value";

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lefine-home-"));
  process.env.LEFINE_HOME = join(home, ".lefine");
  delete process.env.LEFINE_TOKEN;
  delete process.env.LEFINE_API_URL;
  logs = [];
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
  rmSync(home, { recursive: true, force: true });
});

const json = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

/** Device endpoints answering the given token responses in order. */
function deviceServer(tokenReplies: Array<{ status: number; body: unknown }>) {
  const polls: number[] = [];
  globalThis.fetch = ((input: RequestInfo | URL) => {
    const url = String(input);
    if (url.endsWith("/v1/device/code")) {
      return json({
        device_code: "dev123",
        user_code: "ABCD-EFGH",
        verification_uri: "https://dash.example/device",
        verification_uri_complete: "https://dash.example/device?code=ABCD-EFGH",
        expires_in: 600,
        interval: 5,
      });
    }
    if (url.endsWith("/v1/device/token")) {
      const reply = tokenReplies.shift()!;
      polls.push(reply.status);
      return json(reply.body, reply.status);
    }
    return Promise.resolve(new Response("nope", { status: 404 }));
  }) as typeof fetch;
  return polls;
}

describe("lefine login (device flow)", () => {
  it("polls through pending and slow_down (+5s), then saves the key with mode 0600", async () => {
    deviceServer([
      { status: 400, body: { error: "authorization_pending" } },
      { status: 400, body: { error: "slow_down" } },
      { status: 400, body: { error: "authorization_pending" } },
      { status: 200, body: { access_token: TOKEN, token_type: "bearer", workspace: WORKSPACE, scopes: ["strings:read", "strings:write"] } },
    ]);
    const waits: number[] = [];
    let opened = "";
    await loginCommand(
      { apiUrl: "http://api.test" },
      { sleep: async (ms) => void waits.push(ms), openBrowser: (u) => (opened = u), now: () => 0 },
    );

    // interval 5s, then 5s, 5s after slow_down it becomes 10s, 10s.
    expect(waits).toEqual([5000, 5000, 10000, 10000]);
    expect(opened).toBe("https://dash.example/device?code=ABCD-EFGH");
    expect(logs.join("\n")).toContain("ABCD-EFGH");

    const file = credentialsPath();
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".lefine")).mode & 0o777).toBe(0o700);
    const saved = loadCredentials()!;
    expect(saved.token).toBe(TOKEN);
    expect(saved.workspace.slug).toBe("acme");
    expect(saved.apiUrl).toBe("http://api.test");
    expect(saved.scopes).toEqual(["strings:read", "strings:write"]);
    expect(typeof saved.savedAt).toBe("string");
    // The token is never printed.
    expect(logs.join("\n")).not.toContain(TOKEN);
  });

  it("exits 1 with a plain message when access is denied, and saves nothing", async () => {
    deviceServer([{ status: 400, body: { error: "access_denied" } }]);
    await expect(
      loginCommand({ apiUrl: "http://api.test" }, { sleep: async () => {}, openBrowser: () => {}, now: () => 0 }),
    ).rejects.toThrow("exit:1");
    expect(logs.join("\n")).toContain("denied");
    expect(existsSync(credentialsPath())).toBe(false);
  });

  it("gives up when the code expires", async () => {
    deviceServer([{ status: 400, body: { error: "expired_token" } }]);
    await expect(
      loginCommand({ apiUrl: "http://api.test", json: true }, { sleep: async () => {}, openBrowser: () => {}, now: () => 0 }),
    ).rejects.toThrow("exit:1");
    expect(JSON.parse(logs.at(-1)!)).toMatchObject({ ok: false });
  });

  it("--token verifies the key against /v1/me before saving", async () => {
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("http://api.test/v1/me");
      expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
      return json({ user: { email: "a@b.c" }, workspace: { ...WORKSPACE, modules: {} }, scopes: ["strings:read"], apps: [] });
    }) as typeof fetch;
    await loginCommand({ token: TOKEN, apiUrl: "http://api.test" });
    expect(loadCredentials()!.token).toBe(TOKEN);
    expect(statSync(credentialsPath()).mode & 0o777).toBe(0o600);
  });

  it("--token with a bad key saves nothing", async () => {
    globalThis.fetch = (() => json({ error: "no" }, 401)) as typeof fetch;
    await expect(loginCommand({ token: "lfn_bad", apiUrl: "http://api.test" })).rejects.toThrow("exit:1");
    expect(existsSync(credentialsPath())).toBe(false);
  });
});

describe("lefine logout / whoami", () => {
  it("logout deletes the file", async () => {
    globalThis.fetch = (() => json({ user: {}, workspace: WORKSPACE, scopes: [], apps: [] })) as typeof fetch;
    await loginCommand({ token: TOKEN, apiUrl: "http://api.test" });
    logoutCommand({});
    expect(existsSync(credentialsPath())).toBe(false);
  });

  it("whoami calls /v1/me with the stored key", async () => {
    globalThis.fetch = (() => json({ user: { email: "a@b.c" }, workspace: WORKSPACE, scopes: ["strings:read"], apps: [{}] })) as typeof fetch;
    await loginCommand({ token: TOKEN, apiUrl: "http://api.test" });
    logs.length = 0;
    await whoamiCommand({ json: true });
    const body = JSON.parse(logs[0]!);
    expect(body).toMatchObject({ ok: true, source: "file", workspace: { slug: "acme" } });
    expect(readFileSync(credentialsPath(), "utf-8")).toContain(TOKEN);
    expect(logs.join("\n")).not.toContain(TOKEN);
  });

  it("whoami prints 'all' apps when the key is not limited to some (apps: null)", async () => {
    globalThis.fetch = (() => json({ user: { email: "a@b.c" }, workspace: WORKSPACE, scopes: ["strings:read"], apps: null })) as typeof fetch;
    await loginCommand({ token: TOKEN, apiUrl: "http://api.test" });
    logs.length = 0;
    await whoamiCommand({});
    expect(logs.join("\n")).toContain("Apps: all");
  });

  it("whoami without a key says to run lefine login", async () => {
    await expect(whoamiCommand({})).rejects.toThrow("exit:1");
    expect(logs.join("\n")).toContain("lefine login");
  });
});

describe("credential resolution", () => {
  it("LEFINE_TOKEN wins over the saved file", async () => {
    globalThis.fetch = (() => json({ user: {}, workspace: WORKSPACE, scopes: [], apps: [] })) as typeof fetch;
    await loginCommand({ token: TOKEN, apiUrl: "http://api.test" });
    process.env.LEFINE_TOKEN = "lfn_from_env";
    expect(resolveLefineAuth({})).toMatchObject({ token: "lfn_from_env", source: "env" });
    delete process.env.LEFINE_TOKEN;
    expect(resolveLefineAuth({})).toMatchObject({ token: TOKEN, source: "file", apiUrl: "http://api.test" });
  });
});

describe("when the CLI may open a browser", () => {
  it("only for a person at a terminal: never with LEFINE_NO_BROWSER, CI, a test runner or no TTY", async () => {
    const { browserAllowed } = await import("../auth-commands.js");
    expect(browserAllowed({}, true)).toBe(true);
    expect(browserAllowed({ LEFINE_NO_BROWSER: "0" }, true)).toBe(true);
    expect(browserAllowed({ CI: "false" }, true)).toBe(true);
    expect(browserAllowed({ LEFINE_NO_BROWSER: "1" }, true)).toBe(false);
    expect(browserAllowed({ CI: "true" }, true)).toBe(false);
    expect(browserAllowed({ NODE_ENV: "test" }, true)).toBe(false);
    expect(browserAllowed({}, false)).toBe(false);
    expect(browserAllowed({}, undefined)).toBe(false);
    // This test run itself: the preload (bunfig.toml) and bun test both keep it off.
    expect(browserAllowed()).toBe(false);
  });
});

describe("which approval page is opened", () => {
  const ID = "apr_0123456789abcdef0123456789abcdef";
  it("only a well-formed approval page on the API's own host (any port)", async () => {
    const { approvalUrlToOpen } = await import("../client.js");
    const link = (url: string, id = ID) => ({ id, url, expiresAt: "x" });
    expect(approvalUrlToOpen(link(`https://dash.lefine.ai/approvals/${ID}`), "https://dash.lefine.ai")).toBe(`https://dash.lefine.ai/approvals/${ID}`);
    expect(approvalUrlToOpen(link(`http://localhost:5173/approvals/${ID}`), "http://localhost:8787")).toBe(`http://localhost:5173/approvals/${ID}`);
    // A local server's approval never opens on production, nor production's on a local server.
    expect(approvalUrlToOpen(link(`https://dash.lefine.ai/approvals/${ID}`), "http://localhost:8787")).toBeNull();
    expect(approvalUrlToOpen(link(`https://evil.example/approvals/${ID}`), "https://dash.lefine.ai")).toBeNull();
    // The fake ids tests use (apr_1) and a path that is not the id's own page.
    expect(approvalUrlToOpen(link("https://dash.lefine.ai/approvals/apr_1", "apr_1"), "https://dash.lefine.ai")).toBeNull();
    expect(approvalUrlToOpen(link(`https://dash.lefine.ai/somewhere/${ID}`), "https://dash.lefine.ai")).toBeNull();
    expect(approvalUrlToOpen(link(`https://dash.lefine.ai/approvals/${ID}`), undefined)).toBeNull();
  });

  it("callWithApproval prints a foreign link but does not open it", async () => {
    const { callWithApproval, LefineError } = await import("../client.js");
    const opened: string[] = [];
    let first = true;
    const ops = {
      apiUrl: "http://localhost:8787",
      async callOp() {
        if (first) {
          first = false;
          throw new LefineError("APPROVAL_REQUIRED", "ask", { id: ID, url: `https://dash.lefine.ai/approvals/${ID}`, expiresAt: "x" });
        }
        return { ok: true };
      },
      async approvalStatus() {
        return "approved" as const;
      },
    };
    const lines: string[] = [];
    await callWithApproval(ops, "strings.releases.publish", {}, { openBrowser: (u) => opened.push(u), sleep: async () => {}, say: (l) => lines.push(l) });
    expect(opened).toEqual([]);
    expect(lines.join("\n")).toContain(`https://dash.lefine.ai/approvals/${ID}`);
  });
});
