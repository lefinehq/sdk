import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeAddArgs,
  configPath,
  detectClients,
  mergeServer,
  parseClients,
  printSnippets,
  serverEntry,
  setupClaudeCode,
  setupCommand,
  type RunResult,
  type SetupEnv,
} from "../setup-command.js";
import { loadCredentials, saveCredentials } from "../credentials.js";

let home: string;
let env: SetupEnv;
let lines: string[];
const log = (l: string) => void lines.push(l);
const read = (f: string) => JSON.parse(readFileSync(f, "utf-8"));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lefine-setup-"));
  env = { home, platform: "darwin", env: { PATH: join(home, "bin") } };
  process.env.LEFINE_HOME = join(home, ".lefine");
  delete process.env.LEFINE_PROFILE;
  delete process.env.LEFINE_API_URL;
  lines = [];
});
afterEach(() => {
  delete process.env.LEFINE_HOME;
  delete process.env.LEFINE_PROFILE;
  rmSync(home, { recursive: true, force: true });
});

const fakeClaude = () => {
  mkdirSync(join(home, "bin"), { recursive: true });
  const f = join(home, "bin", "claude");
  writeFileSync(f, "#!/bin/sh\n");
  chmodSync(f, 0o755);
};

describe("detectClients", () => {
  test("nothing installed: nothing found", () => {
    expect(detectClients(env)).toEqual([]);
  });
  test("finds claude on PATH and the config folders of the apps", () => {
    fakeClaude();
    mkdirSync(join(home, ".cursor"), { recursive: true });
    mkdirSync(join(home, "Library", "Application Support", "Claude"), { recursive: true });
    mkdirSync(join(home, "Library", "Application Support", "Code", "User"), { recursive: true });
    expect(detectClients(env)).toEqual(["claude-code", "cursor", "claude-desktop", "vscode"]);
  });
  test("a claude file that is not executable does not count", () => {
    mkdirSync(join(home, "bin"), { recursive: true });
    writeFileSync(join(home, "bin", "claude"), "x");
    chmodSync(join(home, "bin", "claude"), 0o644);
    expect(detectClients(env)).toEqual([]);
  });
  test("config paths follow the platform", () => {
    const linux: SetupEnv = { home, platform: "linux", env: { PATH: "" } };
    expect(configPath("vscode", linux)).toBe(join(home, ".config", "Code", "User", "mcp.json"));
    const win: SetupEnv = { home, platform: "win32", env: { PATH: "", APPDATA: join(home, "Roaming") } };
    expect(configPath("claude-desktop", win)).toBe(join(home, "Roaming", "Claude", "claude_desktop_config.json"));
    expect(configPath("claude-code", env)).toBeNull();
  });
});

describe("mergeServer", () => {
  const file = () => join(home, ".cursor", "mcp.json");

  test("creates the file and the folder when there is none", () => {
    const r = mergeServer(file(), "cursor", serverEntry("cursor", false));
    expect(r.status).toBe("added");
    expect(read(file())).toEqual({ mcpServers: { lefine: { url: "https://dash.lefine.ai/v1/mcp" } } });
  });

  test("keeps other servers and other keys, and backs the file up once", () => {
    mkdirSync(join(home, ".cursor"));
    writeFileSync(file(), JSON.stringify({ theme: "x", mcpServers: { other: { command: "a" } } }));
    const r = mergeServer(file(), "cursor", serverEntry("cursor", false));
    expect(r).toMatchObject({ status: "added", backup: `${file()}.lefine-backup` });
    expect(read(file())).toEqual({ theme: "x", mcpServers: { other: { command: "a" }, lefine: { url: "https://dash.lefine.ai/v1/mcp" } } });
    expect(read(`${file()}.lefine-backup`)).toEqual({ theme: "x", mcpServers: { other: { command: "a" } } });

    // second change: the backup is the original, not overwritten
    mergeServer(file(), "cursor", serverEntry("cursor", true));
    expect(read(`${file()}.lefine-backup`)).toEqual({ theme: "x", mcpServers: { other: { command: "a" } } });
  });

  test("running it twice changes nothing the second time", () => {
    mergeServer(file(), "cursor", serverEntry("cursor", false));
    const before = readFileSync(file(), "utf-8");
    expect(mergeServer(file(), "cursor", serverEntry("cursor", false)).status).toBe("unchanged");
    expect(readFileSync(file(), "utf-8")).toBe(before);
  });

  test("replaces an old lefine entry only", () => {
    mkdirSync(join(home, ".cursor"));
    writeFileSync(file(), JSON.stringify({ mcpServers: { lefine: { url: "https://old" }, keep: { url: "k" } } }));
    expect(mergeServer(file(), "cursor", serverEntry("cursor", false)).status).toBe("updated");
    expect(read(file()).mcpServers.keep).toEqual({ url: "k" });
    expect(read(file()).mcpServers.lefine.url).toBe("https://dash.lefine.ai/v1/mcp");
  });

  test("leaves a file that is not plain JSON untouched", () => {
    mkdirSync(join(home, ".cursor"));
    writeFileSync(file(), '{\n // my servers\n "mcpServers": {}\n}');
    const r = mergeServer(file(), "cursor", serverEntry("cursor", false));
    expect(r.status).toBe("invalid");
    expect(readFileSync(file(), "utf-8")).toContain("// my servers");
    expect(existsSync(`${file()}.lefine-backup`)).toBe(false);
  });

  test("refuses when the servers key is not an object", () => {
    mkdirSync(join(home, ".cursor"));
    writeFileSync(file(), JSON.stringify({ mcpServers: [] }));
    expect(mergeServer(file(), "cursor", serverEntry("cursor", false)).status).toBe("invalid");
  });

  test("VS Code uses `servers` with a type", () => {
    const f = join(home, "vs.json");
    mergeServer(f, "vscode", serverEntry("vscode", false));
    expect(read(f)).toEqual({ servers: { lefine: { type: "http", url: "https://dash.lefine.ai/v1/mcp" } } });
  });

  test("local entry selects the profile and carries no key", () => {
    const entry = serverEntry("claude-desktop", true);
    expect(entry).toEqual({ command: "npx", args: ["-y", "lefine", "mcp"], env: { LEFINE_PROFILE: "mcp" } });
    expect(JSON.stringify(entry)).not.toContain("lfn_");
  });
});

describe("Claude Code", () => {
  const runner = (replies: RunResult[]) => {
    const calls: string[][] = [];
    return { calls, run: async (_c: string, args: string[]) => (calls.push(args), replies.shift() ?? { code: 0, output: "" }) };
  };

  test("remote: claude mcp add --transport http, user scope", async () => {
    const { calls, run } = runner([{ code: 1, output: "No MCP server found" }, { code: 0, output: "" }]);
    const o = await setupClaudeCode(false, undefined, run);
    expect(o.status).toBe("added");
    expect(calls[1]).toEqual(["mcp", "add", "--transport", "http", "--scope", "user", "lefine", "https://dash.lefine.ai/v1/mcp"]);
  });

  test("already added: no second add", async () => {
    const { calls, run } = runner([{ code: 0, output: "lefine: ..." }]);
    expect((await setupClaudeCode(false, undefined, run)).status).toBe("unchanged");
    expect(calls).toHaveLength(1);
  });

  test("blocked by policy: explains deniedMcpServers and does not touch settings", async () => {
    const { run } = runner([{ code: 1, output: "" }, { code: 1, output: "MCP server \"lefine\" is blocked by enterprise policy" }]);
    const o = await setupClaudeCode(false, undefined, run);
    expect(o.status).toBe("failed");
    expect(o.detail).toContain("deniedMcpServers");
    expect(o.detail).toContain("~/.claude/settings.json");
    expect(o.detail).toContain("does not edit");
  });

  test("local: stdio command with the profile", () => {
    expect(claudeAddArgs(true)).toEqual(["mcp", "add", "--scope", "user", "-e", "LEFINE_PROFILE=mcp", "lefine", "--", "npx", "-y", "lefine", "mcp"]);
  });
});

describe("setupCommand", () => {
  test("--yes sets up every detected app and prints the one approval line", async () => {
    fakeClaude();
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const calls: string[][] = [];
    const code = await setupCommand({ yes: true }, { env, log, run: async (_c, a) => (calls.push(a), { code: a[1] === "get" ? 1 : 0, output: "" }) });
    expect(code).toBe(0);
    expect(read(join(home, ".cursor", "mcp.json")).mcpServers.lefine.url).toBe("https://dash.lefine.ai/v1/mcp");
    expect(calls.some((a) => a[1] === "add")).toBe(true);
    expect(lines.join("\n")).toContain("Open Claude Code / Cursor and approve Lefine when it asks (pick your workspace).");
  });

  test("--client only touches that app", async () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    mkdirSync(join(home, "Library", "Application Support", "Code", "User"), { recursive: true });
    await setupCommand({ client: ["cursor"] }, { env, log });
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(true);
    expect(existsSync(join(home, "Library", "Application Support", "Code", "User", "mcp.json"))).toBe(false);
  });

  test("Claude Desktop remote: no url written, Connectors steps shown", async () => {
    mkdirSync(join(home, "Library", "Application Support", "Claude"), { recursive: true });
    await setupCommand({ client: ["claude-desktop"] }, { env, log });
    expect(existsSync(configPath("claude-desktop", env)!)).toBe(false);
    expect(lines.join("\n")).toContain("Connectors");
  });

  test("no flags and no terminal: asks for --yes, writes nothing", async () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    expect(await setupCommand({}, { env, log, tty: false })).toBe(1);
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
  });

  test("terminal: the chosen apps only", async () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    mkdirSync(join(home, "Library", "Application Support", "Code", "User"), { recursive: true });
    await setupCommand({}, { env, log, tty: true, choose: async () => ["vscode"] });
    expect(existsSync(join(home, "Library", "Application Support", "Code", "User", "mcp.json"))).toBe(true);
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
  });

  test("nothing installed: says so", async () => {
    expect(await setupCommand({ yes: true }, { env, log })).toBe(1);
    expect(lines.join("\n")).toContain("No AI app found");
  });

  test("--local logs in once into the mcp profile and keeps the main login", async () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    const main = { token: "lfn_main", apiUrl: "https://dash.lefine.ai", workspace: { id: "w", slug: "s", name: "S" }, scopes: [], savedAt: "x" };
    saveCredentials(main);
    let logins = 0;
    const login = async (profile: string) => {
      logins++;
      saveCredentials({ ...main, token: "lfn_profile" }, profile);
    };
    await setupCommand({ client: ["cursor"], local: true }, { env, log, login });
    await setupCommand({ client: ["cursor"], local: true }, { env, log, login });
    expect(logins).toBe(1); // second run reuses the profile
    expect(loadCredentials()?.token).toBe("lfn_main");
    expect(loadCredentials("mcp")?.token).toBe("lfn_profile");
    const cfg = readFileSync(join(home, ".cursor", "mcp.json"), "utf-8");
    expect(cfg).toContain("LEFINE_PROFILE");
    expect(cfg).not.toContain("lfn_");
  });

  test("--local with a login that did not finish writes nothing", async () => {
    mkdirSync(join(home, ".cursor"), { recursive: true });
    expect(await setupCommand({ client: ["cursor"], local: true }, { env, log, login: async () => {} })).toBe(1);
    expect(existsSync(join(home, ".cursor", "mcp.json"))).toBe(false);
  });

  test("--print writes nothing and shows every app", async () => {
    await setupCommand({ print: true }, { env, log });
    const text = lines.join("\n");
    expect(text).toContain("claude mcp add --transport http --scope user lefine https://dash.lefine.ai/v1/mcp");
    expect(text).toContain('"mcpServers"');
    expect(text).toContain('"servers"');
    expect(existsSync(join(home, ".cursor"))).toBe(false);
  });

  test("an unknown --client is refused", async () => {
    expect(await setupCommand({ client: ["emacs"] }, { env, log })).toBe(1);
    expect(() => parseClients(["emacs"])).toThrow();
    expect(parseClients(["cursor,vscode", "cursor"])).toEqual(["cursor", "vscode"]);
  });

  test("printSnippets for local mentions the profile login", () => {
    expect(printSnippets(true, undefined, env)).toContain("npx lefine login --profile mcp");
  });
});

describe("LEFINE_PROFILE", () => {
  test("rejects a path-like profile name", () => {
    expect(() => saveCredentials({ token: "t", apiUrl: "a", workspace: { id: "", slug: "", name: "" }, scopes: [], savedAt: "" }, "../evil")).toThrow();
  });
});
