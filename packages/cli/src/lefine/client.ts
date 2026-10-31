/**
 * Lefine HTTP client: device login, `/v1/me` and the shared actions
 * (`POST /v1/ops/:name`). Input and output shapes of actions are owned by the
 * server's operations list; this client stays generic on purpose.
 */

import type { LefineWorkspace } from "./credentials.js";
import { safeText } from "./safe-text.js";

export type OpErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFIRM_REQUIRED"
  | "APPROVAL_REQUIRED"
  | "APPROVAL_PENDING"
  | "APPROVAL_REFUSED"
  | "MODULE_OFF"
  | "BAD_INPUT"
  | "CONFLICT"
  | "INTERNAL"
  | "NETWORK";

/** Where a person approves an action in Lefine (the server made it; it is checked before it is opened). */
export interface ApprovalLink {
  id: string;
  url: string;
  expiresAt: string;
}

export class LefineError extends Error {
  constructor(
    readonly code: OpErrorCode,
    message: string,
    readonly approval?: ApprovalLink,
  ) {
    super(message);
    this.name = "LefineError";
  }
}

/** One plain sentence plus what to do. */
/** A server message without its own final period, so ours does not double it. */
const bare = (message: string) => message.replace(/[.\s]+$/, "");

export function explainError(err: LefineError): string {
  switch (err.code) {
    case "UNAUTHORIZED":
      return "You are not signed in, or this key is no longer valid. Run `lefine login`.";
    case "MODULE_OFF":
      return "This workspace does not have Strings. Turn it on in the dashboard under Modules.";
    case "FORBIDDEN": {
      const scope = /\b[a-z]+:(?:read|write|publish)\b/.exec(err.message)?.[0];
      return scope
        ? `This key is missing the \`${scope}\` scope. Run \`lefine login\` and grant it, or create a key with that scope.`
        : `This key is not allowed to do that (${err.message}). Run \`lefine login\` with more access.`;
    }
    case "NOT_FOUND":
      return `Not found: ${bare(err.message)}. Check the app name with \`lefine whoami\`.`;
    case "CONFIRM_REQUIRED":
      return "This action needs your confirmation. Run it again with --yes.";
    case "APPROVAL_REQUIRED":
    case "APPROVAL_PENDING":
      return `A person must approve this in Lefine first${err.approval ? `: ${err.approval.url}` : ""}. Approve it there, then run the command again.`;
    case "APPROVAL_REFUSED":
      return `Nothing was published: ${err.message}`;
    case "BAD_INPUT":
      return `The server rejected the input: ${bare(err.message)}.`;
    case "CONFLICT":
      return `Something changed while you were working: ${bare(err.message)}. Preview again and retry.`;
    case "NETWORK":
      return `Could not reach Lefine: ${bare(err.message)}. Check your connection or --api-url.`;
    default:
      return `Lefine had an internal error: ${bare(err.message)}. Try again; if it repeats, tell support.`;
  }
}

export interface DeviceCode {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export interface DeviceToken {
  access_token: string;
  token_type: "bearer";
  workspace: LefineWorkspace;
  scopes: string[];
}

export interface MeResponse {
  user: { id?: string; name?: string; email?: string } & Record<string, unknown>;
  workspace: LefineWorkspace & { modules?: unknown };
  scopes: string[];
  /** App ids the key is limited to; null means every app in the workspace. */
  apps: string[] | null;
}

async function post(url: string, body: unknown, bearer?: string): Promise<Response> {
  try {
    return await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new LefineError("NETWORK", err instanceof Error ? err.message : String(err));
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const readJson = async (res: Response): Promise<any> => res.json().catch(() => ({}));

export async function requestDeviceCode(apiUrl: string, clientName: string): Promise<DeviceCode> {
  const res = await post(`${apiUrl}/v1/device/code`, { clientName });
  if (!res.ok) throw new LefineError("INTERNAL", `device code request failed (HTTP ${res.status})`);
  return (await readJson(res)) as DeviceCode;
}

export type DeviceTokenResult =
  | { status: "ok"; token: DeviceToken }
  | { status: "pending" | "slow_down" | "denied" | "expired" | "invalid" };

export async function pollDeviceToken(apiUrl: string, deviceCode: string): Promise<DeviceTokenResult> {
  const res = await post(`${apiUrl}/v1/device/token`, { device_code: deviceCode });
  const body = await readJson(res);
  if (res.ok) return { status: "ok", token: body as DeviceToken };
  switch (body.error) {
    case "authorization_pending":
      return { status: "pending" };
    case "slow_down":
      return { status: "slow_down" };
    case "access_denied":
      return { status: "denied" };
    case "expired_token":
      return { status: "expired" };
    default:
      return { status: "invalid" };
  }
}

export async function getMe(apiUrl: string, bearer: string): Promise<MeResponse> {
  let res: Response;
  try {
    res = await fetch(`${apiUrl}/v1/me`, { headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" } });
  } catch (err) {
    throw new LefineError("NETWORK", err instanceof Error ? err.message : String(err));
  }
  if (res.status === 401) throw new LefineError("UNAUTHORIZED", "invalid key");
  if (!res.ok) throw new LefineError("INTERNAL", `/v1/me failed (HTTP ${res.status})`);
  return (await readJson(res)) as MeResponse;
}

export type ApprovalState = "pending" | "approved" | "declined" | "used" | "stale" | "expired";

export interface OpClient {
  /** `approval`: the id a person approved in Lefine, for an action that asks first. There is no confirm: a key cannot approve. */
  callOp<T = unknown>(name: string, input?: unknown, options?: { approval?: string }): Promise<T>;
  /** Where one of this key's approvals stands. */
  approvalStatus(id: string): Promise<ApprovalState>;
  /** The API this client talks to: an approval page is opened only on the same host (approvalUrlToOpen). */
  apiUrl?: string;
}

/**
 * The approval page to open in a browser, or null to only print it: a well-formed link (/approvals/apr_ and 32 hex,
 * the id the server gave) on the same host as the API the CLI talks to. The dashboard and the API share a host
 * (dash.lefine.ai; localhost with two ports in dev), so a link to any other host, or a malformed id, is never opened.
 */
export function approvalUrlToOpen(link: ApprovalLink, apiUrl: string | undefined): string | null {
  if (!apiUrl) return null;
  try {
    const url = new URL(link.url);
    const api = new URL(apiUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.hostname !== api.hostname) return null;
    if (!/^apr_[0-9a-f]{32}$/.test(link.id) || url.pathname !== `/approvals/${link.id}`) return null;
    return url.href;
  } catch {
    return null;
  }
}

const isApproval = (v: unknown): v is ApprovalLink =>
  typeof v === "object" && v !== null && typeof (v as ApprovalLink).id === "string" && typeof (v as ApprovalLink).url === "string";

export function createOpClient(apiUrl: string, bearer: string): OpClient {
  return {
    apiUrl,
    async callOp<T>(name: string, input: unknown = {}, options: { approval?: string } = {}): Promise<T> {
      const res = await post(`${apiUrl}/v1/ops/${name}`, options.approval ? { input, approval: options.approval } : { input }, bearer);
      const body = await readJson(res);
      if (body?.ok === true) return body.data as T;
      const code = (body?.error?.code as OpErrorCode | undefined) ?? (res.status === 401 ? "UNAUTHORIZED" : "INTERNAL");
      throw new LefineError(code, body?.error?.message ?? `HTTP ${res.status}`, isApproval(body?.approval) ? body.approval : undefined);
    },
    async approvalStatus(id: string): Promise<ApprovalState> {
      let res: Response;
      try {
        res = await fetch(`${apiUrl}/v1/approvals/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${bearer}`, Accept: "application/json" } });
      } catch (err) {
        throw new LefineError("NETWORK", err instanceof Error ? err.message : String(err));
      }
      const body = await readJson(res);
      if (res.status === 401) throw new LefineError("UNAUTHORIZED", "invalid key");
      if (!res.ok || typeof body?.data?.status !== "string") throw new LefineError(res.status === 404 ? "NOT_FOUND" : "INTERNAL", body?.error?.message ?? `HTTP ${res.status}`);
      return body.data.status as ApprovalState;
    },
  };
}

export interface ApprovalWaitDeps {
  /** Opens the approval page; replaceable so tests do not open a browser. */
  openBrowser?: (url: string) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  /** How long to wait for the person, ms. Default 15 minutes. */
  waitMs?: number;
  /** Where the waiting lines go (stderr in --json mode, so stdout stays machine readable). */
  say?: (line: string) => void;
  /** Why it asks, first words of the line: default "This goes live" (a publish). */
  why?: string;
}

/**
 * Runs an action; when it asks first, a person approves it in Lefine (#55). The CLI opens the approval page, waits
 * while the person answers, then sends the same call again with the approval id. Nothing here can approve: a
 * decline, an expiry or a change since the person looked stops it, and so does nobody answering in time (CI).
 */
export async function callWithApproval<T>(ops: OpClient, name: string, input: unknown, deps: ApprovalWaitDeps = {}): Promise<T> {
  try {
    return await ops.callOp<T>(name, input);
  } catch (err) {
    if (!(err instanceof LefineError) || err.code !== "APPROVAL_REQUIRED" || !err.approval) throw err;
    const link = err.approval;
    const say = deps.say ?? ((line: string) => console.error(line));
    const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const now = deps.now ?? Date.now;
    say(`  ${deps.why ?? "This goes live"}, so a person approves it in Lefine (an owner or admin):`);
    // The link is the server's text: printed without escape sequences.
    say(`  ${safeText(link.url)}`);
    // Opened only when it is an approval page of the server this CLI talks to; printed in every case.
    const open = approvalUrlToOpen(link, ops.apiUrl);
    if (open) deps.openBrowser?.(open);
    say(`  Waiting for the answer... (Ctrl+C stops waiting; nothing is ${deps.why ? "done" : "published"} without the yes)`);
    const deadline = now() + (deps.waitMs ?? 15 * 60_000);
    for (;;) {
      await sleep(2000);
      const state = await ops.approvalStatus(link.id);
      if (state === "approved") break;
      if (state !== "pending") {
        throw new LefineError("APPROVAL_REFUSED", state === "declined" ? "it was declined in Lefine." : state === "expired" ? "nobody answered in time." : `the approval is ${state}.`, link);
      }
      if (now() >= deadline) throw new LefineError("APPROVAL_PENDING", `nobody approved it in time; it still waits at ${link.url}`, link);
    }
    return ops.callOp<T>(name, input, { approval: link.id });
  }
}
