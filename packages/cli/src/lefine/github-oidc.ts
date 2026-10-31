/**
 * Sign in from GitHub Actions with no stored secret. In a job with `permissions: id-token: write`
 * and no LEFINE_TOKEN, the CLI asks GitHub for an OIDC token with the audience `lefine:<app id>` and trades it at
 * POST /v1/oidc/github for a key that lasts 15 minutes, held to that app. The app must trust the repository first:
 * `lefine ci trust add owner/name`.
 *
 * Nothing here is printed or saved: the GitHub token goes only to GitHub's own URL from the runner's environment and to
 * the Lefine API, the traded key lives in this process only.
 */

import { LefineError } from "./client.js";
import { type ResolvedLefineAuth, resolveApiUrl } from "./credentials.js";
import { safeText } from "./safe-text.js";

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** The runner gives these to a job with `permissions: id-token: write`. */
export const inGithubActionsWithOidc = (env: NodeJS.ProcessEnv = process.env): boolean =>
  Boolean(env.GITHUB_ACTIONS === "true" && env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN);

export const oidcAudience = (appId: string) => `lefine:${appId}`;

/** One key per app per process: a CI job runs several commands on the same app in one CLI call at most. */
const traded = new Map<string, { auth: ResolvedLefineAuth; until: number }>();

export async function githubActionsAuth(
  appId: string,
  options: { apiUrl?: string },
  deps: { fetch?: FetchLike; env?: NodeJS.ProcessEnv; now?: () => number } = {},
): Promise<ResolvedLefineAuth | null> {
  const env = deps.env ?? process.env;
  if (!inGithubActionsWithOidc(env)) return null;
  const fetcher = deps.fetch ?? ((input, init) => fetch(input, init));
  const now = (deps.now ?? Date.now)();
  const apiUrl = resolveApiUrl(options.apiUrl);
  const cached = traded.get(`${apiUrl}|${appId}`);
  if (cached && cached.until > now) return cached.auth;

  // 1. GitHub: an OIDC token for our audience.
  const url = new URL(env.ACTIONS_ID_TOKEN_REQUEST_URL!);
  url.searchParams.set("audience", oidcAudience(appId));
  let idToken: string;
  try {
    const res = await fetcher(url.toString(), { headers: { Authorization: `bearer ${env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}`, Accept: "application/json" } });
    const body = (await res.json().catch(() => null)) as { value?: unknown } | null;
    if (!res.ok || typeof body?.value !== "string") throw new Error(`HTTP ${res.status}`);
    idToken = body.value;
  } catch (err) {
    throw new Error(`GitHub did not give this job an OIDC token (${safeText(err instanceof Error ? err.message : String(err))}). The job needs \`permissions: id-token: write\`.`);
  }

  // 2. Lefine: the GitHub token for a key of minutes.
  let res: Response;
  try {
    res = await fetcher(`${apiUrl}/v1/oidc/github`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ appId, token: idToken }),
    });
  } catch (err) {
    throw new LefineError("NETWORK", err instanceof Error ? err.message : String(err));
  }
  const body = (await res.json().catch(() => null)) as { access_token?: unknown; expires_in?: unknown; error_description?: unknown } | null;
  if (!res.ok || typeof body?.access_token !== "string") {
    const why = typeof body?.error_description === "string" ? safeText(body.error_description) : `HTTP ${res.status}`;
    if (res.status === 503) throw new LefineError("NETWORK", why);
    throw new Error(
      `GitHub Actions sign-in was refused: ${why} Set it up once with \`lefine ci trust add ${safeText(env.GITHUB_REPOSITORY ?? "owner/name")} --project ${safeText(appId)}\`, or set LEFINE_TOKEN.`,
    );
  }
  const auth: ResolvedLefineAuth = { token: body.access_token, apiUrl, source: "oidc" };
  // A minute short of the key's life, so a long job trades again before the key runs out.
  const seconds = Number(body.expires_in);
  traded.set(`${apiUrl}|${appId}`, { auth, until: now + Math.max(0, (Number.isFinite(seconds) ? seconds : 900) - 60) * 1000 });
  return auth;
}

/** Tests only. */
export const forgetTradedKeys = () => traded.clear();
