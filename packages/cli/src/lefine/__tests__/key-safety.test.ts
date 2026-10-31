import { describe, it, expect, afterEach, beforeEach } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { browserCommand } from "../auth-commands.js";
import { resolveLefineAuth, saveCredentials } from "../credentials.js";

const SAVED = "http://saved.example";
let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lefine-safety-"));
  process.env.LEFINE_HOME = join(home, ".lefine");
  delete process.env.LEFINE_TOKEN;
  delete process.env.LEFINE_API_URL;
});
afterEach(() => {
  delete process.env.LEFINE_HOME;
  delete process.env.LEFINE_TOKEN;
  delete process.env.LEFINE_API_URL;
  rmSync(home, { recursive: true, force: true });
});

const save = (apiUrl = SAVED) =>
  saveCredentials({
    token: "lfn_saved_key",
    apiUrl,
    workspace: { id: "w", slug: "acme", name: "Acme" },
    scopes: [],
    savedAt: "2026-10-22T00:00:00.000Z",
  });

describe("a saved key only goes to the server it was saved for", () => {
  it("refuses a different --api-url", () => {
    save();
    expect(() => resolveLefineAuth({ apiUrl: "https://evil.example" })).toThrow(
      `This key belongs to ${SAVED}. Run \`lefine login --api-url https://evil.example\` to use another server.`,
    );
  });

  it("refuses a different LEFINE_API_URL", () => {
    save();
    process.env.LEFINE_API_URL = "https://evil.example";
    expect(() => resolveLefineAuth({})).toThrow("This key belongs to");
  });

  it("accepts the same origin, with or without a trailing slash", () => {
    save();
    expect(resolveLefineAuth({ apiUrl: `${SAVED}/` })).toMatchObject({ token: "lfn_saved_key", apiUrl: SAVED });
    process.env.LEFINE_API_URL = SAVED;
    expect(resolveLefineAuth({})?.apiUrl).toBe(SAVED);
  });

  it("--token and LEFINE_TOKEN may go to any server (the user chose both)", () => {
    save();
    expect(resolveLefineAuth({ token: "lfn_flag", apiUrl: "https://other.example" })).toMatchObject({
      source: "flag",
      apiUrl: "https://other.example",
    });
    process.env.LEFINE_TOKEN = "lfn_env";
    expect(resolveLefineAuth({ apiUrl: "https://other.example" })).toMatchObject({ source: "env" });
  });
});

describe("project env files cannot redirect the key", () => {
  it("the lefine bin ignores LEFINE_API_URL from a project env file: the stored key is not sent", async () => {
    const requests: string[] = [];
    const evil = Bun.serve({ port: 0, fetch: (req) => (requests.push(`evil ${req.url}`), new Response("{}")) });
    const real = Bun.serve({ port: 0, fetch: (req) => (requests.push(`real ${req.headers.get("authorization")}`), Response.json({ user: {}, workspace: { id: "w", slug: "acme", name: "Acme" }, scopes: [], apps: [] })) });
    try {
      save(`http://localhost:${real.port}`);
      const project = mkdtempSync(join(tmpdir(), "lefine-project-"));
      for (const name of [".env", ".env.local"]) {
        writeFileSync(join(project, name), `LEFINE_API_URL=http://localhost:${evil.port}\nLEFINE_TOKEN=lfn_planted\n`);
      }
      // `--no-env-file`: Bun itself reads project env files, the shipped bin runs on Node and
      // does not. What this proves is that our own code does not load them either.
      const proc = Bun.spawn(["bun", "--no-env-file", join(import.meta.dir, "../../lefine.ts"), "whoami", "--json"], {
        cwd: project,
        env: { PATH: process.env.PATH!, HOME: process.env.HOME!, LEFINE_HOME: process.env.LEFINE_HOME! },
        stdout: "pipe",
        stderr: "pipe",
      });
      await proc.exited;
      rmSync(project, { recursive: true, force: true });
      expect(requests.filter((r) => r.startsWith("evil"))).toEqual([]);
      expect(requests).toEqual(["real Bearer lfn_saved_key"]);
    } finally {
      evil.stop(true);
      real.stop(true);
    }
  });
});

it("no lefine module imports the project env-file loader", () => {
  const dir = join(import.meta.dir, "..");
  const files = [join(dir, "../lefine.ts"), ...readdirSync(dir).filter((f) => f.endsWith(".ts")).map((f) => join(dir, f))];
  for (const file of files) expect(readFileSync(file, "utf-8")).not.toMatch(/load-env|loadEnvFiles\(/);
});

describe("opening the browser", () => {
  it("accepts only http and https", () => {
    expect(browserCommand("https://dash.lefine.ai/device?code=AB", "linux")).toEqual(["xdg-open", ["https://dash.lefine.ai/device?code=AB"]]);
    expect(browserCommand("file:///etc/passwd", "linux")).toBeNull();
    expect(browserCommand("javascript:alert(1)", "darwin")).toBeNull();
    expect(browserCommand("calc.exe", "win32")).toBeNull();
  });

  it("never goes through cmd on Windows, even with shell metacharacters", () => {
    const command = browserCommand("https://x.example/a?b=1&calc", "win32")!;
    expect(command[0]).toBe("rundll32");
    expect(command[0]).not.toBe("cmd");
    expect(command[1]).toEqual(["url.dll,FileProtocolHandler", "https://x.example/a?b=1&calc"]);
  });
});
