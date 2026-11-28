/**
 * "A newer version is out" for the `lefine` CLI and the MCP server. Same shape as update-notifier and wrangler:
 * ask the npm registry at most once a day, keep the answer in a cache file, and say it on the NEXT start, so a
 * start never waits for the network. Off in CI, with LEFINE_NO_UPDATE_CHECK=1 (or NO_UPDATE_NOTIFIER), and when
 * the registry cannot be reached. Every failure here is swallowed: this file must never break a command.
 *
 * Which tags: a stable version is compared with `latest`; a prerelease with the higher of `next` and `latest`.
 * The cache is ~/.lefine/update-check.json (LEFINE_HOME moves it): { "<package>": { checkedAt, tags } }.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { dirname, join } from "node:path";
import { configDir } from "./credentials.js";

export const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const CHECK_TIMEOUT_MS = 1500;

export interface Host {
  name: string;
  version: string;
}
export interface UpdateInfo extends Host {
  /** The newer version. */
  latest: string;
  /** The dist-tag it sits on (`latest` or `next`). */
  tag: string;
}
type Tags = Record<string, string>;
type Cache = Record<string, { checkedAt: number; tags: Tags }>;

/** Which package this process runs as. `lefine.ts` sets it; the `@lefine/mcp` bin names itself in LEFINE_HOST_PACKAGE ("@lefine/mcp@1.0.0-rc.2"), because that is the copy npx keeps. */
let own: Host = { name: "lefine", version: "0.0.0" };
export const setHost = (host: Host): void => {
  own = host;
};
export function hostPackage(env: NodeJS.ProcessEnv = process.env): Host {
  const spec = env.LEFINE_HOST_PACKAGE;
  const at = spec ? spec.lastIndexOf("@") : -1;
  return spec && at > 0 ? { name: spec.slice(0, at), version: spec.slice(at + 1) } : own;
}

/** The dist-tag a version was published to by our convention: a prerelease is `next`, anything else `latest`. */
export const tagOf = (version: string): string => (version.includes("-") ? "next" : "latest");

/** Semver order of two versions (prerelease sorts below its release). Unparseable input compares equal. */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(v.trim());
    return m ? { n: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split(".") : [] } : null;
  };
  const x = parse(a);
  const y = parse(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i]! < y.n[i]! ? -1 : 1;
  if (x.pre.length === 0 || y.pre.length === 0) return x.pre.length === y.pre.length ? 0 : x.pre.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i];
    const q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p);
    const qn = /^\d+$/.test(q);
    if (pn && qn) return Number(p) < Number(q) ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}

/** The newer version this host should move to, or null. */
export function pickUpdate(host: Host, tags: Tags): UpdateInfo | null {
  const wanted = tagOf(host.version) === "latest" ? ["latest"] : ["next", "latest"];
  let best: UpdateInfo | null = null;
  for (const tag of wanted) {
    const v = tags[tag];
    if (typeof v !== "string" || compareVersions(v, host.version) <= 0) continue;
    if (!best || compareVersions(v, best.latest) > 0) best = { ...host, latest: v, tag };
  }
  return best;
}

export function updateCheckDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const on = (v: string | undefined) => v !== undefined && v !== "" && v !== "0" && v !== "false";
  return on(env.LEFINE_NO_UPDATE_CHECK) || "NO_UPDATE_NOTIFIER" in env || on(env.CI) || on(env.GITHUB_ACTIONS);
}

const cachePath = (): string => join(configDir(), "update-check.json");

function readCache(file: string): Cache {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Cache) : {};
  } catch {
    return {};
  }
}

function writeCache(file: string, cache: Cache): void {
  try {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(cache) + "\n", { mode: 0o600 });
    renameSync(tmp, file);
  } catch {
    /* a read-only home is fine: the check just runs again next time */
  }
}

/** The registry's dist-tags for a package. The socket is unref'd, so a command that ends first is never held up. */
export function fetchDistTags(name: string, timeoutMs = CHECK_TIMEOUT_MS): Promise<Tags | null> {
  return new Promise((resolve) => {
    const req = request(
      { host: "registry.npmjs.org", path: `/-/package/${encodeURIComponent(name)}/dist-tags`, headers: { accept: "application/json", "user-agent": "lefine-update-check" }, timeout: timeoutMs },
      (res) => {
        let body = "";
        res.setEncoding("utf-8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => {
          try {
            const parsed: unknown = JSON.parse(body);
            resolve(res.statusCode === 200 && parsed && typeof parsed === "object" ? (parsed as Tags) : null);
          } catch {
            resolve(null);
          }
        });
        res.on("error", () => resolve(null));
      },
    );
    req.on("socket", (s) => s.unref());
    req.on("timeout", () => req.destroy());
    req.on("error", () => resolve(null));
    req.end();
  });
}

export interface CheckDeps {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** Test seam. */
  fetchTags?: (name: string) => Promise<Tags | null>;
  timeoutMs?: number;
  file?: string;
}

/** What the cache says right now, with no network: the update to tell about, or null. */
export function cachedUpdate(host: Host, deps: CheckDeps = {}): UpdateInfo | null {
  if (updateCheckDisabled(deps.env)) return null;
  const entry = readCache(deps.file ?? cachePath())[host.name];
  return entry && entry.tags && typeof entry.tags === "object" ? pickUpdate(host, entry.tags) : null;
}

/**
 * Asks the registry when the cache is older than a day, and stores the answer. Never throws, gives up after
 * `timeoutMs`, and resolves to the update the registry shows (null: none, disabled, still fresh, or unreachable).
 */
export async function refreshUpdate(host: Host, deps: CheckDeps = {}): Promise<UpdateInfo | null> {
  try {
    if (updateCheckDisabled(deps.env)) return null;
    const now = (deps.now ?? Date.now)();
    const file = deps.file ?? cachePath();
    const cache = readCache(file);
    const entry = cache[host.name];
    if (entry && typeof entry.checkedAt === "number" && now - entry.checkedAt >= 0 && now - entry.checkedAt < CHECK_INTERVAL_MS) return null;
    const timeoutMs = deps.timeoutMs ?? CHECK_TIMEOUT_MS;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tags = await Promise.race([
      (deps.fetchTags ?? ((n: string) => fetchDistTags(n, timeoutMs)))(host.name).catch(() => null),
      new Promise<null>((r) => {
        timer = setTimeout(() => r(null), timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!tags) return null;
    writeCache(file, { ...cache, [host.name]: { checkedAt: now, tags } });
    return pickUpdate(host, tags);
  } catch {
    return null;
  }
}

/** The command that puts the app config on a tagged copy (so a restart refetches). */
export const refreshCommand = (u: UpdateInfo): string => `npx ${u.name}@${u.tag} setup --local`;

/** One line for a person at a terminal running the CLI. */
export function cliNotice(u: UpdateInfo, env: NodeJS.ProcessEnv = process.env): string {
  const how = env.npm_command === "exec" ? `npx ${u.name}@${u.tag} ...` : `npm i ${u.name}@${u.tag}`;
  return `${u.name} ${u.latest} is out (you have ${u.version}). Update: ${how}   (silence: LEFINE_NO_UPDATE_CHECK=1)`;
}

/** The stderr line of the MCP server. */
export const serverNotice = (u: UpdateInfo): string =>
  `lefine mcp: ${u.latest} is out (you run ${u.version}). Restart your AI app to get it. Still ${u.version} after a restart? Run: ${refreshCommand(u)}`;

/** The one sentence added to the server's `instructions`, so the AI app can tell the person. */
export const aiNotice = (u: UpdateInfo): string =>
  `Lefine update: a newer Lefine MCP (${u.latest}) is out. Tell the person once, in plain words, that restarting this app gets it (if the version stays, they can run \`${refreshCommand(u)}\`).`;
