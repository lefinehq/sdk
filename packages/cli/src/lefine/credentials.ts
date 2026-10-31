/**
 * Lefine credentials: `~/.lefine/credentials.json` (dir 0700, file 0600).
 * `LEFINE_TOKEN` wins over the file so CI never needs one.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULT_API_URL = "https://dash.lefine.ai";
export const DEFAULT_CDN_URL = "https://cdn.lefine.ai";

export interface LefineWorkspace {
  id: string;
  slug: string;
  name: string;
}

export interface LefineCredentials {
  token: string;
  apiUrl: string;
  workspace: LefineWorkspace;
  scopes: string[];
  savedAt: string;
}

/** Read per call so tests (and users) can point `LEFINE_HOME` elsewhere. */
const configDir = () => process.env.LEFINE_HOME || join(homedir(), ".lefine");
export const credentialsPath = () => join(configDir(), "credentials.json");

export function saveCredentials(creds: LefineCredentials): void {
  const dir = configDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const file = credentialsPath();
  // `mode` only applies when the file is created; chmod covers an existing looser one.
  writeFileSync(file, JSON.stringify(creds, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  chmodSync(file, 0o600);
}

export function loadCredentials(): LefineCredentials | null {
  const file = credentialsPath();
  if (!existsSync(file)) return null;
  try {
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as Partial<LefineCredentials>;
    return typeof parsed.token === "string" && typeof parsed.apiUrl === "string"
      ? (parsed as LefineCredentials)
      : null;
  } catch {
    return null;
  }
}

export function clearCredentials(): boolean {
  const file = credentialsPath();
  if (!existsSync(file)) return false;
  unlinkSync(file);
  return true;
}

export interface ResolvedLefineAuth {
  token: string;
  apiUrl: string;
  /** "oidc": traded for this run from GitHub Actions (github-oidc.ts); never saved. */
  source: "flag" | "env" | "file" | "oidc";
}

export const resolveApiUrl = (flag?: string): string =>
  (flag || process.env.LEFINE_API_URL || DEFAULT_API_URL).replace(/\/+$/, "");

export function resolveLefineAuth(options: { token?: string; apiUrl?: string }): ResolvedLefineAuth | null {
  if (options.token) {
    return { token: options.token, apiUrl: resolveApiUrl(options.apiUrl), source: "flag" };
  }
  if (process.env.LEFINE_TOKEN) {
    return { token: process.env.LEFINE_TOKEN, apiUrl: resolveApiUrl(options.apiUrl), source: "env" };
  }
  const stored = loadCredentials();
  if (stored) {
    // A saved key is only ever sent to the server it was saved for. Any other
    // origin (flag, env var) must not receive it.
    const saved = stored.apiUrl.replace(/\/+$/, "");
    const override = options.apiUrl || process.env.LEFINE_API_URL;
    if (override && resolveApiUrl(override) !== saved) {
      throw new Error(
        `This key belongs to ${saved}. Run \`lefine login --api-url ${resolveApiUrl(override)}\` to use another server.`,
      );
    }
    return { token: stored.token, apiUrl: saved, source: "file" };
  }
  return null;
}
