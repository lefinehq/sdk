/**
 * `lefine login | logout | whoami`. Device flow (RFC 8628): no localhost
 * callback, so it works over SSH and in containers.
 */

import { execFile } from "node:child_process";
import { bold, cyan, dim, green, red } from "../utils/colors.js";
import { safeJson, safeText } from "./safe-text.js";
import {
  LefineError,
  explainError,
  getMe,
  pollDeviceToken,
  requestDeviceCode,
  type DeviceToken,
} from "./client.js";
import {
  clearCredentials,
  credentialsPath,
  resolveApiUrl,
  resolveLefineAuth,
  saveCredentials,
} from "./credentials.js";

export interface GlobalOptions {
  apiUrl?: string;
  token?: string;
  json?: boolean;
}

/** Print an error the way every lefine command does, then exit 1. */
export function fail(err: unknown, json?: boolean): never {
  const lefine = err instanceof LefineError ? err : null;
  const message = safeText(lefine ? explainError(lefine) : err instanceof Error ? err.message : String(err));
  if (json) console.log(safeJson({ ok: false, code: lefine?.code ?? "ERROR", error: message }));
  else console.error(red(`  ${message}`));
  process.exit(1);
}

export const out = (json: boolean | undefined, data: unknown, text: () => void): void => {
  if (json) console.log(safeJson({ ok: true, ...(data as object) }));
  else text();
};

export interface LoginDeps {
  /** Replaceable so tests do not wait or open a browser. */
  sleep?: (ms: number) => Promise<void>;
  openBrowser?: (url: string) => void;
  now?: () => number;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Command that opens `raw` in a browser, or null when it is not a plain
 * http(s) URL. The URL comes from the server, so it is parsed first, and on
 * Windows it never goes through `cmd` (its metacharacters, like `&`, run commands).
 */
export function browserCommand(raw: string, platform: NodeJS.Platform = process.platform): [string, string[]] | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (platform === "darwin") return ["open", [url.href]];
  if (platform === "win32") return ["rundll32", ["url.dll,FileProtocolHandler", url.href]];
  return ["xdg-open", [url.href]];
}

const on = (v: string | undefined) => v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";

/**
 * Whether the CLI may open a browser. Only for a person at a terminal: never with LEFINE_NO_BROWSER, in CI, under a
 * test runner (bun test sets NODE_ENV=test), or when stdout is not a terminal (a pipe, a script, a smoke run). The
 * link is printed either way. A test run once opened its fake approval links in a real browser.
 */
export const browserAllowed = (env: NodeJS.ProcessEnv = process.env, tty: boolean | undefined = process.stdout.isTTY): boolean =>
  !on(env.LEFINE_NO_BROWSER) && !on(env.CI) && env.NODE_ENV !== "test" && tty === true;

export function openInBrowser(url: string): void {
  if (!browserAllowed()) return;
  const command = browserCommand(url);
  if (!command) return; // the URL is printed anyway
  try {
    // No browser (SSH, container) is fine: the URL is printed anyway.
    execFile(command[0], command[1], () => {}).on("error", () => {});
  } catch {
    /* ignore */
  }
}

export interface LoginOptions extends GlobalOptions {
  /** Commander sets this to false for `--no-browser`. */
  browser?: boolean;
}

export async function loginCommand(options: LoginOptions, deps: LoginDeps = {}): Promise<void> {
  const apiUrl = resolveApiUrl(options.apiUrl);
  const sleep = deps.sleep ?? realSleep;
  const now = deps.now ?? Date.now;

  try {
    if (options.token) {
      // Pasted key: ask the server who it belongs to before storing it.
      const me = await getMe(apiUrl, options.token);
      saveCredentials({
        token: options.token,
        apiUrl,
        workspace: { id: me.workspace.id, slug: me.workspace.slug, name: me.workspace.name },
        scopes: me.scopes,
        savedAt: new Date().toISOString(),
      });
      out(options.json, { workspace: me.workspace, scopes: me.scopes }, () =>
        console.log(`  ${green("✓")} Signed in to ${bold(safeText(me.workspace.name))} (${safeText(me.workspace.slug)}).`),
      );
      return;
    }

    const code = await requestDeviceCode(apiUrl, "lefine-cli");
    if (!options.json) {
      console.log();
      console.log(`  Open ${cyan(safeText(code.verification_uri))} and enter the code:`);
      console.log();
      console.log(`    ${bold(safeText(code.user_code))}`);
      console.log();
      console.log(dim(`  Or open ${safeText(code.verification_uri_complete)}`));
      console.log(dim("  Waiting for approval..."));
    }
    if (options.browser !== false) (deps.openBrowser ?? openInBrowser)(code.verification_uri_complete);

    let interval = Math.max(1, code.interval) * 1000;
    const deadline = now() + code.expires_in * 1000;
    let granted: DeviceToken | null = null;

    while (!granted) {
      if (now() >= deadline) throw new Error("The code expired before it was approved. Run `lefine login` again.");
      await sleep(interval);
      const result = await pollDeviceToken(apiUrl, code.device_code);
      switch (result.status) {
        case "ok":
          granted = result.token;
          break;
        case "pending":
          break;
        case "slow_down":
          interval += 5000; // RFC 8628 §3.5
          break;
        case "denied":
          throw new Error("Login was denied in the browser. Run `lefine login` to try again.");
        case "expired":
          throw new Error("The code expired before it was approved. Run `lefine login` again.");
        default:
          throw new Error("The server did not accept this login. Run `lefine login` again.");
      }
    }

    saveCredentials({
      token: granted.access_token,
      apiUrl,
      workspace: granted.workspace,
      scopes: granted.scopes,
      savedAt: new Date().toISOString(),
    });
    out(options.json, { workspace: granted.workspace, scopes: granted.scopes }, () => {
      console.log();
      console.log(`  ${green("✓")} Signed in to ${bold(safeText(granted!.workspace.name))} (${safeText(granted!.workspace.slug)}).`);
      console.log(dim(`  Access: ${safeText(granted!.scopes.join(", "))}`));
      console.log(dim(`  Saved to ${credentialsPath()}`));
    });
  } catch (err) {
    fail(err, options.json);
  }
}

export function logoutCommand(options: GlobalOptions): void {
  const removed = clearCredentials();
  out(options.json, { removed }, () =>
    console.log(removed ? `  ${green("✓")} Signed out. Removed ${credentialsPath()}.` : "  You were not signed in."),
  );
}

export async function whoamiCommand(options: GlobalOptions): Promise<void> {
  try {
    const auth = resolveLefineAuth(options);
    if (!auth) throw new LefineError("UNAUTHORIZED", "no key");
    const me = await getMe(auth.apiUrl, auth.token);
    out(options.json, { ...me, source: auth.source, apiUrl: auth.apiUrl }, () => {
      const who = safeText(me.user?.email || me.user?.name || "unknown user");
      console.log(`  ${bold(who)} in ${bold(safeText(me.workspace.name))} (${safeText(me.workspace.slug)})`);
      console.log(dim(`  Access: ${safeText(me.scopes.join(", "))}`));
      console.log(dim(`  Apps: ${me.apps === null ? "all" : me.apps.length}`));
      console.log(dim(`  Key from ${auth.source}, API ${auth.apiUrl}`));
    });
  } catch (err) {
    fail(err, options.json);
  }
}
