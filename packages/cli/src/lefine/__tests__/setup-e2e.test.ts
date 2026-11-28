/**
 * `lefine setup` end to end: the real CLI (src/lefine.ts) and the real add-mcp client table, in a child
 * process whose HOME is a temp folder. add-mcp fixes the home folder when it loads, so this cannot run
 * in-process. Nothing here touches the real HOME. The server for the connection test is a local stub.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const CLI = join(import.meta.dir, "..", "..", "lefine.ts");
let home: string;
let server: ReturnType<typeof Bun.serve>;
let api: string;

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    fetch: () => new Response("{}", { status: 401, headers: { "www-authenticate": 'Bearer resource_metadata="http://x/.well-known/oauth-protected-resource"' } }),
  });
  api = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lefine-e2e-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** A `claude` that logs its arguments, and says `lefine` is not added yet. */
const fakeClaude = () => {
  mkdirSync(join(home, "bin"), { recursive: true });
  const f = join(home, "bin", "claude");
  writeFileSync(f, `#!/bin/sh\necho "$@" >> "${join(home, "claude.log")}"\n[ "$2" = get ] && exit 1\nexit 0\n`);
  chmodSync(f, 0o755);
};

/** Async: the stub server above lives in this process and must keep answering while the CLI runs. */
function run(args: string[], extraEnv: Record<string, string> = {}, cwd = home): Promise<{ code: number | null; out: string; err: string; json: any }> {
  return new Promise((resolve) => {
    const child = spawn("bun", [CLI, ...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: join(home, ".config"), CODEX_HOME: join(home, ".codex"), PATH: `${join(home, "bin")}:${dirname(process.execPath)}:/usr/bin:/bin`, LEFINE_HOME: join(home, ".lefine"), LEFINE_API_URL: api, ...extraEnv },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => {
      let json: any;
      try {
        json = JSON.parse(out);
      } catch {
        /* not JSON */
      }
      resolve({ code, out, err, json });
    });
  });
}

const cursorFile = () => join(home, ".cursor", "mcp.json");
const read = (f: string) => JSON.parse(readFileSync(f, "utf-8"));
const mode = (f: string) => statSync(f).mode & 0o777;
const URL_ = () => `${api}/v1/mcp`;

describe("write, merge, backup", () => {
  test("Cursor: merged next to other servers, backed up once with mode 0600", async () => {
    mkdirSync(join(home, ".cursor"));
    writeFileSync(cursorFile(), JSON.stringify({ theme: "x", mcpServers: { other: { command: "a" } } }));
    const r = await run(["setup", "--client", "cursor"]);
    expect(r.code).toBe(0);
    expect(r.json.results[0]).toMatchObject({ client: "cursor", status: "added" });
    expect(read(cursorFile())).toEqual({ theme: "x", mcpServers: { other: { command: "a" }, lefine: { url: URL_() } } });
    const backup = `${cursorFile()}.lefine-backup`;
    expect(read(backup)).toEqual({ theme: "x", mcpServers: { other: { command: "a" } } });
    expect(mode(backup)).toBe(0o600);

    // changing the entry later keeps the FIRST backup (the person's original)
    await run(["setup", "--client", "cursor", "--readonly", "--no-check"]);
    expect(read(cursorFile()).mcpServers.lefine.url).toBe(`${URL_()}?level=read`);
    expect(read(backup)).toEqual({ theme: "x", mcpServers: { other: { command: "a" } } });
  });

  test("running it twice: the second run is unchanged and leaves the file alone", async () => {
    await run(["setup", "--client", "cursor", "--no-check"]);
    const before = readFileSync(cursorFile(), "utf-8");
    const again = await run(["setup", "--client", "cursor", "--no-check"]);
    expect(again.json.results[0].status).toBe("unchanged");
    expect(readFileSync(cursorFile(), "utf-8")).toBe(before);
  });

  test("--no-backup writes no backup file", async () => {
    mkdirSync(join(home, ".cursor"));
    writeFileSync(cursorFile(), "{}");
    await run(["setup", "--client", "cursor", "--no-backup", "--no-check"]);
    expect(existsSync(`${cursorFile()}.lefine-backup`)).toBe(false);
  });

  test("an old stdio entry is replaced by the remote URL", async () => {
    mkdirSync(join(home, ".cursor"));
    writeFileSync(cursorFile(), JSON.stringify({ mcpServers: { lefine: { command: "npx", args: ["-y", "@lefine/mcp"] } } }));
    const r = await run(["setup", "--client", "cursor", "--no-check"]);
    expect(r.json.results[0].status).toBe("updated");
    expect(read(cursorFile()).mcpServers.lefine).toEqual({ url: URL_() });
  });

  test("VS Code: `servers` with type http", async () => {
    const r = await run(["setup", "--client", "vscode", "--no-check"]);
    expect(r.code).toBe(0);
    const file = r.json.results[0].file as string;
    expect(read(file).servers.lefine).toEqual({ type: "http", url: URL_() });
  });

  test("Windsurf writes serverUrl, Gemini CLI httpUrl-style entry, Zed context_servers", async () => {
    const w = await run(["setup", "--client", "windsurf", "--no-check"]);
    expect(JSON.stringify(read(w.json.results[0].file).mcpServers.lefine)).toContain(URL_());
    expect(Object.keys(read(w.json.results[0].file).mcpServers.lefine)).toContain("serverUrl");
    const g = await run(["setup", "--client", "gemini-cli", "--no-check"]);
    expect(JSON.stringify(read(g.json.results[0].file).mcpServers.lefine)).toContain(URL_());
    const z = await run(["setup", "--client", "zed", "--no-check"]);
    expect(JSON.stringify(read(z.json.results[0].file).context_servers.lefine)).toContain(URL_());
  });

  test("Codex: TOML table with the URL", async () => {
    const r = await run(["setup", "--client", "codex", "--no-check"]);
    expect(r.code).toBe(0);
    const toml = readFileSync(r.json.results[0].file, "utf-8");
    expect(toml).toContain("[mcp_servers.lefine]");
    expect(toml).toContain(URL_());
  });

  test("--project writes into the project folder (cwd), not the home folder", async () => {
    const proj = join(home, "proj");
    mkdirSync(proj);
    const r = await run(["setup", "--client", "cursor", "--project", "--no-check"], {}, proj);
    expect(r.code).toBe(0);
    expect(read(join(proj, ".cursor", "mcp.json")).mcpServers.lefine.url).toBe(URL_());
    expect(existsSync(cursorFile())).toBe(false);
  });

  test("a JSON file with comments is kept, comments and all", async () => {
    mkdirSync(join(home, ".cursor"));
    writeFileSync(cursorFile(), '{\n // my servers\n "mcpServers": {}\n}\n');
    const r = await run(["setup", "--client", "cursor", "--no-check"]);
    expect(r.code).toBe(0);
    expect(readFileSync(cursorFile(), "utf-8")).toContain("// my servers");
    expect(readFileSync(cursorFile(), "utf-8")).toContain(URL_());
  });

  test("a file that is not valid JSON is reported as failed, not overwritten", async () => {
    mkdirSync(join(home, ".cursor"));
    writeFileSync(cursorFile(), "{ this is not json");
    const r = await run(["setup", "--client", "cursor", "--no-check"]);
    expect(r.code).toBe(1);
    expect(r.json.results[0].status).toBe("failed");
    expect(readFileSync(cursorFile(), "utf-8")).toBe("{ this is not json");
  });

  test("Claude Code goes through `claude mcp add`, user scope", async () => {
    fakeClaude();
    const r = await run(["setup", "--client", "claude-code", "--no-check"]);
    expect(r.code).toBe(0);
    expect(readFileSync(join(home, "claude.log"), "utf-8")).toContain(`mcp add --transport http --scope user lefine ${URL_()}`);
  });
});

describe("symlinks and escapes", () => {
  test("a symlinked config file is refused: nothing is written through it", async () => {
    mkdirSync(join(home, ".cursor"));
    const target = join(home, "precious.txt");
    writeFileSync(target, "keep me");
    symlinkSync(target, cursorFile());
    const r = await run(["setup", "--client", "cursor", "--no-check"]);
    expect(r.code).toBe(1);
    expect(r.json.results[0].status).toBe("failed");
    expect(r.json.results[0].detail).toContain("symbolic link");
    expect(r.json.results[0].detail).toContain(cursorFile());
    expect(readFileSync(target, "utf-8")).toBe("keep me");
    expect(existsSync(`${cursorFile()}.lefine-backup`)).toBe(false);
  });

  test("a symlinked backup path is refused: the file it points to is not touched", async () => {
    mkdirSync(join(home, ".cursor"));
    writeFileSync(cursorFile(), "{}");
    const victim = join(home, "victim.txt");
    writeFileSync(victim, "do not overwrite");
    symlinkSync(victim, `${cursorFile()}.lefine-backup`);
    const r = await run(["setup", "--client", "cursor", "--no-check"]);
    expect(r.code).toBe(1);
    expect(r.json.results[0].detail).toContain("symbolic link");
    expect(r.json.results[0].detail).toContain("lefine-backup");
    expect(readFileSync(victim, "utf-8")).toBe("do not overwrite");
    expect(readFileSync(cursorFile(), "utf-8")).toBe("{}");
    expect(lstatSync(`${cursorFile()}.lefine-backup`).isSymbolicLink()).toBe(true);
  });

  test("--project: a linked folder that leaves the project is refused", async () => {
    const proj = join(home, "proj");
    const outside = join(home, "outside");
    mkdirSync(proj);
    mkdirSync(outside);
    symlinkSync(outside, join(proj, ".cursor"));
    const r = await run(["setup", "--client", "cursor", "--project", "--no-check"], {}, proj);
    expect(r.code).toBe(1);
    expect(r.json.results[0].detail).toContain("outside the project folder");
    expect(existsSync(join(outside, "mcp.json"))).toBe(false);
  });

  test("--remove does not follow a symlinked config either", async () => {
    mkdirSync(join(home, ".cursor"));
    const target = join(home, "real.json");
    writeFileSync(target, JSON.stringify({ mcpServers: { lefine: { url: URL_() } } }));
    symlinkSync(target, cursorFile());
    const r = await run(["setup", "--remove", "--client", "cursor"]);
    expect(r.json.results[0].status).toBe("failed");
    expect(read(target).mcpServers.lefine.url).toBe(URL_());
  });

  test("a regular backup is created O_EXCL with mode 0600 even when the config is 0644", async () => {
    mkdirSync(join(home, ".cursor"));
    writeFileSync(cursorFile(), "{}", { mode: 0o644 });
    await run(["setup", "--client", "cursor", "--no-check"]);
    expect(mode(`${cursorFile()}.lefine-backup`)).toBe(0o600);
  });
});

describe("spoofed entries", () => {
  test("a Cursor entry whose URL only CONTAINS ours is foreign and replaced", async () => {
    mkdirSync(join(home, ".cursor"));
    writeFileSync(cursorFile(), JSON.stringify({ mcpServers: { lefine: { url: `https://evil.example/?x=${URL_()}` } } }));
    const r = await run(["setup", "--client", "cursor", "--no-check"]);
    expect(r.json.results[0].status).toBe("updated");
    expect(read(cursorFile()).mcpServers.lefine.url).toBe(URL_());
  });
  test("Windsurf: the right URL under `url` (not serverUrl) is foreign; doctor flags it", async () => {
    const dir = join(home, ".codeium", "windsurf");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, "mcp_config.json");
    writeFileSync(file, JSON.stringify({ mcpServers: { lefine: { url: URL_() } } }));
    const doc = await run(["setup", "--doctor", "--client", "windsurf", "--no-check"]);
    expect((doc.json.findings as { level: string }[]).some((f) => f.level === "problem")).toBe(true);
    const r = await run(["setup", "--client", "windsurf", "--no-check"]);
    expect(r.json.results[0].status).toBe("updated");
    expect(read(file).mcpServers.lefine.serverUrl).toBe(URL_());
  });
});

describe("local (stdio) entries", () => {
  const profile = () => {
    mkdirSync(join(home, ".lefine", "profiles"), { recursive: true });
    writeFileSync(join(home, ".lefine", "profiles", "mcp.json"), JSON.stringify({ token: "lfn_x", apiUrl: api, workspace: { id: "w", slug: "s", name: "S" }, scopes: [], savedAt: "x" }), { mode: 0o600 });
  };

  test("--local writes the exact entry, a second run leaves it, and doctor accepts it", async () => {
    profile();
    mkdirSync(join(home, ".cursor"));
    const first = await run(["setup", "--client", "cursor", "--local", "--no-check"]);
    expect(first.json.results[0].status).toBe("added");
    const entry = read(cursorFile()).mcpServers.lefine;
    expect(entry).toMatchObject({ command: "npx", args: ["-y", "lefine@latest", "mcp"] });
    expect(entry.env.LEFINE_PROFILE).toBe("mcp");
    expect((await run(["setup", "--client", "cursor", "--local", "--no-check"])).json.results[0].status).toBe("unchanged");
    const doc = await run(["setup", "--doctor", "--client", "cursor", "--local", "--no-check"]);
    expect((doc.json.findings as { level: string }[]).some((f) => f.level === "problem")).toBe(false);
  });

  test("spoofed stdio entries are replaced and flagged", async () => {
    profile();
    mkdirSync(join(home, ".cursor"));
    const env = { LEFINE_PROFILE: "mcp", LEFINE_API_URL: api };
    const spoofs = [
      { command: "node", args: ["-y", "lefine@latest", "mcp"], env },
      { command: "npx", args: ["-y", "lefine@latest", "mcp"], env: { ...env, NODE_OPTIONS: "--require=/tmp/x.js" } },
      { command: "sh", args: ["-c", "evil", "LEFINE_PROFILE=mcp"], env },
    ];
    for (const entry of spoofs) {
      writeFileSync(cursorFile(), JSON.stringify({ mcpServers: { lefine: entry } }));
      const doc = await run(["setup", "--doctor", "--client", "cursor", "--local", "--no-check"]);
      expect((doc.json.findings as { level: string }[]).some((f) => f.level === "problem")).toBe(true);
      const r = await run(["setup", "--client", "cursor", "--local", "--no-check"]);
      expect(r.json.results[0].status).toBe("updated");
      expect(read(cursorFile()).mcpServers.lefine.command).toBe("npx");
      expect(read(cursorFile()).mcpServers.lefine.env.NODE_OPTIONS).toBeUndefined();
    }
  });
});

describe("Claude Code reads its own config as data", () => {
  const claudeThatHasIt = () => {
    mkdirSync(join(home, "bin"), { recursive: true });
    const f = join(home, "bin", "claude");
    writeFileSync(f, `#!/bin/sh\necho "$@" >> "${join(home, "claude.log")}"\nexit 0\n`);
    chmodSync(f, 0o755);
  };
  test("an exact entry in ~/.claude.json: no remove, no add; a spoofed one: remove --scope user, then add", async () => {
    claudeThatHasIt();
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { lefine: { type: "http", url: URL_() } } }));
    expect((await run(["setup", "--client", "claude-code", "--no-check"])).json.results[0].status).toBe("unchanged");
    expect(readFileSync(join(home, "claude.log"), "utf-8").trim().split("\n")).toEqual(["mcp get lefine", "mcp get lefine"]); // the second one reads the sign-in state for the end screen
    writeFileSync(join(home, ".claude.json"), JSON.stringify({ mcpServers: { lefine: { type: "http", url: `https://evil.example/?x=${URL_()}` } } }));
    expect((await run(["setup", "--client", "claude-code", "--no-check"])).json.results[0].status).toBe("updated");
    const log = readFileSync(join(home, "claude.log"), "utf-8");
    expect(log).toContain("mcp remove lefine --scope user");
    expect(log).toContain(`mcp add --transport http --scope user lefine ${URL_()}`);
  });
});

describe("Claude Desktop", () => {
  test("never writes claude_desktop_config.json; prints the Connectors steps", async () => {
    const dir = process.platform === "darwin" ? join(home, "Library", "Application Support", "Claude") : join(home, ".config", "Claude");
    mkdirSync(dir, { recursive: true });
    const r = await run(["setup", "--client", "claude-desktop", "--no-check"]);
    expect(r.code).toBe(0);
    expect(r.json.results[0].status).toBe("manual");
    expect(r.json.results[0].detail).toContain("Settings > Connectors > Add custom connector");
    expect(existsSync(join(dir, "claude_desktop_config.json"))).toBe(false);
  });
  test("a --yes run over every detected app does not create the file either", async () => {
    const dir = process.platform === "darwin" ? join(home, "Library", "Application Support", "Claude") : join(home, ".config", "Claude");
    mkdirSync(dir, { recursive: true });
    mkdirSync(join(home, ".cursor"));
    await run(["setup", "--yes", "--no-check"]);
    expect(existsSync(join(dir, "claude_desktop_config.json"))).toBe(false);
  });
});

describe("remove, list, doctor", () => {
  test("--remove deletes only the lefine entry, --list shows it before and not after", async () => {
    mkdirSync(join(home, ".cursor"));
    writeFileSync(cursorFile(), JSON.stringify({ mcpServers: { other: { command: "a" } } }));
    await run(["setup", "--client", "cursor", "--no-check"]);
    const listed = await run(["setup", "--list"]);
    expect(listed.json.installed).toEqual([expect.objectContaining({ client: "cursor", url: URL_(), stdio: false })]);
    const removed = await run(["setup", "--remove"]);
    expect(removed.json.results[0]).toMatchObject({ client: "cursor", status: "removed" });
    expect(read(cursorFile())).toEqual({ mcpServers: { other: { command: "a" } } });
    expect(await (await run(["setup", "--list"])).json.installed).toEqual([]);
  });

  test("--remove with nothing set up is a clean no-op", async () => {
    const r = await run(["setup", "--remove"]);
    expect(r.code).toBe(0);
    expect(r.json.results).toEqual([]);
  });

  test("--doctor finds an old stdio entry in Cursor and a deniedMcpServers entry", async () => {
    mkdirSync(join(home, ".cursor"));
    writeFileSync(cursorFile(), JSON.stringify({ mcpServers: { lefine: { command: "npx", args: ["-y", "lefine", "mcp"] } } }));
    mkdirSync(join(home, ".claude"));
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ deniedMcpServers: [{ serverName: "lefine" }] }));
    const r = await run(["setup", "--doctor"]);
    expect(r.code).toBe(1);
    const problems = (r.json.findings as { level: string; message: string }[]).filter((f) => f.level === "problem").map((f) => f.message);
    expect(problems.some((m) => m.includes("no version tag"))).toBe(true);
    expect(problems.some((m) => m.includes("deniedMcpServers"))).toBe(true);
    expect(r.json.next).toContain("npx lefine@latest setup --local --yes");
  });

  test("--doctor on a clean setup passes and the connection test sees the stub server", async () => {
    fakeClaude();
    await run(["setup", "--client", "cursor", "--no-check"]);
    const r = await run(["setup", "--doctor"]);
    expect(r.json.check).toMatchObject({ reachable: true, status: 401 });
  });
});

describe("without a terminal", () => {
  test("no flags: JSON error with a next command, no file written", async () => {
    mkdirSync(join(home, ".cursor"));
    const r = await run(["setup"]);
    expect(r.code).toBe(1);
    expect(r.json).toMatchObject({ ok: false, next: "npx lefine setup --yes" });
    expect(existsSync(cursorFile())).toBe(false);
  });
  test("--yes: JSON with results, check, steps, try, undo", async () => {
    mkdirSync(join(home, ".cursor"));
    const r = await run(["setup", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.json.check).toMatchObject({ reachable: true });
    expect(r.json.steps[0]).toContain("Cursor");
    expect(r.json.try).toContain("Use Lefine");
    expect(r.json.undo).toBe("npx lefine setup --remove");
    expect(r.out.trim().startsWith("{")).toBe(true);
  });
  test("--print shows the snippets and writes no file", async () => {
    const r = await run(["setup", "--print", "--client", "cursor", "--client", "claude-desktop"]);
    expect(r.code).toBe(0);
    expect(r.out).toContain("lefine");
    expect(existsSync(cursorFile())).toBe(false);
  });
});
