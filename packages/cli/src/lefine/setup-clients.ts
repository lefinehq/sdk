/**
 * The AI apps `lefine setup` knows, and how it reads and writes their MCP config.
 *
 * Config paths and file formats (JSON, TOML, YAML; key names; Windows, macOS, Linux folders) come from the
 * `add-mcp` package (Apache-2.0, github.com/neon-solutions/add-mcp, by the Neon team): 24+ clients that we
 * do not want to track by hand. Two things stay ours: Claude Code goes through `claude mcp add` (see
 * setup-command.ts), and the backup of a config file before we touch it (0600, once).
 *
 * `add-mcp` fixes the home folder when it loads, so it is imported lazily, on first use.
 */

import { closeSync, existsSync, lstatSync, openSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { parse as parseJsonc, type ParseError } from "jsonc-parser";
import { homedir } from "node:os";

export const MCP_NAME = "lefine";

/** Apps with an MCP config we can write (through add-mcp), or Claude Code (through its CLI). */
export const WRITABLE = ["claude-code", "cursor", "vscode", "windsurf", "codex", "gemini-cli", "zed"] as const;
/** Apps where the person adds the URL in the app itself: no file of ours to write. */
export const INSTRUCTIONS = ["claude-desktop", "chatgpt"] as const;
export const CLIENTS = [...WRITABLE, ...INSTRUCTIONS] as const;
export type ClientId = (typeof CLIENTS)[number];

export const LABEL: Record<ClientId, string> = {
  "claude-code": "Claude Code",
  cursor: "Cursor",
  vscode: "VS Code",
  windsurf: "Windsurf",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
  zed: "Zed",
  "claude-desktop": "Claude Desktop",
  chatgpt: "ChatGPT",
};

export const isWritable = (c: ClientId): boolean => (WRITABLE as readonly string[]).includes(c);

/** The server entry add-mcp writes (it adapts it to each app's file shape). */
export interface ServerEntry {
  type?: "http";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
}

export type Scope = "user" | "project";

export interface Installed {
  client: ClientId;
  scope: Scope;
  file: string;
  config: Record<string, unknown>;
}

export interface WriteResult {
  ok: boolean;
  file: string;
  backup?: string;
  error?: string;
}

/** Everything setup does to config files. Replaceable in tests. */
export interface ClientOps {
  /** Load the client table now: write, remove and snippet are synchronous and need it. */
  load(): Promise<void>;
  /** The key this app reads the server URL from (`url`, `serverUrl`, `httpUrl`...). */
  urlField(client: ClientId): string;
  /** Apps whose config folder exists (Claude Code is detected by `claude` on PATH, not here). */
  detect(): Promise<ClientId[]>;
  /** Our `lefine` entry in every app and scope where one exists. */
  find(cwd: string, clients?: ClientId[]): Promise<Installed[]>;
  write(client: ClientId, entry: ServerEntry, scope: Scope, cwd: string, backup: boolean): WriteResult;
  remove(client: ClientId, scope: Scope, cwd: string): { ok: boolean; removed: boolean; file: string; error?: string };
  /** Where the entry would go, and its text as that app stores it (for --print). */
  snippet(client: ClientId, entry: ServerEntry): { file: string; text: string } | null;
}

type AddMcp = typeof import("add-mcp");
let lib: Promise<AddMcp> | undefined;
let loaded: AddMcp | undefined;
const addMcp = (): Promise<AddMcp> => (lib ??= import("add-mcp").then((m) => (loaded = m)));

/** True when `a` and `b` are the same URL, parsed (scheme, host, path and query all equal). Not a substring test. */
export function sameUrl(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.href === y.href;
  } catch {
    return false;
  }
}

/** The URL a stored entry really uses: the one field this app reads (`url`, `serverUrl`, `httpUrl`...), nothing else. */
export function storedUrl(field: string, config: Record<string, unknown>): string | undefined {
  const v = config[field];
  return typeof v === "string" ? v : undefined;
}

/** A local (stdio) entry: it starts a program. */
export const isStdio = (config: Record<string, unknown>): boolean => typeof config.command === "string";

const isLink = (p: string): boolean => {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * Why a config path must not be read or written, or undefined when it is fine. A symlink at the file would send
 * our write (or the backup) wherever it points; with `root` (project scope) the real path must also stay inside
 * that folder, so a `../` or a linked folder cannot reach out of the project.
 */
export function unsafePath(file: string, root?: string): string | undefined {
  if (isLink(file)) return `${file} is a symbolic link, so it was left as it is`;
  if (root) {
    const base = resolve(root);
    const target = resolve(file);
    if (target !== base && !target.startsWith(base + sep)) return `${file} is outside the project folder ${base}, so it was left as it is`;
    let dir = dirname(target);
    while (!existsSync(dir) && dirname(dir) !== dir) dir = dirname(dir);
    const realBase = realpathSync.native(base);
    const realDir = realpathSync.native(dir);
    if (realDir !== realBase && !realDir.startsWith(realBase + sep)) return `${file} resolves outside the project folder ${base} (a linked folder), so it was left as it is`;
  }
  return undefined;
}

/**
 * Copy a config file next to itself, once, readable by its owner only: it may hold other servers' keys.
 * Created with O_EXCL (`wx`): it never opens an existing file or follows a link at the backup path.
 */
export function backupFile(file: string): { path?: string; error?: string } {
  if (!existsSync(file)) return {};
  const backup = `${file}.lefine-backup`;
  if (isLink(backup)) return { error: `${backup} is a symbolic link, so nothing was changed` };
  if (existsSync(backup)) return {}; // the first backup is the person's original
  const data = readFileSync(file);
  let fd: number;
  try {
    fd = openSync(backup, "wx", 0o600);
  } catch (err) {
    return { error: `could not create the backup ${backup} (${(err as Error).message}), so nothing was changed` };
  }
  try {
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
  return { path: backup };
}

/** Why a JSON config file cannot be edited, or undefined. Comments and trailing commas are allowed (VS Code, Zed). */
export function brokenJson(file: string): string | undefined {
  if (!/\.jsonc?$/.test(file) || !existsSync(file)) return undefined;
  const text = readFileSync(file, "utf-8");
  if (text.trim() === "") return undefined;
  const errors: ParseError[] = [];
  const doc: unknown = parseJsonc(text, errors, { allowTrailingComma: true });
  if (errors.length > 0) return "it is not valid JSON";
  if (!doc || typeof doc !== "object" || Array.isArray(doc)) return "it is not a JSON object";
  return undefined;
}

const toServerConfig = (entry: ServerEntry) => ({ ...entry }) as import("add-mcp").McpServerConfig;

export const addMcpOps: ClientOps = {
  async load() {
    await addMcp();
  },

  async detect() {
    const { detectGlobalAgents } = await addMcp();
    const found = new Set<string>(await detectGlobalAgents());
    return WRITABLE.filter((c) => c !== "claude-code" && found.has(c));
  },

  async find(cwd, clients = [...WRITABLE]) {
    const { listInstalledServers } = await addMcp();
    const out: Installed[] = [];
    const all = clients.filter((c) => isWritable(c)) as import("add-mcp").AgentType[];
    for (const scope of ["user", "project"] as const) {
      // A config that is a symlink (or leaves the project folder) is not read: see unsafePath.
      const ids = all.filter((c) => {
        const t = loaded?.agents[c];
        if (!t) return true;
        const f = scope === "project" ? (t.localConfigPath ? join(cwd, t.localConfigPath) : undefined) : t.configPath;
        return f === undefined || unsafePath(f, scope === "project" ? cwd : undefined) === undefined;
      });
      if (ids.length === 0) continue;
      const lists = await listInstalledServers({ global: scope === "user", agents: ids, cwd });
      for (const l of lists) {
        for (const s of l.servers) {
          if (s.serverName.toLowerCase() === MCP_NAME) out.push({ client: l.agentType as ClientId, scope, file: s.configPath, config: s.config });
        }
      }
    }
    // With the project folder equal to the home folder the two scopes are one file: show it once.
    const seen = new Set<string>();
    return out.filter((r) => {
      const key = `${r.client}|${realpathSync.native(r.file)}`;
      return seen.has(key) ? false : (seen.add(key), true);
    });
  },

  write(client, entry, scope, cwd, backup) {
    const mod = loaded;
    if (!mod) return { ok: false, file: "", error: "add-mcp is not loaded" };
    const local = scope === "project";
    const target = mod.agents[client as import("add-mcp").AgentType];
    const file = local && target.localConfigPath ? join(cwd, target.localConfigPath) : target.configPath;
    const unsafe = unsafePath(file, local ? cwd : undefined);
    if (unsafe) return { ok: false, file, error: unsafe };
    // add-mcp edits a broken JSON file in place and leaves it more broken: refuse those (comments are fine).
    const broken = brokenJson(file);
    if (broken) return { ok: false, file, error: `${broken}, so it was left as it is` };
    const made = backup ? backupFile(file) : {};
    if (made.error) return { ok: false, file, error: made.error };
    const r = mod.upsertServer(client, MCP_NAME, toServerConfig(entry), { local, cwd });
    return r.success ? { ok: true, file: r.path, backup: made.path } : { ok: false, file: r.path || file, error: r.error ?? "could not write the file" };
  },

  remove(client, scope, cwd) {
    const mod = loaded;
    if (!mod) return { ok: false, removed: false, file: "", error: "add-mcp is not loaded" };
    const t = mod.agents[client as import("add-mcp").AgentType];
    const f = scope === "project" ? (t.localConfigPath ? join(cwd, t.localConfigPath) : "") : t.configPath;
    const unsafe = f ? unsafePath(f, scope === "project" ? cwd : undefined) : undefined;
    if (unsafe) return { ok: false, removed: false, file: f, error: unsafe };
    const r = mod.removeServer(client, MCP_NAME, { local: scope === "project", cwd });
    return { ok: r.success, removed: r.removed, file: r.path, error: r.error };
  },

  urlField(client) {
    const mod = loaded;
    const agent = mod?.agents[client as import("add-mcp").AgentType];
    if (!agent) return "url";
    const probe = "https://probe.invalid/mcp";
    const shaped = agent.transformConfig(MCP_NAME, toServerConfig({ type: "http", url: probe }), { local: false }) as Record<string, unknown> | undefined;
    return Object.entries(shaped ?? {}).find(([, v]) => v === probe)?.[0] ?? "url";
  },

  snippet(client, entry) {
    const mod = loaded;
    if (!mod) return null;
    const agent = mod.agents[client as import("add-mcp").AgentType];
    if (!agent || agent.format !== "json") return null;
    const value = agent.transformConfig(MCP_NAME, toServerConfig(entry), { local: false });
    const doc = agent.configKey.split(".").reduceRight<unknown>((inner, key) => ({ [key]: inner }), { [MCP_NAME]: value });
    return { file: agent.configPath, text: JSON.stringify(doc, null, 2) };
  },
};


/** `~/…` for a path inside the home folder: shorter to read. */
export const tidy = (file: string, home = homedir()): string => (file.startsWith(home) ? `~${file.slice(home.length)}` : file);
