/**
 * `lefine setup` (alias `lefine mcp install`, and plain `npx @lefine/mcp` in a terminal): put Lefine's MCP
 * server into the AI apps on this machine.
 *
 * Default: the REMOTE server (https://dash.lefine.ai/v1/mcp). The app signs in with OAuth, so no key is
 * stored and the person picks the workspace in the browser. `--readonly` adds `?level=read` to the URL (the
 * server then grants read access only). `--local`: the stdio server (`npx -y lefine mcp`) with a key from the
 * device login, saved in its own profile (~/.lefine/profiles/mcp.json, selected by LEFINE_PROFILE in the
 * client's config, so the key is never written into a config file).
 *
 * Claude Code: `claude mcp add` (its own CLI owns ~/.claude.json). Every other app: config files merged by
 * add-mcp (see setup-clients.ts), never replaced; the file is backed up once (0600). Claude Desktop and
 * ChatGPT take remote servers in their own settings, so for them we print the steps and write nothing.
 *
 * Output: a terminal gets the wizard. Without one (an agent, CI) the command prints ONE JSON object on stdout
 * with a `next` command, and never waits for a question.
 */

import { exec, execFile } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { bold, dim, green, red, yellow } from "../utils/colors.js";
import { loginCommand } from "./auth-commands.js";
import { profileExists, resolveApiUrl } from "./credentials.js";
import {
  addMcpOps,
  CLIENTS,
  type ClientId,
  type ClientOps,
  type Installed,
  INSTRUCTIONS,
  isStdio,
  sameUrl,
  storedUrl,
  isWritable,
  LABEL,
  MCP_NAME,
  type Scope,
  type ServerEntry,
  tidy,
  WRITABLE,
} from "./setup-clients.js";
import { clackUi, type SetupUi } from "./setup-ui.js";

export { CLIENTS, LABEL, MCP_NAME, type ClientId } from "./setup-clients.js";
export const LOCAL_PROFILE = "mcp";
export const TRY_PROMPT = "Use Lefine. Show me which keys are not translated to Turkish.";
export const UNDO = "npx lefine setup --remove";

export interface SetupEnv {
  home: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  cwd?: string;
}

export const realEnv = (): SetupEnv => ({ home: homedir(), platform: process.platform, env: process.env, cwd: process.cwd() });

export const remoteUrl = (apiUrl?: string, readonly = false): string => `${resolveApiUrl(apiUrl)}/v1/mcp${readonly ? "?level=read" : ""}`;

export function serverEntry(local: boolean, apiUrl?: string, readonly = false): ServerEntry {
  if (local) {
    const entry: ServerEntry = { command: "npx", args: ["-y", "lefine", "mcp"], env: { LEFINE_PROFILE: LOCAL_PROFILE } };
    const api = apiUrl || process.env.LEFINE_API_URL;
    if (api) entry.env = { ...entry.env, LEFINE_API_URL: resolveApiUrl(api) };
    return entry;
  }
  return { type: "http", url: remoteUrl(apiUrl, readonly) };
}

function onPath(name: string, e: SetupEnv): boolean {
  const exts = e.platform === "win32" ? (e.env.PATHEXT || ".EXE;.CMD;.BAT").split(";") : [""];
  for (const dir of (e.env.PATH || e.env.Path || "").split(delimiter)) {
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

/** Apps that look installed: the `claude` binary, or the config folder add-mcp knows. */
export async function detectClients(e: SetupEnv, ops: ClientOps = addMcpOps): Promise<ClientId[]> {
  await ops.load();
  const found = new Set(await ops.detect());
  if (onPath("claude", e)) found.add("claude-code");
  return WRITABLE.filter((c) => found.has(c));
}

// ---------------------------------------------------------------------------------------------- running claude

export interface RunResult {
  code: number;
  output: string;
}
export type Runner = (cmd: string, args: string[]) => Promise<RunResult>;

const winQuote = (a: string): string => {
  if (/[%\r\n]/.test(a)) throw new Error(`argument not allowed on Windows: ${a}`); // cmd.exe expands %VAR% even inside quotes
  return /[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a;
};

/**
 * Runs a command. On Windows `claude` is usually `claude.cmd`, and Node (>= 18.20.2) refuses to start a .cmd
 * file without a shell (EINVAL), so there it goes through the shell with quoted arguments.
 */
export const realRunner: Runner = (cmd, args) =>
  new Promise((resolve) => {
    const done = (err: (Error & { code?: unknown }) | null, stdout: string, stderr: string) => {
      const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
      resolve({ code, output: `${stdout}\n${stderr}${err && !stderr ? `\n${err.message}` : ""}`.trim() });
    };
    if (process.platform === "win32") exec([cmd, ...args.map(winQuote)].join(" "), { timeout: 60_000 }, done);
    else execFile(cmd, args, { timeout: 60_000 }, done);
  });

export const BLOCKED_HELP = [
  "Claude Code refused: Lefine is blocked by a policy.",
  "  Look for \"lefine\" in `deniedMcpServers` in ~/.claude/settings.json (or a managed policy file from your admin).",
  "  Remove that entry, then run `npx lefine setup` again. This command does not edit your settings.",
].join("\n");

/** `claude mcp add` arguments. Scope user: Lefine is then in every project, not only this folder. */
export function claudeAddArgs(local: boolean, apiUrl?: string, readonly = false, scope: Scope = "user"): string[] {
  if (!local) return ["mcp", "add", "--transport", "http", "--scope", scope, MCP_NAME, remoteUrl(apiUrl, readonly)];
  const env = ["-e", `LEFINE_PROFILE=${LOCAL_PROFILE}`];
  const api = apiUrl || process.env.LEFINE_API_URL;
  if (api) env.push("-e", `LEFINE_API_URL=${resolveApiUrl(api)}`);
  return ["mcp", "add", "--scope", scope, ...env, MCP_NAME, "--", "npx", "-y", "lefine", "mcp"];
}

export interface ClientOutcome {
  client: ClientId;
  status: "added" | "updated" | "unchanged" | "removed" | "absent" | "failed" | "manual";
  detail: string;
  file?: string;
  backup?: string;
}

export interface ClaudeOptions {
  local: boolean;
  apiUrl?: string;
  readonly: boolean;
  scope: Scope;
}

/** What `claude mcp get lefine` says: its `Scope:`, `Type:` and `URL:` lines (each read as a whole line, not searched for). */
export function parseClaudeGet(output: string): { scope?: "user" | "project" | "local"; type?: string; url?: string } {
  const line = (key: string) => output.match(new RegExp(`^\\s*${key}:\\s*(.+?)\\s*$`, "im"))?.[1];
  const scopeText = line("Scope");
  const scope = scopeText ? (/^user/i.test(scopeText) ? "user" : /^project/i.test(scopeText) ? "project" : /^local/i.test(scopeText) ? "local" : undefined) : undefined;
  return { scope, type: line("Type")?.toLowerCase(), url: line("URL") };
}

export async function setupClaudeCode(o: ClaudeOptions, run: Runner): Promise<ClientOutcome> {
  const client = "claude-code" as const;
  const where = o.scope === "project" ? "this project (.mcp.json)" : "your user (all projects)";
  const file = o.scope === "project" ? ".mcp.json" : "~/.claude.json";
  const want = o.local ? "" : remoteUrl(o.apiUrl, o.readonly);
  const got = await run("claude", ["mcp", "get", MCP_NAME]);
  let updated = false;
  if (got.code === 0) {
    // Already there. The same URL in the scope we were asked for: nothing to do. Anything else (an old stdio
    // entry, another URL or level, another scope's entry): replace it, in the scope where it lives.
    const have = parseClaudeGet(got.output);
    const same = o.local ? have.type === "stdio" && /LEFINE_PROFILE/.test(got.output) : have.type !== "stdio" && sameUrl(have.url, want);
    if (same && have.scope === o.scope) return { client, status: "unchanged", detail: "already added", file };
    await run("claude", ["mcp", "remove", MCP_NAME, "--scope", have.scope ?? o.scope]);
    updated = true;
  }
  const added = await run("claude", claudeAddArgs(o.local, o.apiUrl, o.readonly, o.scope));
  if (added.code === 0) return { client, status: updated ? "updated" : "added", detail: `${updated ? "updated" : "added"} for ${where}`, file };
  const blocked = /enterprise policy|blocked by|denied/i.test(added.output);
  return { client, status: "failed", detail: blocked ? BLOCKED_HELP : `\`claude mcp add\` failed: ${added.output.split("\n").slice(-3).join(" ").trim()}` };
}

// ---------------------------------------------------------------------------------------------- instructions

/** The steps for an app that takes remote servers in its own settings. */
export function manualSteps(client: ClientId, url: string): string[] {
  if (client === "chatgpt") {
    return [
      "Open chatgpt.com, then Settings > Connectors (Developer mode may be needed on your plan).",
      `Add a custom MCP server: name Lefine, URL ${url}, authentication OAuth.`,
      "Confirm, then type @ in a chat to use it.",
    ];
  }
  return ["Open Claude Desktop: Settings > Connectors > Add custom connector.", `Paste ${url} and click Continue.`, "Sign in to Lefine in the browser page and approve."];
}

/** What to click after the file is written: the sign-in step each app needs once. */
export function nextClick(client: ClientId): string {
  switch (client) {
    case "claude-code":
      return "Claude Code: type /mcp, pick lefine, choose Authenticate";
    case "cursor":
      return "Cursor: open Settings > MCP, click Connect next to lefine";
    case "vscode":
      return "VS Code: open mcp.json (or the MCP: List Servers command), click Start above lefine, then sign in";
    case "windsurf":
      return "Windsurf: open the MCP panel (Cascade), enable lefine and sign in when asked";
    case "codex":
      return "Codex: run `codex mcp login lefine`";
    case "gemini-cli":
      return "Gemini CLI: start it and type /mcp auth lefine";
    case "zed":
      return "Zed: open the Agent panel settings, find lefine and sign in when asked";
    default:
      return `${LABEL[client]}: see the steps above`;
  }
}

// ---------------------------------------------------------------------------------------------- connection test

export interface CheckResult {
  reachable: boolean;
  url: string;
  status?: number;
  ms?: number;
  note: string;
}

/**
 * POST `initialize` without a token. A live Lefine server answers 401 with a WWW-Authenticate header that
 * names `resource_metadata`: that is what an OAuth client needs, so it counts as reachable.
 */
export async function checkConnection(url: string, doFetch: typeof fetch = fetch): Promise<CheckResult> {
  const started = Date.now();
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "lefine-setup", version: "1" } } }),
      signal: AbortSignal.timeout(8000),
    });
    const ms = Date.now() - started;
    const auth = res.headers.get("www-authenticate") ?? "";
    if (res.status === 401 && /resource_metadata/i.test(auth)) return { reachable: true, url, status: 401, ms, note: "reachable" };
    if (res.status === 401) return { reachable: false, url, status: 401, ms, note: "answers 401 but does not say how to sign in (no resource_metadata)" };
    if (res.status === 200) return { reachable: true, url, status: 200, ms, note: "reachable" };
    return { reachable: false, url, status: res.status, ms, note: `answered HTTP ${res.status}` };
  } catch (err) {
    return { reachable: false, url, note: `could not connect (${(err as Error).message})` };
  }
}

// ---------------------------------------------------------------------------------------------- options + report

export interface SetupOptions {
  client?: string[];
  yes?: boolean;
  local?: boolean;
  print?: boolean;
  apiUrl?: string;
  readonly?: boolean;
  project?: boolean;
  list?: boolean;
  remove?: boolean;
  doctor?: boolean;
  json?: boolean;
  /** commander's `--no-backup` */
  backup?: boolean;
  /** commander's `--no-check` */
  check?: boolean;
}

export interface Finding {
  level: "problem" | "warn" | "ok";
  client?: ClientId;
  message: string;
  fix?: string;
}

export interface Report {
  ok: boolean;
  action: "setup" | "remove" | "list" | "doctor" | "print";
  url: string;
  results: ClientOutcome[];
  check?: CheckResult;
  findings?: Finding[];
  installed?: { client: ClientId; scope: Scope; file: string; url?: string; stdio: boolean }[];
  steps?: string[];
  try?: string;
  undo?: string;
  error?: string;
  /** The one command (or click) to do next. */
  next: string;
}

export interface SetupDeps {
  env?: SetupEnv;
  run?: Runner;
  ops?: ClientOps;
  ui?: SetupUi;
  fetch?: typeof fetch;
  /** Device login into the profile. Replaceable in tests. */
  login?: (profile: string, apiUrl?: string) => Promise<void>;
  tty?: boolean;
  /** Where the JSON report and plain text go (stdout). */
  log?: (line: string) => void;
  /** Settings files `--doctor` reads for `deniedMcpServers`. */
  settingsFiles?: string[];
}

export function parseClients(values: string[] | undefined): ClientId[] {
  const out: ClientId[] = [];
  for (const raw of (values ?? []).flatMap((v) => v.split(","))) {
    const v = raw.trim().toLowerCase();
    if (!v) continue;
    const id = v === "claude" ? "claude-code" : v === "gemini" ? "gemini-cli" : v === "desktop" ? "claude-desktop" : v === "code" ? "vscode" : v;
    if (!(CLIENTS as readonly string[]).includes(id)) throw new Error(`Unknown client "${raw.trim()}". Use one of: ${CLIENTS.join(", ")}.`);
    out.push(id as ClientId);
  }
  return [...new Set(out)];
}

/** The snippets `--print` shows: nothing is written. */
export async function printSnippets(o: { local: boolean; apiUrl?: string; readonly: boolean; clients?: ClientId[] }, ops: ClientOps = addMcpOps): Promise<string> {
  await ops.load();
  const entry = serverEntry(o.local, o.apiUrl, o.readonly);
  const url = remoteUrl(o.apiUrl, o.readonly);
  const lines: string[] = [];
  for (const client of o.clients?.length ? o.clients : CLIENTS) {
    if (client === "claude-code") {
      lines.push(`# Claude Code\nclaude ${claudeAddArgs(o.local, o.apiUrl, o.readonly).map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}\n`);
    } else if (!o.local && (INSTRUCTIONS as readonly string[]).includes(client)) {
      lines.push(`# ${LABEL[client]}\n${manualSteps(client, url).join("\n")}\n`);
    } else if (client === "codex" && !o.local) {
      lines.push(`# Codex\ncodex mcp add lefine --url ${url}\n`);
    } else {
      const s = ops.snippet(client, entry);
      if (s) lines.push(`# ${LABEL[client]}: ${tidy(s.file)}\n${s.text}\n`);
    }
  }
  if (o.local) lines.push("# Local server: sign in first with\nnpx lefine login --profile mcp\n");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------------- the command

const STALE_DENIED = (text: string): boolean => {
  try {
    const doc = JSON.parse(text) as { deniedMcpServers?: unknown };
    return Array.isArray(doc.deniedMcpServers) && doc.deniedMcpServers.some((d) => /lefine/i.test(JSON.stringify(d)));
  } catch {
    return false;
  }
};

const MANAGED_SETTINGS = [
  "/Library/Application Support/ClaudeCode/managed-settings.json",
  "/etc/claude-code/managed-settings.json",
  "C:\\Program Files\\ClaudeCode\\managed-settings.json",
];

/** Returns the process exit code. */
export async function setupCommand(options: SetupOptions, deps: SetupDeps = {}): Promise<number> {
  const e = deps.env ?? realEnv();
  const cwd = e.cwd ?? process.cwd();
  const ops = deps.ops ?? addMcpOps;
  const run = deps.run ?? realRunner;
  const out = deps.log ?? ((l: string) => console.log(l));
  const tty = deps.tty ?? (process.stdin.isTTY === true && process.stdout.isTTY === true);
  const json = options.json === true || !tty;
  const ui = deps.ui ?? clackUi;
  const local = options.local === true;
  const readonly = options.readonly === true;
  const scope: Scope = options.project ? "project" : "user";
  const url = remoteUrl(options.apiUrl, readonly);
  const action: Report["action"] = options.print ? "print" : options.list ? "list" : options.remove ? "remove" : options.doctor ? "doctor" : "setup";

  const report: Report = { ok: true, action, url, results: [], next: "npx lefine setup" };
  const say = (text: string) => {
    if (!json) ui.line(text);
  };
  const finish = (code: number): number => {
    report.ok = code === 0;
    if (json) out(JSON.stringify(report, null, 2));
    return code;
  };
  const fail = (message: string, next: string): number => {
    report.error = message;
    report.next = next;
    if (!json) ui.warn(red(message));
    return finish(1);
  };

  let wanted: ClientId[];
  try {
    wanted = parseClients(options.client);
  } catch (err) {
    return fail((err as Error).message, `npx lefine setup --client ${WRITABLE[0]}`);
  }
  if (readonly && local) return fail("--readonly applies to the remote server; the local server uses the level of your key.", "npx lefine setup --readonly");

  await ops.load();

  if (options.print) {
    const text = await printSnippets({ local, apiUrl: options.apiUrl, readonly, clients: wanted }, ops);
    if (options.json) {
      report.steps = text.split("\n");
      return finish(0);
    }
    out(text); // snippets are text for a person, also when piped
    return 0;
  }

  if (options.list) return listAction();
  if (options.remove) return removeAction();
  if (options.doctor) return doctorAction();
  return setupAction();

  // ------------------------------------------------------------------------------------------ list
  async function installedLefine(clients?: ClientId[]): Promise<Installed[]> {
    return ops.find(cwd, clients);
  }

  async function claudeEntries(): Promise<Installed[]> {
    // The CLI knows Claude Code's entries best: ask it, show what it says.
    if (!onPath("claude", e) && !deps.run) return [];
    const got = await run("claude", ["mcp", "get", MCP_NAME]);
    if (got.code !== 0) return [];
    const have = parseClaudeGet(got.output);
    return [{ client: "claude-code", scope: have.scope === "user" ? "user" : "project", file: "claude mcp get lefine", config: have.type === "stdio" ? { command: "npx" } : { url: have.url ?? "" } }];
  }

  async function allInstalled(clients?: ClientId[]): Promise<Installed[]> {
    const rows = await installedLefine(clients?.filter((c) => c !== "claude-code"));
    const wantClaude = !clients || clients.includes("claude-code");
    // add-mcp reads ~/.claude.json too; the CLI answer replaces it so Claude Code shows once.
    const merged = rows.filter((r) => r.client !== "claude-code");
    if (wantClaude) {
      const viaCli = await claudeEntries();
      merged.push(...(viaCli.length ? viaCli : rows.filter((r) => r.client === "claude-code")));
    }
    return merged;
  }

  async function listAction(): Promise<number> {
    const rows = await allInstalled(wanted.length ? wanted : undefined);
    report.installed = rows.map((r) => ({ client: r.client, scope: r.scope, file: r.file, url: storedUrl(ops.urlField(r.client), r.config), stdio: isStdio(r.config) }));
    report.next = rows.length ? "npx lefine setup --doctor" : "npx lefine setup";
    if (!json) {
      ui.intro(bold("Lefine in your AI apps"));
      if (rows.length === 0) say("Lefine is not set up in any app yet. Run: npx lefine setup");
      for (const r of rows) say(`${green("✔")} ${bold(LABEL[r.client])}  ${dim(`${r.scope}, ${tidy(r.file)}`)}\n   ${storedUrl(ops.urlField(r.client), r.config) ?? (isStdio(r.config) ? "local server (npx lefine mcp)" : "")}`);
      ui.outro(dim(rows.length ? "Check them: npx lefine setup --doctor" : "Set up: npx lefine setup"));
    }
    return finish(0);
  }

  // ------------------------------------------------------------------------------------------ remove
  async function removeAction(): Promise<number> {
    const rows = await allInstalled(wanted.length ? wanted : undefined);
    const targets = wanted.length ? wanted : [...new Set(rows.map((r) => r.client))];
    if (!json) ui.intro(bold("Removing Lefine"));
    for (const client of targets) {
      if (client === "claude-code") {
        let removed = false;
        let detail = "";
        for (const sc of ["user", "project"] as const) {
          const r = await run("claude", ["mcp", "remove", MCP_NAME, "--scope", sc]);
          if (r.code === 0) removed = true;
          else detail = r.output.split("\n").slice(-1).join(" ").trim();
        }
        report.results.push({ client, status: removed ? "removed" : "absent", detail: removed ? "removed" : `was not there${detail ? ` (${detail})` : ""}` });
        continue;
      }
      if (!isWritable(client)) {
        report.results.push({ client, status: "manual", detail: "added in the app itself: remove Lefine under Settings > Connectors there" });
        continue;
      }
      let removed = false;
      let file = "";
      let error: string | undefined;
      for (const sc of ["user", "project"] as const) {
        const r = ops.remove(client, sc, cwd);
        file = r.removed ? r.file : file || r.file;
        removed ||= r.removed;
        error ||= r.error;
      }
      report.results.push(error ? { client, status: "failed", detail: error } : { client, status: removed ? "removed" : "absent", detail: removed ? "removed" : "was not there", file });
    }
    if (targets.length === 0) say("Lefine was not set up in any app: nothing to remove.");
    for (const o of report.results) say(line(o));
    // No tutorial after a removal: the person is leaving.
    if (!json) ui.outro(dim("Config backups (*.lefine-backup) stay next to the files."));
    report.next = "npx lefine setup --list";
    return finish(report.results.some((o) => o.status === "failed") ? 1 : 0);
  }

  // ------------------------------------------------------------------------------------------ doctor
  async function doctorAction(): Promise<number> {
    const findings: Finding[] = [];
    if (!onPath("claude", e)) findings.push({ level: "warn", client: "claude-code", message: "the `claude` command is not on your PATH, so Claude Code cannot be set up from here", fix: "Install Claude Code, or add its folder to PATH" });
    const rows = await allInstalled(wanted.length ? wanted : undefined);
    const base = remoteUrl(options.apiUrl).replace(/\?.*$/, "");
    const accepted = options.readonly ? [remoteUrl(options.apiUrl, true)] : [remoteUrl(options.apiUrl), remoteUrl(options.apiUrl, true)];
    for (const r of rows) {
      // Only the field this app really reads counts: a URL in another field, or inside a longer string, does not.
      const u = storedUrl(ops.urlField(r.client), r.config);
      if (isStdio(r.config)) {
        findings.push({ level: "problem", client: r.client, message: `${LABEL[r.client]} (${tidy(r.file)}) has an old local \`lefine\` entry that starts a program instead of using ${base}`, fix: "npx lefine setup --yes (it replaces the entry)" });
      } else if (!u || !accepted.some((a) => sameUrl(u, a))) {
        findings.push({ level: "problem", client: r.client, message: `${LABEL[r.client]} (${tidy(r.file)}) ${u ? `points \`lefine\` at ${u}` : "has a `lefine` entry with no URL where the app reads it"}, not ${accepted.join(" or ")}`, fix: "npx lefine setup --yes (it replaces the entry)" });
      } else findings.push({ level: "ok", client: r.client, message: `${LABEL[r.client]}: lefine points at ${u}` });
    }
    if (rows.length === 0) findings.push({ level: "warn", message: "Lefine is not set up in any app", fix: "npx lefine setup" });
    const settings = deps.settingsFiles ?? [join(e.home, ".claude", "settings.json"), join(e.home, ".claude", "settings.local.json"), ...MANAGED_SETTINGS];
    for (const f of settings) {
      if (!existsSync(f)) continue;
      let text = "";
      try {
        text = readFileSync(f, "utf-8");
      } catch {
        continue;
      }
      if (STALE_DENIED(text)) findings.push({ level: "problem", client: "claude-code", message: `${tidy(f)} lists lefine in deniedMcpServers: Claude Code refuses to start it`, fix: `Remove the lefine entry from deniedMcpServers in ${tidy(f)} (this command does not edit your settings)` });
    }
    if (options.check !== false) {
      report.check = await checkConnection(url, deps.fetch);
      findings.push(report.check.reachable ? { level: "ok", message: `${url} is reachable` } : { level: "problem", message: `${url}: ${report.check.note}`, fix: "Check your network or proxy, then run the doctor again" });
    }
    report.findings = findings;
    const problems = findings.filter((f) => f.level === "problem");
    report.next = problems[0]?.fix ?? (findings.some((f) => f.level === "warn" && f.fix) ? findings.find((f) => f.level === "warn" && f.fix)!.fix! : "npx lefine setup --list");
    if (!json) {
      ui.intro(bold("Lefine doctor"));
      for (const f of findings) say(`${f.level === "ok" ? green("✔") : f.level === "warn" ? yellow("!") : red("x")} ${f.message}${f.fix ? `\n   ${dim(`Fix: ${f.fix}`)}` : ""}`);
      ui.outro(problems.length ? red(`${problems.length} problem${problems.length > 1 ? "s" : ""} found`) : green("No problems found"));
    }
    return finish(problems.length ? 1 : 0);
  }

  // ------------------------------------------------------------------------------------------ setup
  function line(o: ClientOutcome): string {
    const mark = o.status === "failed" ? red("x") : o.status === "manual" ? yellow("!") : o.status === "absent" ? dim("-") : green("✔");
    const verb = o.status === "added" ? 'added "lefine"' : o.status === "updated" ? 'updated "lefine"' : o.status === "unchanged" ? "already set up" : o.status === "removed" ? 'removed "lefine"' : o.detail;
    const where = o.file ? `  ${dim(tidy(o.file))}` : "";
    const extra = o.status === "failed" || o.status === "manual" || o.status === "absent" ? "" : o.backup ? `  ${dim(`(backup: ${tidy(o.backup)}, owner-only)`)}` : "";
    return `${mark} ${bold(LABEL[o.client].padEnd(14))} ${o.status === "failed" || o.status === "manual" ? o.detail : verb}${where}${extra}`;
  }

  async function setupAction(): Promise<number> {
    let targets = wanted;
    let useReadonly = readonly;
    let useScope = scope;
    const detected = targets.length ? [] : await detectClients(e, ops);

    if (!json) {
      ui.intro(bold("Lefine connects your AI app to your content."));
      say("It can read and edit. It asks you before it publishes (unless you turn that off in Settings).");
    }

    if (targets.length === 0) {
      if (json || options.yes) {
        if (!options.yes) return fail("Not a terminal: pass --yes (every AI app found) or --client <name>.", "npx lefine setup --yes");
        targets = detected;
        if (targets.length === 0) {
          report.steps = manualSteps("claude-desktop", url);
          return fail(`No AI app found on this machine (${WRITABLE.map((c) => LABEL[c]).join(", ")}).`, `npx lefine setup --client ${WRITABLE.join(" | ")}`);
        }
      } else {
        const picked = await ui.multiselect(
          "Which apps do you want to set up?  (space = toggle, enter = confirm)",
          CLIENTS.map((c) => ({
            value: c,
            label: LABEL[c],
            hint: (INSTRUCTIONS as readonly string[]).includes(c) ? "steps only: added in the app" : detected.includes(c) ? "found" : "not found, still selectable",
          })),
          detected,
        );
        if (!picked) return cancelled();
        targets = picked;
        if (targets.length === 0) {
          say("Nothing chosen.");
          ui.outro("Done");
          return finish(0);
        }
        if (!options.readonly && !options.project) {
          const mode = await ui.select("How do you want to install?", [
            { value: "defaults", label: "Install with defaults", hint: "for you only, can edit, asks before publish" },
            { value: "customize", label: "Customize", hint: "read-only, one project folder" },
          ]);
          if (!mode) return cancelled();
          if (mode === "customize") {
            const ro = await ui.confirm("Read-only? (the AI can look, not change anything)", false);
            if (ro === null) return cancelled();
            useReadonly = ro;
            const sc = await ui.select<Scope>("Where should it apply?", [
              { value: "user", label: "For you, in every project" },
              { value: "project", label: "This project folder only", hint: "writes a file in the current folder" },
            ]);
            if (!sc) return cancelled();
            useScope = sc;
          }
        }
      }
    }

    const finalUrl = remoteUrl(options.apiUrl, useReadonly);
    report.url = finalUrl;
    const entry = serverEntry(local, options.apiUrl, useReadonly);

    if (local && !profileExists(LOCAL_PROFILE)) {
      say(`Local server: signing in first (saved as profile "${LOCAL_PROFILE}", your other keys stay as they are).`);
      await (deps.login ?? ((profile, apiUrl) => loginCommand({ profile, apiUrl })))(LOCAL_PROFILE, options.apiUrl);
      if (!profileExists(LOCAL_PROFILE)) return fail("Sign-in did not finish, so nothing was set up.", "npx lefine login --profile mcp");
    }

    for (const client of targets) {
      let outcome: ClientOutcome;
      if (client === "claude-code") {
        outcome =
          !onPath("claude", e) && !deps.run
            ? { client, status: "failed", detail: "the `claude` command is not on your PATH. Install Claude Code, or run: claude mcp add --transport http --scope user lefine " + finalUrl }
            : await setupClaudeCode({ local, apiUrl: options.apiUrl, readonly: useReadonly, scope: useScope }, run);
      } else if (!local && (INSTRUCTIONS as readonly string[]).includes(client)) {
        // claude_desktop_config.json only starts local servers; a url entry there does not load. Remote ones are Connectors.
        outcome = { client, status: "manual", detail: manualSteps(client, finalUrl).join(" ") };
      } else if (local && client === "chatgpt") {
        outcome = { client, status: "manual", detail: "ChatGPT cannot start a local server. Use the remote one: npx lefine setup --client chatgpt" };
      } else {
        outcome = await writeClient(client, entry, useScope);
      }
      report.results.push(outcome);
      say(line(outcome));
    }

    const live = report.results.filter((o) => o.status === "added" || o.status === "updated" || o.status === "unchanged");
    const failed = report.results.filter((o) => o.status === "failed");

    if (!local && options.check !== false && report.results.some((o) => o.status !== "failed")) {
      report.check = json
        ? await checkConnection(finalUrl, deps.fetch)
        : await ui.spin("Checking the server...", () => checkConnection(finalUrl, deps.fetch), (c) => (c.reachable ? `Server reachable ✓  ${dim(`(${finalUrl}, ${c.ms} ms)`)}` : `Server check: ${c.note}`));
      if (!json && !report.check.reachable) ui.warn(yellow("The config is written, but the server did not answer as expected. Check your network, then run: npx lefine setup --doctor"));
    }

    const steps = live.map((o) => nextClick(o.client));
    const manual = report.results.filter((o) => o.status === "manual");
    for (const m of manual) steps.push(`${LABEL[m.client]}: ${m.detail}`);
    report.steps = steps;
    report.try = TRY_PROMPT;
    report.undo = UNDO;
    report.next = failed.length ? "npx lefine setup --doctor" : steps[0] ?? "npx lefine setup --list";

    if (!json) {
      if (live.length && !local) {
        say(`${bold("One more step: sign in once.")}\n${live.map((o) => `  ${nextClick(o.client)}`).join("\n")}\nA browser page opens. Pick your workspace and click Approve.`);
        say(`${bold("Then say this to your AI app:")}\n  "${TRY_PROMPT}"`);
      } else if (live.length) {
        say(`Restart ${live.map((o) => LABEL[o.client]).join(" / ")}. Lefine starts by itself with the key you just saved.`);
      }
      if (useReadonly && !local) say("Read-only: the AI can look, not change. Run setup again without --readonly to allow edits.");
      ui.outro(`Undo any time: ${bold(UNDO)}`);
    }
    return finish(failed.length ? 1 : 0);

    function cancelled(): number {
      if (!json) ui.outro("Cancelled. Nothing was changed.");
      return finish(0);
    }
  }

  async function writeClient(client: ClientId, entry: ServerEntry, sc: Scope): Promise<ClientOutcome> {
    // Read the current entry first: the same one is left alone (no rewrite, no backup), another one is replaced.
    const before = (await ops.find(cwd, [client])).find((r) => r.scope === sc);
    if (before && (entry.command !== undefined ? isStdio(before.config) && JSON.stringify(before.config.args) === JSON.stringify(entry.args) : !isStdio(before.config) && sameUrl(storedUrl(ops.urlField(client), before.config), entry.url))) {
      return { client, status: "unchanged", detail: "already set up", file: before.file };
    }
    const r = ops.write(client, entry, sc, cwd, options.backup !== false);
    if (!r.ok) return { client, status: "failed", detail: `${tidy(r.file)}: ${r.error}` };
    return { client, status: before ? "updated" : "added", detail: before ? "updated" : "added", file: r.file, backup: r.backup };
  }
}

/** The hint `lefine mcp` prints when a person runs it by hand. */
export const MCP_HINT = "This is the MCP server an AI app starts. It waits for that app, so it looks stuck on its own.\nTo set it up, run: npx lefine setup";
