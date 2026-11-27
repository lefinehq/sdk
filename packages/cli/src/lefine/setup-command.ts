/**
 * `lefine setup` (alias `lefine mcp install`): put Lefine's MCP server into the AI apps on this machine.
 *
 * Default: the REMOTE server (https://dash.lefine.ai/v1/mcp). The app signs in with OAuth, so no key is
 * stored and the person picks the workspace in the browser. `--local`: the stdio server (`npx -y lefine mcp`),
 * with a key from the device login saved in its own profile (~/.lefine/profiles/mcp.json, selected by the
 * LEFINE_PROFILE variable in the client's config, so the key is never written into a config file).
 *
 * Config files: merged, never replaced. Other servers stay, the file is backed up once (<file>.lefine-backup),
 * and a file that is not plain JSON is left alone. Same shapes as `claude mcp add`, Cursor's ~/.cursor/mcp.json,
 * Claude Desktop's claude_desktop_config.json and VS Code's user mcp.json.
 */

import { execFile } from "node:child_process";
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { bold, dim, green, red, yellow } from "../utils/colors.js";
import { loginCommand } from "./auth-commands.js";
import { profileExists, resolveApiUrl } from "./credentials.js";

export const MCP_NAME = "lefine";
export const LOCAL_PROFILE = "mcp";
export const CLIENTS = ["claude-code", "cursor", "claude-desktop", "vscode"] as const;
export type ClientId = (typeof CLIENTS)[number];

const LABEL: Record<ClientId, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  "claude-desktop": "Claude Desktop",
  vscode: "VS Code",
};

export interface SetupEnv {
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

export const realEnv = (): SetupEnv => ({ home: homedir(), platform: process.platform, env: process.env });

export const remoteUrl = (apiUrl?: string): string => `${resolveApiUrl(apiUrl)}/v1/mcp`;

/** The server entry a JSON config gets. VS Code names the transport; the others infer it. */
export interface ServerEntry {
  type?: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export function serverEntry(client: ClientId, local: boolean, apiUrl?: string): ServerEntry {
  if (local) {
    const entry: ServerEntry = { command: "npx", args: ["-y", "lefine", "mcp"], env: { LEFINE_PROFILE: LOCAL_PROFILE } };
    const api = apiUrl || process.env.LEFINE_API_URL;
    if (api) entry.env = { ...entry.env, LEFINE_API_URL: resolveApiUrl(api) };
    return client === "vscode" ? { type: "stdio", ...entry } : entry;
  }
  return client === "vscode" ? { type: "http", url: remoteUrl(apiUrl) } : { url: remoteUrl(apiUrl) };
}

/** Where a client keeps its MCP config, or null for a client with no file (Claude Code uses its CLI). */
export function configPath(client: ClientId, e: SetupEnv): string | null {
  const appData = e.env.APPDATA || join(e.home, "AppData", "Roaming");
  const support = join(e.home, "Library", "Application Support");
  const xdg = e.env.XDG_CONFIG_HOME || join(e.home, ".config");
  switch (client) {
    case "cursor":
      return join(e.home, ".cursor", "mcp.json");
    case "claude-desktop":
      return e.platform === "darwin"
        ? join(support, "Claude", "claude_desktop_config.json")
        : e.platform === "win32"
          ? join(appData, "Claude", "claude_desktop_config.json")
          : join(xdg, "Claude", "claude_desktop_config.json");
    case "vscode":
      return e.platform === "darwin"
        ? join(support, "Code", "User", "mcp.json")
        : e.platform === "win32"
          ? join(appData, "Code", "User", "mcp.json")
          : join(xdg, "Code", "User", "mcp.json");
    default:
      return null;
  }
}

/** The key under which a client lists its servers. */
const serversKey = (client: ClientId): "servers" | "mcpServers" => (client === "vscode" ? "servers" : "mcpServers");

function onPath(name: string, e: SetupEnv): boolean {
  const exts = e.platform === "win32" ? (e.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (e.env.PATH || "").split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const file = join(dir, name + ext);
      try {
        if (!statSync(file).isFile()) continue;
        accessSync(file, constants.X_OK);
        return true;
      } catch {
        /* next */
      }
    }
  }
  return false;
}

/** Clients that look installed: the `claude` binary, or the app's config folder. */
export function detectClients(e: SetupEnv = realEnv()): ClientId[] {
  return CLIENTS.filter((client) => {
    if (client === "claude-code") return onPath("claude", e);
    const file = configPath(client, e);
    return file !== null && existsSync(dirname(file));
  });
}

export type MergeResult =
  | { status: "added" | "updated" | "unchanged"; file: string; backup?: string }
  | { status: "invalid"; file: string; reason: string };

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Put `lefine` into a JSON config: parse, set one key, keep everything else. Writes nothing when the file
 * is not a JSON object (VS Code files may hold comments; those are left for the person to edit).
 */
export function mergeServer(file: string, client: ClientId, entry: ServerEntry): MergeResult {
  const key = serversKey(client);
  let doc: Record<string, unknown> = {};
  const existed = existsSync(file);
  if (existed) {
    const raw = readFileSync(file, "utf-8");
    if (raw.trim() !== "") {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
        doc = parsed as Record<string, unknown>;
      } catch {
        return { status: "invalid", file, reason: "it is not plain JSON (comments?), so it was left as it is" };
      }
    }
  }
  const current = doc[key];
  if (current !== undefined && (typeof current !== "object" || current === null || Array.isArray(current))) {
    return { status: "invalid", file, reason: `"${key}" in it is not an object, so it was left as it is` };
  }
  const servers = { ...((current as Record<string, unknown> | undefined) ?? {}) };
  const before = servers[MCP_NAME];
  if (same(before, entry)) return { status: "unchanged", file };
  servers[MCP_NAME] = entry;
  doc[key] = servers;

  mkdirSync(dirname(file), { recursive: true });
  let backup: string | undefined;
  if (existed) {
    backup = `${file}.lefine-backup`;
    if (existsSync(backup)) backup = undefined; // once: the first backup is the person's original
    else copyFileSync(file, backup);
  }
  writeFileSync(file, JSON.stringify(doc, null, 2) + "\n", "utf-8");
  return { status: before === undefined ? "added" : "updated", file, backup };
}

export interface RunResult {
  code: number;
  output: string;
}
export type Runner = (cmd: string, args: string[]) => Promise<RunResult>;

export const realRunner: Runner = (cmd, args) =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: 60_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, output: `${stdout}\n${stderr}${err && !stderr ? `\n${err.message}` : ""}`.trim() });
    });
  });

export const BLOCKED_HELP = [
  "Claude Code refused: Lefine is blocked by a policy.",
  "  Look for \"lefine\" in `deniedMcpServers` in ~/.claude/settings.json (or a managed policy file from your admin).",
  "  Remove that entry, then run `npx lefine setup` again. This command does not edit your settings.",
].join("\n");

/** `claude mcp add` arguments. Scope user: Lefine is then in every project, not only this folder. */
export function claudeAddArgs(local: boolean, apiUrl?: string): string[] {
  if (!local) return ["mcp", "add", "--transport", "http", "--scope", "user", MCP_NAME, remoteUrl(apiUrl)];
  const env = ["-e", `LEFINE_PROFILE=${LOCAL_PROFILE}`];
  const api = apiUrl || process.env.LEFINE_API_URL;
  if (api) env.push("-e", `LEFINE_API_URL=${resolveApiUrl(api)}`);
  return ["mcp", "add", "--scope", "user", ...env, MCP_NAME, "--", "npx", "-y", "lefine", "mcp"];
}

export interface ClientOutcome {
  client: ClientId;
  status: "added" | "updated" | "unchanged" | "failed" | "manual";
  detail: string;
}

export async function setupClaudeCode(local: boolean, apiUrl: string | undefined, run: Runner): Promise<ClientOutcome> {
  const client = "claude-code" as const;
  const got = await run("claude", ["mcp", "get", MCP_NAME]);
  if (got.code === 0) return { client, status: "unchanged", detail: "already added (`claude mcp remove lefine` to redo it)" };
  const added = await run("claude", claudeAddArgs(local, apiUrl));
  if (added.code === 0) return { client, status: "added", detail: "added for your user (all projects)" };
  const blocked = /enterprise policy|blocked by|denied/i.test(added.output);
  return { client, status: "failed", detail: blocked ? BLOCKED_HELP : `\`claude mcp add\` failed: ${added.output.split("\n").slice(-3).join(" ").trim()}` };
}

export function setupJsonClient(client: ClientId, local: boolean, apiUrl: string | undefined, e: SetupEnv): ClientOutcome {
  if (client === "claude-desktop" && !local) {
    // claude_desktop_config.json only starts local servers; a url entry there does not load. Remote ones are Connectors.
    return {
      client,
      status: "manual",
      detail: `Claude Desktop adds remote servers in the app: Settings > Connectors > Add custom connector > ${remoteUrl(apiUrl)}. (To use the local server instead: npx lefine setup --local --client claude-desktop)`,
    };
  }
  const file = configPath(client, e);
  if (!file) return { client, status: "failed", detail: "no config file for this client" };
  const result = mergeServer(file, client, serverEntry(client, local, apiUrl));
  if (result.status === "invalid") return { client, status: "failed", detail: `${result.file}: ${result.reason}` };
  const note = result.backup ? ` (backup: ${result.backup})` : "";
  return { client, status: result.status, detail: `${result.file}${note}` };
}

/** The snippets `--print` shows: nothing is written. */
export function printSnippets(local: boolean, apiUrl: string | undefined, e: SetupEnv = realEnv()): string {
  const lines: string[] = [];
  lines.push(`# Claude Code\nclaude ${claudeAddArgs(local, apiUrl).map((a) => (/[\s]/.test(a) ? JSON.stringify(a) : a)).join(" ")}\n`);
  for (const client of ["cursor", "claude-desktop", "vscode"] as const) {
    if (client === "claude-desktop" && !local) {
      lines.push(`# Claude Desktop\nSettings > Connectors > Add custom connector > ${remoteUrl(apiUrl)}\n`);
      continue;
    }
    const doc = { [serversKey(client)]: { [MCP_NAME]: serverEntry(client, local, apiUrl) } };
    lines.push(`# ${LABEL[client]}: ${configPath(client, e)}\n${JSON.stringify(doc, null, 2)}\n`);
  }
  if (local) lines.push("# Local server: sign in first with\nnpx lefine login --profile mcp\n");
  return lines.join("\n");
}

export interface SetupOptions {
  client?: string[];
  yes?: boolean;
  local?: boolean;
  print?: boolean;
  apiUrl?: string;
}

export interface SetupDeps {
  env?: SetupEnv;
  run?: Runner;
  /** Device login into the profile. Replaceable in tests. */
  login?: (profile: string, apiUrl?: string) => Promise<void>;
  /** Asks which detected clients to set up; returns the chosen ones. Replaceable in tests. */
  choose?: (detected: ClientId[]) => Promise<ClientId[]>;
  tty?: boolean;
  log?: (line: string) => void;
}

async function askWhich(detected: ClientId[]): Promise<ClientId[]> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    console.error("\n  Found:");
    detected.forEach((c, i) => console.error(`    ${i + 1}. ${LABEL[c]}`));
    const answer = (await rl.question("\n  Set up which? Numbers like 1,2 (Enter = all): ")).trim();
    if (answer === "") return detected;
    const picked = answer.split(/[\s,]+/).map((n) => detected[Number(n) - 1]).filter((c): c is ClientId => !!c);
    return [...new Set(picked)];
  } finally {
    rl.close();
  }
}

export function parseClients(values: string[] | undefined): ClientId[] {
  const out: ClientId[] = [];
  for (const raw of (values ?? []).flatMap((v) => v.split(","))) {
    const v = raw.trim();
    if (!v) continue;
    if (!(CLIENTS as readonly string[]).includes(v)) throw new Error(`Unknown client "${v}". Use one of: ${CLIENTS.join(", ")}.`);
    out.push(v as ClientId);
  }
  return [...new Set(out)];
}

/** Returns the process exit code. */
export async function setupCommand(options: SetupOptions, deps: SetupDeps = {}): Promise<number> {
  const e = deps.env ?? realEnv();
  const log = deps.log ?? ((l: string) => console.log(l));
  const local = options.local === true;

  if (options.print) {
    log(printSnippets(local, options.apiUrl, e));
    return 0;
  }

  let wanted: ClientId[];
  try {
    wanted = parseClients(options.client);
  } catch (err) {
    log(red(`  ${(err as Error).message}`));
    return 1;
  }

  const tty = deps.tty ?? (process.stdin.isTTY === true && process.stderr.isTTY === true);
  let targets = wanted;
  if (targets.length === 0) {
    const detected = detectClients(e);
    if (detected.length === 0) {
      log("  No AI app found on this machine (Claude Code, Cursor, Claude Desktop, VS Code).");
      log(dim("  Name one with --client, or see the snippets with `npx lefine setup --print`."));
      return 1;
    }
    if (options.yes) targets = detected;
    else if (tty) targets = await (deps.choose ?? askWhich)(detected);
    else {
      log(red("  Not a terminal: pass --yes (all found apps) or --client <name>."));
      return 1;
    }
    if (targets.length === 0) {
      log("  Nothing chosen.");
      return 0;
    }
  }

  if (local && !profileExists(LOCAL_PROFILE)) {
    log(`  Local server: signing in first (saved as profile "${LOCAL_PROFILE}", your other keys stay as they are).`);
    await (deps.login ?? ((profile, apiUrl) => loginCommand({ profile, apiUrl })))(LOCAL_PROFILE, options.apiUrl);
    if (!profileExists(LOCAL_PROFILE)) {
      log(red("  Sign-in did not finish, so nothing was set up."));
      return 1;
    }
  }

  const run = deps.run ?? realRunner;
  const outcomes: ClientOutcome[] = [];
  for (const client of targets) {
    if (client === "claude-code") {
      if (!onPath("claude", e) && !deps.run) {
        outcomes.push({ client, status: "failed", detail: "the `claude` command is not on your PATH" });
        continue;
      }
      outcomes.push(await setupClaudeCode(local, options.apiUrl, run));
    } else {
      outcomes.push(setupJsonClient(client, local, options.apiUrl, e));
    }
  }

  for (const o of outcomes) {
    const mark = o.status === "failed" ? red("x") : o.status === "manual" ? yellow("!") : green("✓");
    log(`  ${mark} ${bold(LABEL[o.client])}: ${o.detail}`);
  }
  const ok = outcomes.filter((o) => o.status === "added" || o.status === "updated");
  if (ok.length > 0 && !local) {
    const names = ok.map((o) => LABEL[o.client]).join(" / ");
    log(`\n  Open ${names} and approve Lefine when it asks (pick your workspace).`);
  } else if (ok.length > 0) {
    log(`\n  Restart ${ok.map((o) => LABEL[o.client]).join(" / ")}. Lefine starts by itself with the key you just saved.`);
  }
  return outcomes.some((o) => o.status === "failed") ? 1 : 0;
}

/** The hint `lefine mcp` prints when a person runs it by hand. */
export const MCP_HINT = "This is the MCP server an AI app starts. It waits for that app, so it looks stuck on its own.\nTo set it up, run: npx lefine setup";
