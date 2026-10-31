/**
 * `lefine ci trust add | list | remove`: which GitHub repositories may sign in to an app from
 * GitHub Actions with no stored secret. Adding one makes keys, so a person approves it in Lefine (owners and admins);
 * the CLI opens the page and waits, as for a publish.
 */

import { execFile } from "node:child_process";
import { bold, cyan, dim, green } from "../utils/colors.js";
import { fail, out } from "./auth-commands.js";
import { callWithApproval } from "./client.js";
import { safeText as s } from "./safe-text.js";
import { type Approvals, pendingHint, waitFor } from "./strings-manage.js";
import { openSession, resolveTarget, type StringsOptions } from "./strings-commands.js";

interface Trust {
  id: string;
  appId: string;
  repository: string;
  repositoryId: string;
  ref: string | null;
  environment: string | null;
  scopes: string[];
  audience: string;
  lastUsedAt: string | null;
}

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** `gh api repos/OWNER/NAME --jq .id`, when gh is installed and signed in (it also reads private repositories). */
const ghRepoId = (repository: string): Promise<string | null> =>
  new Promise((done) => {
    try {
      execFile("gh", ["api", `repos/${repository}`, "--jq", ".id"], { timeout: 15_000 }, (err, stdout) => done(err ? null : stdout.trim() || null));
    } catch {
      done(null);
    }
  });

/**
 * GitHub's numeric id for a repository: --repository-id, else `gh`, else GitHub's API (GITHUB_TOKEN or GH_TOKEN for a
 * private one). The id is what the trust holds on to; a repository deleted and made again under the name has a new one.
 */
export async function repositoryIdOf(
  repository: string,
  given: string | undefined,
  deps: { gh?: (repository: string) => Promise<string | null>; fetch?: FetchLike; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  if (given !== undefined) {
    if (!/^\d{1,20}$/.test(given)) throw new Error("--repository-id is GitHub's numeric id (gh api repos/OWNER/NAME --jq .id).");
    return given;
  }
  const fromGh = await (deps.gh ?? ghRepoId)(repository);
  if (fromGh && /^\d{1,20}$/.test(fromGh)) return fromGh;
  const env = deps.env ?? process.env;
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  try {
    const res = await (deps.fetch ?? ((i, init) => fetch(i, init)))(`https://api.github.com/repos/${repository}`, {
      headers: { accept: "application/vnd.github+json", "user-agent": "lefine-cli", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    });
    const body = (await res.json().catch(() => null)) as { id?: unknown } | null;
    if (res.ok && typeof body?.id === "number") return String(body.id);
  } catch {
    /* told below */
  }
  throw new Error(`Could not find ${s(repository)} on GitHub. For a private repository, sign in with \`gh auth login\` or pass --repository-id (gh api repos/${s(repository)} --jq .id).`);
}

/** The workflow lines a person copies after adding a trust. */
export function workflowSnippet(appId: string): string {
  return [
    "permissions:",
    "  id-token: write   # lets the job ask GitHub for its OIDC token",
    "  contents: read",
    "steps:",
    "  - uses: actions/checkout@v4",
    `  - run: npx lefine strings push --yes --project ${appId}`,
    "    # no LEFINE_TOKEN: the CLI signs in with the run's GitHub token",
  ].join("\n");
}

const trustLine = (t: Trust) =>
  `  ${cyan(s(t.id))}  ${bold(s(t.repository))} ${dim(`(${s(t.repositoryId)})`)}  ${s(t.ref ?? "any ref")}${t.environment ? `, env ${s(t.environment)}` : ""}  ${dim(`${t.scopes.map(s).join(" ")}${t.lastUsedAt ? `, last used ${s(t.lastUsedAt)}` : ", never used"}`)}`;

// ── lefine ci trust add <owner/name> ──────────────────────────────────

export interface TrustAddOptions extends StringsOptions {
  repositoryId?: string;
  ref?: string;
  environment?: string;
  level?: string;
  approval?: string;
}

export async function ciTrustAddCommand(repository: string, options: TrustAddOptions, deps: Approvals & Parameters<typeof repositoryIdOf>[2] = {}): Promise<void> {
  try {
    if (!REPO.test(repository)) throw new Error(`"${s(repository)}" is not owner/name, for example acme/web.`);
    const level = options.level ?? "write";
    if (!["read", "write", "publish"].includes(level)) throw new Error("--level takes read, write or publish.");
    const ref = options.ref === undefined ? undefined : options.ref.startsWith("refs/") ? options.ref : `refs/heads/${options.ref}`;
    const { ops, appId } = await openSession(options, await resolveTarget(options));
    const repositoryId = await repositoryIdOf(repository, options.repositoryId, deps);
    const input = { appId, repository, repositoryId, level, ...(ref ? { ref } : {}), ...(options.environment ? { environment: options.environment } : {}) };
    const trust = await (options.approval
      ? ops.callOp<Trust>("strings.ci.trusts.add", input, { approval: options.approval })
      : callWithApproval<Trust>(ops, "strings.ci.trusts.add", input, waitFor("A trusted repository can sign in to this app", options.json, deps))
    ).catch((err: unknown) => pendingHint(err, `lefine ci trust add ${repository} --repository-id ${repositoryId}${ref ? ` --ref ${ref}` : ""}${options.environment ? ` --environment ${options.environment}` : ""} --level ${level}`));
    out(options.json, trust, () => {
      console.log(`\n  ${green("✓")} ${s(trust.repository)} can sign in to ${s(appId)} from GitHub Actions${trust.ref ? ` on ${s(trust.ref)}` : ""}. Keys last 15 minutes.`);
      console.log(dim("\n  In the workflow:\n"));
      for (const line of workflowSnippet(appId).split("\n")) console.log(`    ${line}`);
      console.log();
    });
  } catch (err) {
    fail(err, options.json);
  }
}

// ── lefine ci trust list ──────────────────────────────────────────────

export async function ciTrustListCommand(options: StringsOptions): Promise<void> {
  try {
    const { ops, appId } = await openSession(options, await resolveTarget(options));
    const { items } = await ops.callOp<{ items: Trust[] }>("strings.ci.trusts.list", { appId });
    out(options.json, { items }, () => {
      console.log();
      if (items.length === 0) console.log(`  No repository can sign in to ${s(appId)} from GitHub Actions. Add one: lefine ci trust add owner/name`);
      for (const t of items) console.log(trustLine(t));
      if (items[0]) console.log(dim(`\n  Runs ask GitHub for the audience ${s(items[0].audience)}.`));
      console.log();
    });
  } catch (err) {
    fail(err, options.json);
  }
}

// ── lefine ci trust remove <id> ───────────────────────────────────────

export async function ciTrustRemoveCommand(id: string, options: StringsOptions): Promise<void> {
  try {
    if (!/^ght_[A-Za-z0-9]+$/.test(id)) throw new Error(`"${s(id)}" is not a trust id (ght_...). See \`lefine ci trust list\`.`);
    const { ops, appId } = await openSession(options, await resolveTarget(options));
    await ops.callOp("strings.ci.trusts.remove", { appId, trustId: id });
    out(options.json, { revoked: true, id }, () => console.log(`  ${green("✓")} Removed ${s(id)}. Keys it already gave run out within 15 minutes.`));
  } catch (err) {
    fail(err, options.json);
  }
}
