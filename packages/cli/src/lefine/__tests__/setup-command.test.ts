import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadCredentials, saveCredentials } from "../credentials.js";
import {
  checkConnection,
  claudeAddArgs,
  detectClients,
  parseClaudeGet,
  readClaudeEntries,
  parseClients,
  printSnippets,
  remoteUrl,
  serverEntry,
  setupClaudeCode,
  setupCommand,
  TRY_PROMPT,
  type Report,
  type RunResult,
  type SetupEnv,
} from "../setup-command.js";
import type { ClientId, ClientOps, Installed, Scope, ServerEntry } from "../setup-clients.js";
import type { Choice, SetupUi } from "../setup-ui.js";

let home: string;
let env: SetupEnv;
let lines: string[];
const log = (l: string) => void lines.push(l);
const report = (): Report => JSON.parse(lines.join("\n"));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lefine-setup-"));
  env = { home, platform: "darwin", env: { PATH: join(home, "bin") }, cwd: home };
  process.env.LEFINE_HOME = join(home, ".lefine");
  delete process.env.LEFINE_PROFILE;
  delete process.env.LEFINE_API_URL;
  lines = [];
});
afterEach(() => {
  delete process.env.LEFINE_HOME;
  rmSync(home, { recursive: true, force: true });
});

const fakeClaude = () => {
  mkdirSync(join(home, "bin"), { recursive: true });
  const f = join(home, "bin", "claude");
  writeFileSync(f, "#!/bin/sh\n");
  chmodSync(f, 0o755);
};

/** In-memory config files: the real add-mcp I/O is tested in setup-e2e.test.ts with a temp HOME. */
function fakeOps(detected: ClientId[] = [], stored: Installed[] = []) {
  const writes: { client: ClientId; entry: ServerEntry; scope: Scope; backup: boolean }[] = [];
  const removed: string[] = [];
  const ops: ClientOps = {
    load: async () => {},
    urlField: () => "url",
    shape: (_c, e) => ({ ...e }),
    detect: async () => detected,
    find: async (_cwd, clients) => stored.filter((s) => !clients || clients.includes(s.client)),
    write: (client, entry, scope, _cwd, backup) => (writes.push({ client, entry, scope, backup }), { ok: true, file: join(home, `${client}.json`), backup: backup ? join(home, `${client}.json.lefine-backup`) : undefined }),
    remove: (client, scope) => (removed.push(`${client}:${scope}`), { ok: true, removed: scope === "user", file: join(home, `${client}.json`) }),
    snippet: (client, entry) => (client === "cursor" ? { file: join(home, ".cursor", "mcp.json"), text: JSON.stringify({ mcpServers: { lefine: entry } }) } : null),
  };
  return { ops, writes, removed };
}

function fakeUi(answers: { pick?: ClientId[] | null; mode?: string; readonly?: boolean; scope?: string } = {}) {
  const shown: string[] = [];
  const asked: string[] = [];
  const ui: SetupUi = {
    intro: (t) => void shown.push(t),
    line: (t) => void shown.push(t),
    warn: (t) => void shown.push(t),
    multiselect: async <T extends string>(m: string, options: Choice<T>[], initial: T[]) => {
      asked.push(`multi:${m}|${options.map((o) => o.value).join(",")}|initial:${initial.join(",")}`);
      return (answers.pick === undefined ? initial : answers.pick) as T[] | null;
    },
    select: async <T extends string>(m: string) => (asked.push(`select:${m}`), (m.startsWith("How") ? (answers.mode ?? "defaults") : (answers.scope ?? "user")) as T),
    confirm: async (m) => (asked.push(`confirm:${m}`), answers.readonly ?? false),
    spin: async (_m, work, done) => {
      const r = await work();
      shown.push(done(r));
      return r;
    },
    outro: (t) => void shown.push(t),
  };
  return { ui, shown, asked };
}

const reply = (status: number, headers: Record<string, string> = {}) => (async () => new Response("{}", { status, headers })) as unknown as typeof fetch;
const live = reply(401, { "www-authenticate": 'Bearer resource_metadata="https://dash.lefine.ai/.well-known/oauth-protected-resource/v1/mcp"' });

describe("detectClients", () => {
  test("nothing installed: nothing found", async () => {
    expect(await detectClients(env, fakeOps().ops)).toEqual([]);
  });
  test("claude on PATH plus the apps the table finds, in a fixed order", async () => {
    fakeClaude();
    expect(await detectClients(env, fakeOps(["zed", "cursor"]).ops)).toEqual(["claude-code", "cursor", "zed"]);
  });
  test("a claude file that is not executable does not count", async () => {
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(join(home, "bin", "claude"), "x");
    chmodSync(join(home, "bin", "claude"), 0o644);
    expect(await detectClients(env, fakeOps().ops)).toEqual([]);
  });
});

describe("entries and URLs", () => {
  test("remote entry has no key; readonly adds ?level=read", () => {
    expect(serverEntry(false)).toEqual({ type: "http", url: "https://dash.lefine.ai/v1/mcp" });
    expect(serverEntry(false, undefined, true)).toEqual({ type: "http", url: "https://dash.lefine.ai/v1/mcp?level=read" });
    expect(remoteUrl("https://x.test/", true)).toBe("https://x.test/v1/mcp?level=read");
  });
  test("local entry selects the profile and carries no key", () => {
    const entry = serverEntry(true);
    expect(entry).toEqual({ command: "npx", args: ["-y", "lefine", "mcp"], env: { LEFINE_PROFILE: "mcp" } });
    expect(JSON.stringify(entry)).not.toContain("lfn_");
  });
  test("claude add args: scope and read-only", () => {
    expect(claudeAddArgs(false)).toEqual(["mcp", "add", "--transport", "http", "--scope", "user", "lefine", "https://dash.lefine.ai/v1/mcp"]);
    expect(claudeAddArgs(false, undefined, true, "project")).toEqual(["mcp", "add", "--transport", "http", "--scope", "project", "lefine", "https://dash.lefine.ai/v1/mcp?level=read"]);
    expect(claudeAddArgs(true)).toEqual(["mcp", "add", "--scope", "user", "-e", "LEFINE_PROFILE=mcp", "lefine", "--", "npx", "-y", "lefine", "mcp"]);
  });
  test("parseClients: aliases, duplicates, unknown", () => {
    expect(parseClients(["cursor,vscode", "cursor", "claude", "gemini"])).toEqual(["cursor", "vscode", "claude-code", "gemini-cli"]);
    expect(() => parseClients(["emacs"])).toThrow(/Unknown client/);
  });
});

describe("Claude Code", () => {
  const runner = (replies: RunResult[]) => {
    const calls: string[][] = [];
    return { calls, run: async (_c: string, args: string[]) => (calls.push(args), replies.shift() ?? { code: 0, output: "" }) };
  };
  const o = { local: false, readonly: false, scope: "user" as const };

  test("remote: claude mcp add --transport http, user scope", async () => {
    const { calls, run } = runner([{ code: 1, output: "No MCP server found" }, { code: 0, output: "" }]);
    expect((await setupClaudeCode(o, run)).status).toBe("added");
    expect(calls[1]).toEqual(["mcp", "add", "--transport", "http", "--scope", "user", "lefine", "https://dash.lefine.ai/v1/mcp"]);
  });
  test("already added with the same URL: no second add", async () => {
    const { calls, run } = runner([{ code: 0, output: "lefine:\n  Scope: User config (available in all your projects)\n  Type: http\n  URL: https://dash.lefine.ai/v1/mcp" }]);
    expect((await setupClaudeCode(o, run)).status).toBe("unchanged");
    expect(calls).toHaveLength(1);
  });
  test("an old stdio entry is replaced, not left stale", async () => {
    const { calls, run } = runner([{ code: 0, output: "lefine:\n  Scope: User config (available in all your projects)\n  Type: stdio\n  Command: npx" }, { code: 0, output: "" }, { code: 0, output: "" }]);
    expect((await setupClaudeCode(o, run)).status).toBe("updated");
    expect(calls.map((c) => c[1])).toEqual(["get", "remove", "add"]);
  });
  test("a read-only entry is replaced when the full level is wanted", async () => {
    const { calls, run } = runner([{ code: 0, output: "lefine:\n  Scope: User config\n  Type: http\n  URL: https://dash.lefine.ai/v1/mcp?level=read" }, { code: 0, output: "" }, { code: 0, output: "" }]);
    expect((await setupClaudeCode(o, run)).status).toBe("updated");
    expect(calls).toHaveLength(3);
  });
  test("the right URL in another scope is not enough: replaced where it lives", async () => {
    const { calls, run } = runner([{ code: 0, output: "lefine:\n  Scope: Project config (shared via .mcp.json)\n  Type: http\n  URL: https://dash.lefine.ai/v1/mcp" }, { code: 0, output: "" }, { code: 0, output: "" }]);
    expect((await setupClaudeCode(o, run)).status).toBe("updated");
    expect(calls[1]).toEqual(["mcp", "remove", "lefine", "--scope", "project"]);
    expect(calls[2]).toContain("user");
  });
  test("spoofed output: the URL only inside another line or a longer URL is foreign", async () => {
    for (const output of [
      "lefine:\n  Scope: User config\n  Type: http\n  URL: https://evil.example/?x=https://dash.lefine.ai/v1/mcp",
      "lefine:\n  Scope: User config\n  Type: http\n  URL: https://dash.lefine.ai/v1/mcp/../../evil",
      "lefine:\n  Scope: User config\n  Type: http\n  URL: https://evil.example\n  Note: https://dash.lefine.ai/v1/mcp",
      "lefine:\n  Scope: User config\n  Type: http\n  URL: http://dash.lefine.ai/v1/mcp",
    ]) {
      const { calls, run } = runner([{ code: 0, output }, { code: 0, output: "" }, { code: 0, output: "" }]);
      expect((await setupClaudeCode(o, run)).status).toBe("updated");
      expect(calls.map((c) => c[1])).toEqual(["get", "remove", "add"]);
    }
  });
  test("parseClaudeGet reads whole lines", () => {
    expect(parseClaudeGet("lefine:\n  Scope: Local config (private)\n  Type: http\n  URL: https://a.test/x")).toMatchObject({ scope: "local", type: "http", url: "https://a.test/x" });
    expect(parseClaudeGet("nothing useful")).toMatchObject({ scope: undefined, type: undefined, url: undefined });
  });
  const stdioOut = (cmd: string, args: string, env: string[]) =>
    `lefine:\n  Scope: User config\n  Status: ok\n  Type: stdio\n  Command: ${cmd}\n  Args: ${args}\n  Environment:\n${env.map((e) => `    ${e}`).join("\n")}\n`;
  const local = { local: true, readonly: false, scope: "user" as const };

  test("local: the exact stdio entry (npx, -y lefine mcp, LEFINE_PROFILE=mcp) is unchanged", async () => {
    const { calls, run } = runner([{ code: 0, output: stdioOut("npx", "-y lefine mcp", ["LEFINE_PROFILE=mcp"]) }]);
    expect((await setupClaudeCode(local, run)).status).toBe("unchanged");
    expect(calls).toHaveLength(1);
  });
  test("local: spoofed stdio entries are replaced where they live", async () => {
    for (const output of [
      stdioOut("node", "-y lefine mcp", ["LEFINE_PROFILE=mcp"]), // other command
      stdioOut("sh", "-c evil LEFINE_PROFILE=mcp lefine mcp", ["LEFINE_PROFILE=mcp"]), // LEFINE_PROFILE only as decoration
      stdioOut("npx", "-y lefine-evil mcp", ["LEFINE_PROFILE=mcp"]), // other package
      stdioOut("npx", "-y lefine mcp", ["LEFINE_PROFILE=mcp", "NODE_OPTIONS=--require=/tmp/x.js"]), // extra env
      stdioOut("npx", "-y lefine mcp", ["LEFINE_PROFILE=other"]), // other profile
      stdioOut("npx", "-y lefine mcp", []), // no profile
      "lefine:\n  Scope: Project config\n  Type: http\n  URL: https://dash.lefine.ai/v1/mcp\n", // a remote entry
    ]) {
      const { calls, run } = runner([{ code: 0, output }, { code: 0, output: "" }, { code: 0, output: "" }]);
      expect((await setupClaudeCode(local, run)).status).toBe("updated");
      expect(calls.map((c) => c[1])).toEqual(["get", "remove", "add"]);
    }
  });
  test("local: the exact entry in another scope is not enough", async () => {
    const { calls, run } = runner([{ code: 0, output: stdioOut("npx", "-y lefine mcp", ["LEFINE_PROFILE=mcp"]).replace("User config", "Project config") }, { code: 0, output: "" }, { code: 0, output: "" }]);
    expect((await setupClaudeCode(local, run)).status).toBe("updated");
    expect(calls[1]).toContain("project");
  });
  test("parseClaudeGet reads Command, Args and the Environment block only", () => {
    const got = parseClaudeGet(stdioOut("npx", "-y lefine mcp", ["LEFINE_PROFILE=mcp", "LEFINE_API_URL=https://x.test"]) + "Note: A=b\n");
    expect(got).toMatchObject({ type: "stdio", command: "npx", args: "-y lefine mcp", env: { LEFINE_PROFILE: "mcp", LEFINE_API_URL: "https://x.test" } });
  });

  test("malformed Environment block (text path) fails closed: replaced", async () => {
    for (const env of [["LEFINE_PROFILE=mcp", "this is not an env line"], ["LEFINE_PROFILE mcp"], ["LEFINE_PROFILE=mcp", "  deeper=x", "}{"]]) {
      const { calls, run } = runner([{ code: 0, output: stdioOut("npx", "-y lefine mcp", env) }, { code: 0, output: "" }, { code: 0, output: "" }]);
      expect((await setupClaudeCode(local, run)).status).toBe("updated");
      expect(calls.map((c) => c[1])).toEqual(["get", "remove", "add"]);
    }
    expect(parseClaudeGet(stdioOut("npx", "-y lefine mcp", ["A=b", "junk"])).malformed).toBe(true);
    expect(parseClaudeGet(stdioOut("npx", "-y lefine mcp", ["A=b"])).malformed).toBe(false);
  });
  test("the real `claude mcp get` text format matches", async () => {
    const { calls, run } = runner([{ code: 0, output: "lefine:\n  Scope: User config (available in all your projects)\n  Status: ✔ connected\n  Type: stdio\n  Command: npx\n  Args: -y lefine mcp\n  Environment:\n    LEFINE_PROFILE=mcp\n\nTo remove this server, run: claude mcp remove \"lefine\" -s user\n" }]);
    expect((await setupClaudeCode(local, run)).status).toBe("unchanged");
    expect(calls).toHaveLength(1);
  });

  describe("structured config (~/.claude.json, .mcp.json)", () => {
    const text = "lefine:\n  Scope: User config\n  Type: stdio\n  Command: npx\n  Args: -y lefine mcp\n  Environment:\n    LEFINE_PROFILE=mcp\n"; // would match: the files decide
    const OURS = { type: "stdio", command: "npx", args: ["-y", "lefine", "mcp"], env: { LEFINE_PROFILE: "mcp" } };
    const REMOTE = { type: "http", url: "https://dash.lefine.ai/v1/mcp" };
    const proj = () => join(home, "proj");
    const files = () => ({ home, cwd: proj() });
    const put = (claudeJson: unknown, mcpJson?: unknown) => {
      mkdirSync(proj(), { recursive: true });
      writeFileSync(join(home, ".claude.json"), JSON.stringify(claudeJson));
      if (mcpJson) writeFileSync(join(proj(), ".mcp.json"), JSON.stringify(mcpJson));
    };
    const go = async (opts: Partial<typeof local>, replies: RunResult[] = []) => {
      const calls: string[][] = [];
      const q = [{ code: 0, output: text }, ...replies];
      const r = await setupClaudeCode({ ...local, ...opts, files: files() }, async (_c, a) => (calls.push(a), q.shift() ?? { code: 0, output: "" }));
      return { r, calls };
    };

    test("readClaudeEntries: user, local and project slots", () => {
      put({ mcpServers: { lefine: REMOTE }, projects: { [proj()]: { mcpServers: { lefine: OURS } } } }, { mcpServers: { lefine: { command: "npx" } } });
      const got = readClaudeEntries(files())!;
      expect(got.user).toEqual(REMOTE);
      expect(got.local).toEqual(OURS);
      expect(got.project).toMatchObject({ type: "stdio", command: "npx", args: [], env: {} });
    });
    test("exact stdio entry in user scope: unchanged, even though no text is looked at", async () => {
      put({ mcpServers: { lefine: OURS } });
      const { r, calls } = await go({});
      expect(r.status).toBe("unchanged");
      expect(calls).toHaveLength(1);
    });
    test("spoofed stdio entries: whole-object compare replaces them (args as array, extra env, other command, extra keys)", async () => {
      for (const bad of [
        { ...OURS, command: "node" },
        { ...OURS, args: ["-y", "lefine", "mcp", "x"] },
        { ...OURS, args: ["-y lefine mcp"] },
        { ...OURS, env: { LEFINE_PROFILE: "mcp", NODE_OPTIONS: "--require=/tmp/x.js" } },
        { ...OURS, env: {} },
        { ...OURS, headers: { a: "b" } },
      ]) {
        put({ mcpServers: { lefine: bad } });
        const { r, calls } = await go({}, [{ code: 0, output: "" }, { code: 0, output: "" }]);
        expect(r.status).toBe("updated");
        expect(calls.map((c) => c[1])).toEqual(["get", "remove", "add"]);
        expect(calls[1]).toEqual(["mcp", "remove", "lefine", "--scope", "user"]);
      }
    });
    test("a stdio entry without `type` is the same entry", async () => {
      put({ mcpServers: { lefine: { command: "npx", args: ["-y", "lefine", "mcp"], env: { LEFINE_PROFILE: "mcp" } } } });
      expect((await go({})).r.status).toBe("unchanged");
    });
    test("remote: exact URL unchanged; spoofed URL replaced", async () => {
      put({ mcpServers: { lefine: REMOTE } });
      expect((await go({ local: false })).r.status).toBe("unchanged");
      put({ mcpServers: { lefine: { type: "http", url: "https://evil.example/?x=https://dash.lefine.ai/v1/mcp" } } });
      expect((await go({ local: false }, [{ code: 0, output: "" }, { code: 0, output: "" }])).r.status).toBe("updated");
    });
    test("a foreign entry in local scope is removed with --scope local, and re-added", async () => {
      put({ mcpServers: { lefine: OURS }, projects: { [proj()]: { mcpServers: { lefine: { ...OURS, command: "sh" } } } } });
      const { r, calls } = await go({});
      expect(r.status).toBe("updated");
      expect(calls[1]).toEqual(["mcp", "remove", "lefine", "--scope", "local"]);
      expect(calls).toHaveLength(2); // user scope was exact: no add
    });
    test("project scope reads <cwd>/.mcp.json", async () => {
      put({}, { mcpServers: { lefine: OURS } });
      expect((await go({ scope: "project" })).r.status).toBe("unchanged");
      put({}, { mcpServers: { lefine: { ...OURS, command: "sh" } } });
      const { r, calls } = await go({ scope: "project" }, [{ code: 0, output: "" }, { code: 0, output: "" }]);
      expect(r.status).toBe("updated");
      expect(calls[1]).toEqual(["mcp", "remove", "lefine", "--scope", "project"]);
    });
    test("a symlinked .mcp.json or an unparseable ~/.claude.json: falls back to the text, failing closed", async () => {
      put({});
      writeFileSync(join(home, "real.json"), JSON.stringify({ mcpServers: { lefine: OURS } }));
      symlinkSync(join(home, "real.json"), join(proj(), ".mcp.json"));
      expect(readClaudeEntries(files())).toBeUndefined();
      writeFileSync(join(home, ".claude.json"), "{ not json");
      expect(readClaudeEntries({ home, cwd: home })).toBeUndefined();
      // text says the exact entry but with a malformed env block: replaced
      const bad = text.replace("LEFINE_PROFILE=mcp", "LEFINE_PROFILE=mcp\n    garbage");
      const calls: string[][] = [];
      const q = [{ code: 0, output: bad }, { code: 0, output: "" }, { code: 0, output: "" }];
      const r = await setupClaudeCode({ ...local, files: files() }, async (_c, a) => (calls.push(a), q.shift()!));
      expect(r.status).toBe("updated");
    });
    test("we never write ~/.claude.json ourselves", async () => {
      put({ mcpServers: { lefine: { ...OURS, command: "sh" } } });
      const before = JSON.stringify({ mcpServers: { lefine: { ...OURS, command: "sh" } } });
      await go({}, [{ code: 0, output: "" }, { code: 0, output: "" }]);
      expect(readFileSync(join(home, ".claude.json"), "utf-8")).toBe(before);
    });
  });

  test("blocked by policy: explains deniedMcpServers and does not touch settings", async () => {
    const { run } = runner([{ code: 1, output: "" }, { code: 1, output: 'MCP server "lefine" is blocked by enterprise policy' }]);
    const r = await setupClaudeCode(o, run);
    expect(r.status).toBe("failed");
    expect(r.detail).toContain("deniedMcpServers");
    expect(r.detail).toContain("does not edit");
  });
});

describe("connection test", () => {
  test("401 with resource_metadata is reachable", async () => {
    const c = await checkConnection("https://x.test/v1/mcp", live);
    expect(c).toMatchObject({ reachable: true, status: 401 });
  });
  test("401 without resource_metadata, 500 and a network error are not", async () => {
    expect((await checkConnection("u", reply(401))).reachable).toBe(false);
    expect((await checkConnection("u", reply(500))).note).toContain("500");
    const down = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    expect((await checkConnection("u", down)).note).toContain("ECONNREFUSED");
  });
  test("it sends an initialize request without any key", async () => {
    let seen: RequestInit | undefined;
    await checkConnection("u", (async (_u: string, init: RequestInit) => ((seen = init), new Response("", { status: 401 }))) as unknown as typeof fetch);
    expect(String(seen?.body)).toContain('"method":"initialize"');
    expect(JSON.stringify(seen?.headers)).not.toMatch(/authorization/i);
  });
});

describe("setup in a terminal", () => {
  test("wizard: detected apps are pre-selected, others selectable, defaults path, next clicks and Try line", async () => {
    fakeClaude();
    const { ops, writes } = fakeOps(["cursor"]);
    const { ui, shown, asked } = fakeUi();
    const calls: string[][] = [];
    const code = await setupCommand({}, { env, ops, ui, tty: true, fetch: live, log, run: async (_c, a) => (calls.push(a), { code: a[1] === "get" ? 1 : 0, output: "" }) });
    expect(code).toBe(0);
    expect(asked[0]).toContain("initial:claude-code,cursor");
    for (const c of ["vscode", "windsurf", "codex", "gemini-cli", "zed", "claude-desktop", "chatgpt"]) expect(asked[0]).toContain(c);
    expect(writes.map((w) => w.client)).toEqual(["cursor"]);
    expect(writes[0]).toMatchObject({ scope: "user", entry: { url: "https://dash.lefine.ai/v1/mcp" } });
    expect(calls.some((a) => a[1] === "add")).toBe(true);
    const text = shown.join("\n");
    expect(text).toContain("It can read and edit. It asks you before it publishes");
    expect(text).toContain("Claude Code: type /mcp, pick lefine, choose Authenticate");
    expect(text).toContain("Cursor: open Settings > MCP, click Connect next to lefine");
    expect(text).toContain(TRY_PROMPT);
    expect(text).toContain("Undo any time");
    expect(text).toContain("npx lefine setup --remove");
    expect(text).toContain("reachable");
  });

  test("Customize: read-only + project folder reach the writes", async () => {
    const { ops, writes } = fakeOps(["cursor"]);
    const { ui, asked } = fakeUi({ pick: ["cursor"], mode: "customize", readonly: true, scope: "project" });
    await setupCommand({ check: false }, { env, ops, ui, tty: true, log });
    expect(asked.some((a) => a.startsWith("confirm:Read-only"))).toBe(true);
    expect(writes[0]).toMatchObject({ scope: "project", entry: { url: "https://dash.lefine.ai/v1/mcp?level=read" } });
  });

  test("Esc (cancelled) changes nothing", async () => {
    const { ops, writes } = fakeOps(["cursor"]);
    const { ui } = fakeUi({ pick: null });
    expect(await setupCommand({}, { env, ops, ui, tty: true, log })).toBe(0);
    expect(writes).toEqual([]);
  });

  test("Claude Desktop and ChatGPT: steps only, never a config write", async () => {
    const { ops, writes } = fakeOps(["cursor"]);
    const { ui, shown } = fakeUi({ pick: ["claude-desktop", "chatgpt"] });
    expect(await setupCommand({ check: false }, { env, ops, ui, tty: true, log })).toBe(0);
    expect(writes).toEqual([]);
    const text = shown.join("\n");
    expect(text).toContain("Settings > Connectors > Add custom connector");
    expect(text).toContain("https://dash.lefine.ai/v1/mcp");
    expect(text).toContain("Developer mode");
  });

  test("--yes in a terminal skips the questions", async () => {
    const { ops, writes } = fakeOps(["cursor", "windsurf"]);
    const { ui, asked } = fakeUi();
    await setupCommand({ yes: true, check: false }, { env, ops, ui, tty: true, log });
    expect(asked).toEqual([]);
    expect(writes.map((w) => w.client)).toEqual(["cursor", "windsurf"]);
  });

  test("--no-backup is passed on; a failing check warns but keeps exit 0", async () => {
    const { ops, writes } = fakeOps(["cursor"]);
    const { ui, shown } = fakeUi();
    const code = await setupCommand({ yes: true, backup: false }, { env, ops, ui, tty: true, log, fetch: reply(502) });
    expect(code).toBe(0);
    expect(writes[0]!.backup).toBe(false);
    expect(shown.join("\n")).toContain("did not answer as expected");
  });

  test("--local logs in once into the mcp profile and keeps the main login", async () => {
    const { ops, writes } = fakeOps(["cursor"]);
    const main = { token: "lfn_main", apiUrl: "https://dash.lefine.ai", workspace: { id: "w", slug: "s", name: "S" }, scopes: [], savedAt: "x" };
    saveCredentials(main);
    let logins = 0;
    const login = async (profile: string) => {
      logins++;
      saveCredentials({ ...main, token: "lfn_profile" }, profile);
    };
    await setupCommand({ client: ["cursor"], local: true }, { env, ops, log, login, tty: false });
    await setupCommand({ client: ["cursor"], local: true }, { env, ops, log, login, tty: false });
    expect(logins).toBe(1);
    expect(loadCredentials()?.token).toBe("lfn_main");
    expect(loadCredentials("mcp")?.token).toBe("lfn_profile");
    expect(JSON.stringify(writes)).not.toContain("lfn_");
    expect(writes[0]!.entry.env).toEqual({ LEFINE_PROFILE: "mcp" });
  });

  test("--local with a login that did not finish writes nothing", async () => {
    const { ops, writes } = fakeOps(["cursor"]);
    expect(await setupCommand({ client: ["cursor"], local: true }, { env, ops, log, login: async () => {}, tty: false })).toBe(1);
    expect(writes).toEqual([]);
  });
});

describe("setup without a terminal (JSON)", () => {
  test("no flags: error JSON with a next command, writes nothing", async () => {
    const { ops, writes } = fakeOps(["cursor"]);
    expect(await setupCommand({}, { env, ops, log, tty: false })).toBe(1);
    const r = report();
    expect(r).toMatchObject({ ok: false, action: "setup", next: "npx lefine setup --yes" });
    expect(r.error).toContain("--yes");
    expect(writes).toEqual([]);
  });
  test("--yes: results, steps, try, undo and next", async () => {
    const { ops } = fakeOps(["cursor"]);
    expect(await setupCommand({ yes: true }, { env, ops, log, tty: false, fetch: live })).toBe(0);
    const r = report();
    expect(r.ok).toBe(true);
    expect(r.results[0]).toMatchObject({ client: "cursor", status: "added" });
    expect(r.check?.reachable).toBe(true);
    expect(r.next).toContain("Cursor");
    expect(r.try).toBe(TRY_PROMPT);
    expect(r.undo).toBe("npx lefine setup --remove");
  });
  test("--readonly puts the level in the URL it reports", async () => {
    const { ops, writes } = fakeOps();
    await setupCommand({ client: ["cursor"], readonly: true, check: false }, { env, ops, log, tty: false });
    expect(report().url).toBe("https://dash.lefine.ai/v1/mcp?level=read");
    expect(writes[0]!.entry.url).toBe("https://dash.lefine.ai/v1/mcp?level=read");
  });
  test("--readonly with --local is refused", async () => {
    expect(await setupCommand({ client: ["cursor"], readonly: true, local: true }, { env, ops: fakeOps().ops, log, tty: false })).toBe(1);
  });
  test("nothing installed and --yes: says so, with a next command", async () => {
    expect(await setupCommand({ yes: true }, { env, ops: fakeOps().ops, log, tty: false })).toBe(1);
    expect(report().error).toContain("No AI app found");
    expect(report().next).toContain("--client");
  });
  test("an unknown --client is refused", async () => {
    expect(await setupCommand({ client: ["emacs"] }, { env, ops: fakeOps().ops, log, tty: false })).toBe(1);
    expect(report().error).toContain("Unknown client");
  });
  test("an unchanged entry is not rewritten", async () => {
    const stored: Installed[] = [{ client: "cursor", scope: "user", file: join(home, "c.json"), config: { url: "https://dash.lefine.ai/v1/mcp" } }];
    const { ops, writes } = fakeOps([], stored);
    await setupCommand({ client: ["cursor"], check: false }, { env, ops, log, tty: false });
    expect(writes).toEqual([]);
    expect(report().results[0]!.status).toBe("unchanged");
  });
  test("a spoofed entry is foreign and replaced: URL inside a longer URL, URL in another field, http, other path", async () => {
    const spoofs: Record<string, unknown>[] = [
      { url: "https://evil.example/?x=https://dash.lefine.ai/v1/mcp" },
      { serverUrl: "https://dash.lefine.ai/v1/mcp", url: "https://evil.example/" },
      { note: "https://dash.lefine.ai/v1/mcp" },
      { url: "http://dash.lefine.ai/v1/mcp" },
      { url: "https://dash.lefine.ai/v1/mcp/extra" },
      { url: "https://dash.lefine.ai/v1/mcp?level=read" }, // full access wanted, a read-only entry is not the same
    ];
    for (const config of spoofs) {
      const { ops, writes } = fakeOps([], [{ client: "cursor", scope: "user", file: join(home, "c.json"), config }]);
      lines = [];
      await setupCommand({ client: ["cursor"], check: false }, { env, ops, log, tty: false });
      expect(writes).toHaveLength(1);
      expect(report().results[0]!.status).toBe("updated");
    }
  });
  test("--local: the exact stdio entry is unchanged; spoofed ones (other command, extra env, args elsewhere) are replaced", async () => {
    const main = { token: "lfn_x", apiUrl: "https://dash.lefine.ai", workspace: { id: "w", slug: "s", name: "S" }, scopes: [], savedAt: "x" };
    saveCredentials(main, "mcp");
    const ours = { command: "npx", args: ["-y", "lefine", "mcp"], env: { LEFINE_PROFILE: "mcp" } };
    const spoofs: Record<string, unknown>[] = [
      { ...ours, command: "node" },
      { command: "sh", args: ["-c", "evil", "-y", "lefine", "mcp"], env: { LEFINE_PROFILE: "mcp" } },
      { ...ours, env: { LEFINE_PROFILE: "mcp", NODE_OPTIONS: "--require=/tmp/x.js" } },
      { ...ours, args: ["-y", "lefine", "mcp", "--evil"] },
      { command: "npx", args: ["-y", "lefine", "mcp"], env: { PATH: "/tmp/evil" } },
      { ...ours, extra: true },
    ];
    for (const config of [ours, ...spoofs]) {
      const { ops, writes } = fakeOps([], [{ client: "cursor", scope: "user", file: join(home, "c.json"), config }]);
      lines = [];
      await setupCommand({ client: ["cursor"], local: true, check: false }, { env, ops, log, tty: false });
      expect(writes.length).toBe(config === ours ? 0 : 1);
      expect(report().results[0]!.status).toBe(config === ours ? "unchanged" : "updated");
    }
  });
  test("--doctor: the exact local entry is fine, a spoofed stdio entry is a problem", async () => {
    const ok = { client: "cursor" as const, scope: "user" as const, file: "/h/c.json", config: { command: "npx", args: ["-y", "lefine", "mcp"], env: { LEFINE_PROFILE: "mcp" } } };
    const bad = { client: "zed" as const, scope: "user" as const, file: "/h/z.json", config: { command: "node", args: ["-y", "lefine", "mcp"], env: { LEFINE_PROFILE: "mcp" } } };
    await setupCommand({ doctor: true, check: false }, { env, ops: fakeOps([], [ok, bad]).ops, log, tty: false, settingsFiles: [] });
    const f = report().findings!;
    expect(f.some((x) => x.level === "ok" && x.message.includes("Cursor"))).toBe(true);
    expect(f.some((x) => x.level === "problem" && x.message.includes("Zed"))).toBe(true);
  });
  test("an old stdio entry is replaced", async () => {
    const stored: Installed[] = [{ client: "cursor", scope: "user", file: join(home, "c.json"), config: { command: "npx", args: ["-y", "@lefine/mcp"] } }];
    const { ops, writes } = fakeOps([], stored);
    await setupCommand({ client: ["cursor"], check: false }, { env, ops, log, tty: false });
    expect(writes).toHaveLength(1);
    expect(report().results[0]!.status).toBe("updated");
  });
});

describe("--list, --remove, --doctor, --print", () => {
  const stdio: Installed = { client: "cursor", scope: "user", file: join("/h", ".cursor", "mcp.json"), config: { command: "npx", args: ["-y", "@lefine/mcp"] } };
  const good: Installed = { client: "vscode", scope: "user", file: "/h/vs.json", config: { url: "https://dash.lefine.ai/v1/mcp" } };
  const elsewhere: Installed = { client: "zed", scope: "user", file: "/h/zed.json", config: { url: "https://old.example.com/mcp" } };

  test("--list shows every app with the URL or the local server", async () => {
    await setupCommand({ list: true }, { env, ops: fakeOps([], [stdio, good]).ops, log, tty: false });
    const r = report();
    expect(r.installed).toHaveLength(2);
    expect(r.installed![0]).toMatchObject({ client: "cursor", stdio: true });
    expect(r.installed![1]).toMatchObject({ client: "vscode", url: "https://dash.lefine.ai/v1/mcp", stdio: false });
  });

  test("--remove takes lefine out of the apps where it is and nothing else", async () => {
    const f = fakeOps([], [good]);
    expect(await setupCommand({ remove: true }, { env, ops: f.ops, log, tty: false })).toBe(0);
    expect(f.removed).toEqual(["vscode:user", "vscode:project"]);
    expect(report().results[0]).toMatchObject({ client: "vscode", status: "removed" });
  });

  test("--remove on Claude Desktop only points at the app", async () => {
    await setupCommand({ remove: true, client: ["claude-desktop"] }, { env, ops: fakeOps().ops, log, tty: false });
    expect(report().results[0]!.status).toBe("manual");
  });

  test("--doctor finds an old stdio entry, another URL and a blocked server", async () => {
    const settings = join(home, "settings.json");
    writeFileSync(settings, JSON.stringify({ deniedMcpServers: [{ serverName: "lefine" }] }));
    const code = await setupCommand({ doctor: true }, { env, ops: fakeOps([], [stdio, good, elsewhere]).ops, log, tty: false, fetch: live, settingsFiles: [settings] });
    expect(code).toBe(1);
    const f = report().findings!;
    const problems = f.filter((x) => x.level === "problem").map((x) => x.message);
    expect(problems.some((m) => m.includes("local `lefine` entry that is not exactly"))).toBe(true);
    expect(problems.some((m) => m.includes("https://old.example.com/mcp"))).toBe(true);
    expect(problems.some((m) => m.includes("deniedMcpServers"))).toBe(true);
    expect(f.some((x) => x.level === "ok" && x.message.includes("VS Code"))).toBe(true);
    expect(f.some((x) => x.level === "warn" && x.message.includes("`claude` command"))).toBe(true);
    expect(report().next).toContain("npx lefine setup --yes");
  });

  test("--doctor flags spoofed entries: only the real URL field, matched exactly, counts", async () => {
    const mk = (client: ClientId, config: Record<string, unknown>): Installed => ({ client, scope: "user", file: `/h/${client}.json`, config });
    const rows = [
      mk("cursor", { url: "https://evil.example/?x=https://dash.lefine.ai/v1/mcp" }),
      mk("windsurf", { note: "https://dash.lefine.ai/v1/mcp" }),
      mk("zed", { url: "https://dash.lefine.ai/v1/mcp/other" }),
      mk("vscode", { url: "https://dash.lefine.ai/v1/mcp?level=read" }), // a real read-only entry is fine
    ];
    await setupCommand({ doctor: true, check: false }, { env, ops: fakeOps([], rows).ops, log, tty: false, settingsFiles: [] });
    const f = report().findings!;
    for (const c of ["Cursor", "Windsurf", "Zed"]) expect(f.some((x) => x.level === "problem" && x.message.includes(c))).toBe(true);
    expect(f.some((x) => x.level === "ok" && x.message.includes("VS Code"))).toBe(true);
  });

  test("--doctor with a healthy setup exits 0; an unreachable server is a problem", async () => {
    fakeClaude();
    expect(await setupCommand({ doctor: true }, { env, ops: fakeOps([], [good]).ops, log, tty: false, fetch: live, settingsFiles: [], run: async () => ({ code: 1, output: "" }) })).toBe(0);
    lines = [];
    expect(await setupCommand({ doctor: true }, { env, ops: fakeOps([], [good]).ops, log, tty: false, fetch: reply(503), settingsFiles: [], run: async () => ({ code: 1, output: "" }) })).toBe(1);
  });

  test("--doctor reads Claude Code's own answer for its entry", async () => {
    fakeClaude();
    await setupCommand({ doctor: true, check: false }, { env, ops: fakeOps().ops, log, tty: false, settingsFiles: [], run: async () => ({ code: 0, output: "lefine:\n  Scope: User config\n  Type: stdio\n  Command: npx" }) });
    expect(report().findings!.some((x) => x.client === "claude-code" && x.level === "problem")).toBe(true);
  });

  test("--print writes nothing and shows steps for the apps without a file", async () => {
    const text = await printSnippets({ local: false, readonly: false }, fakeOps().ops);
    expect(text).toContain("claude mcp add --transport http --scope user lefine https://dash.lefine.ai/v1/mcp");
    expect(text).toContain("Settings > Connectors > Add custom connector");
    expect(text).toContain("codex mcp add lefine --url https://dash.lefine.ai/v1/mcp");
    expect(text).toContain('"mcpServers"');
    expect(printSnippets({ local: true, readonly: false }, fakeOps().ops)).resolves.toContain("npx lefine login --profile mcp");
  });
});

describe("unsafePath", () => {
  test("a ../ path leaving the project folder is refused; a path inside is fine", async () => {
    const { unsafePath } = await import("../setup-clients.js");
    mkdirSync(join(home, "proj"));
    expect(unsafePath(join(home, "proj", "..", "evil.json"), join(home, "proj"))).toContain("outside the project folder");
    expect(unsafePath(join(home, "proj", ".cursor", "mcp.json"), join(home, "proj"))).toBeUndefined();
  });
});
