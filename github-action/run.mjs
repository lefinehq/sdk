/**
 * The Lefine Strings GitHub Action. A thin wrapper: every change to Lefine is made by the pinned
 * `@lefine/cli` (`strings push --yes --json`, `strings pull --force`); this file only builds its
 * arguments, and for `pull` commits the files it wrote and opens or updates one pull request.
 *
 * Node built-ins only, so the composite action runs without an install or a bundle step.
 * Inputs arrive as INPUT_* env vars set in action.yml, never interpolated into a script.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

const BOT_NAME = "github-actions[bot]";
const BOT_EMAIL = "41898282+github-actions[bot]@users.noreply.github.com";
const PULL_STATE_FILE = ".pull-state.json";
/** What runs when cli-version is not set: the newest @lefine/cli on npm. Raised only after a release publishes it. */
export const DEFAULT_CLI_VERSION = "0.1.0";
/** The first @lefine/cli that signs in with the run's GitHub OIDC token. */
export const OIDC_CLI_VERSION = "0.9.0";

/** Whether an exact version (1.2.3) is older than another. A range or a tag (latest, ^0.5.0) counts as new enough. */
export function olderThan(version, than) {
  const a = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!a) return false;
  const b = than.split(".").map(Number);
  for (let i = 0; i < 3; i++) if (Number(a[i + 1]) !== b[i]) return Number(a[i + 1]) < b[i];
  return false;
}

/** @param {Record<string, string | undefined>} env */
export function readInputs(env) {
  const get = (name, fallback = "") => (env[`INPUT_${name}`] ?? "").trim() || fallback;
  return {
    mode: get("MODE", "push").toLowerCase(),
    apiKey: get("API_KEY"),
    app: get("APP"),
    dir: get("WORKING_DIRECTORY", "."),
    sourceFile: get("SOURCE_FILE"),
    sourceLocale: get("SOURCE_LOCALE"),
    output: get("OUTPUT"),
    includeSource: get("INCLUDE_SOURCE", "false").toLowerCase() === "true",
    cliVersion: get("CLI_VERSION", DEFAULT_CLI_VERSION),
    apiUrl: get("API_URL"),
    cdnUrl: get("CDN_URL"),
    githubToken: get("GITHUB_TOKEN"),
    branch: get("BRANCH", "lefine/strings"),
    base: get("BASE"),
    prTitle: get("PR_TITLE", "Lefine: latest translations"),
    /** check: one comment on the pull request with what the check found, updated on each run. */
    comment: get("COMMENT", "true").toLowerCase() !== "false",
    failOn: get("FAIL_ON", CHECKS.join(","))
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    /** Tests only: run a local CLI build (`node <path> strings ...`) instead of npx. Not an action input. */
    cliBin: (env.LEFINE_ACTION_CLI_BIN ?? "").trim(),
  };
}

/** What check mode fails on by default. */
export const CHECKS = ["missing-keys", "untranslated", "text-warnings"];
/** Reported as a warning; fails only when fail-on names it. */
export const WARNINGS = ["unused-keys"];

/** Throws with the fix when an input cannot work. */
export function validate(inputs) {
  if (!["push", "pull", "check"].includes(inputs.mode)) {
    throw new Error(`mode must be push, pull or check, not "${inputs.mode}".`);
  }
  const unknown = inputs.failOn.filter((c) => c !== "none" && !CHECKS.includes(c) && !WARNINGS.includes(c));
  if (unknown.length) throw new Error(`fail-on: unknown ${unknown.join(", ")}. Use ${[...CHECKS, ...WARNINGS].join(", ")} or none.`);
  // An npm version or dist-tag: 0.1.0, ^0.1.0, latest. Nothing that npx could read as a path or a URL.
  if (!/^[\w.^~<>=-]+$/.test(inputs.cliVersion)) {
    throw new Error(`cli-version "${inputs.cliVersion}" is not a version.`);
  }
  if (inputs.mode === "pull" && !/^[\w./-]+$/.test(inputs.branch)) {
    throw new Error(`branch "${inputs.branch}" is not a branch name.`);
  }
}

/**
 * True when GitHub gives this run no secrets: a pull request from a fork, or one Dependabot opened.
 * Then a missing key is expected and the action skips instead of failing the check.
 */
export function runsWithoutSecrets(env, readEvent = (path) => JSON.parse(readFileSync(path, "utf-8"))) {
  if (env.GITHUB_ACTOR === "dependabot[bot]") return true;
  if (env.GITHUB_EVENT_NAME !== "pull_request" && env.GITHUB_EVENT_NAME !== "pull_request_target") return false;
  try {
    const pr = readEvent(env.GITHUB_EVENT_PATH ?? "").pull_request;
    const head = pr?.head?.repo?.full_name;
    return Boolean(head) && head !== pr?.base?.repo?.full_name;
  } catch {
    return false;
  }
}

/**
 * One CLI call: `lefine strings <command>` (push, pull, missing, status), plus the env the CLI reads.
 * The key never goes in argv.
 */
export function cliCommand(inputs, baseEnv = {}, command = inputs.mode) {
  const strings = ["strings", command];
  if (inputs.app) strings.push("-p", inputs.app);
  strings.push("-d", inputs.dir);
  if (command === "push") {
    strings.push("--yes", "--json");
    if (inputs.sourceFile) strings.push("--file", inputs.sourceFile);
    if (inputs.sourceLocale) strings.push("--locale", inputs.sourceLocale);
  } else if (command === "pull") {
    // A fresh runner has no pull state worth trusting; a committed .pull-state.json could skip a locale.
    strings.push("--force");
    if (inputs.output) strings.push("-o", inputs.output);
  } else {
    strings.push("--json");
  }
  const run = inputs.cliBin
    ? { command: process.execPath, args: [inputs.cliBin, ...strings] }
    : { command: "npx", args: ["--yes", `@lefine/cli@${inputs.cliVersion}`, ...strings] };

  // The CLI gets the runner's env without this action's inputs (the key and the GitHub token among them).
  const env = Object.fromEntries(Object.entries(baseEnv).filter(([k]) => !k.startsWith("INPUT_")));
  if (inputs.apiKey) env.LEFINE_TOKEN = inputs.apiKey;
  if (inputs.apiUrl) env.LEFINE_API_URL = inputs.apiUrl;
  if (inputs.cdnUrl) env.LEFINE_CDN_URL = inputs.cdnUrl;
  return { ...run, env };
}

/** The one JSON object a `--json` command prints, past any npm warning before it. */
export function parseJson(stdout) {
  const text = stdout.trim();
  const start = text.indexOf("{");
  if (start < 0) throw new Error(`The CLI printed no JSON:\n${text}`);
  return JSON.parse(text.slice(start));
}

/** `push --json` prints one JSON object: { applied, tally: { created, updated, skipped, dropped }, runs? }. */
export function parsePushResult(stdout) {
  const result = parseJson(stdout);
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return {
    applied: result.applied === true,
    created: n(result.tally?.created),
    updated: n(result.tally?.updated),
    skipped: n(result.tally?.skipped),
    dropped: n(result.tally?.dropped),
  };
}

/**
 * The files a pull may commit, from `git status --porcelain -z`: changed or new .json files, minus the
 * CLI's pull state and, unless include-source is on, the source language's file.
 */
export function filesToCommit(porcelainZ, inputs) {
  const source = `${(inputs.sourceLocale || "en").toLowerCase()}.json`;
  return porcelainZ
    .split("\0")
    .filter((entry) => entry.length > 3)
    .map((entry) => entry.slice(3))
    .filter((path) => path.endsWith(".json"))
    .filter((path) => basename(path) !== PULL_STATE_FILE)
    .filter((path) => inputs.includeSource || basename(path).toLowerCase() !== source);
}

function defaultExec(command, args, options = {}) {
  const res = spawnSync(command, args, { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024, ...options });
  if (res.error) throw res.error;
  return { status: res.status ?? 1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

/**
 * Runs the action. Everything outside is injected so tests can drive it without git, npx or GitHub.
 * Returns the process exit code.
 */
export function run({
  env = process.env,
  exec = defaultExec,
  readEvent,
  log = (line) => console.log(line),
  setOutput = (name, value) => env.GITHUB_OUTPUT && appendFileSync(env.GITHUB_OUTPUT, `${name}=${value}\n`),
  summary = (md) => env.GITHUB_STEP_SUMMARY && appendFileSync(env.GITHUB_STEP_SUMMARY, `${md}\n`),
  cwd,
} = {}) {
  try {
    const inputs = readInputs(env);
    validate(inputs);
    if (inputs.apiKey) log(`::add-mask::${inputs.apiKey}`);
    if (inputs.githubToken) log(`::add-mask::${inputs.githubToken}`);
    const inDir = cwd ? (command, args, options = {}) => exec(command, args, { cwd, ...options }) : exec;
    const ctx = { env, exec: inDir, readEvent, log, setOutput, summary };
    return inputs.mode === "push" ? push(inputs, ctx) : inputs.mode === "check" ? check(inputs, ctx) : pull(inputs, ctx);
  } catch (err) {
    log(`::error::${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

/**
 * How this run signs in to Lefine, in this order:
 *   "key"  an api-key was given (LEFINE_API_KEY): it is used, as before.
 *   "skip" a fork's or Dependabot's pull request with no key: skipped, green. Even when GitHub would give an OIDC
 *          token (pull_request_target runs as the base repository), a fork's code never signs in.
 *   "oidc" the default: the job has `permissions: id-token: write`, and the CLI trades the run's GitHub token for a
 *          key of 15 minutes for an app that trusts this repository (npx lefine ci trust add). No secret is stored.
 * Throws with both fixes when none applies.
 */
export function signIn(inputs, { env, readEvent, log, setOutput }, access, readFile = (path) => readFileSync(path, "utf-8")) {
  if (inputs.apiKey) return "key";
  if (runsWithoutSecrets(env, readEvent)) {
    log(`::notice::No Lefine sign-in for a fork's or Dependabot's pull request. ${inputs.mode} skipped.`);
    setOutput("skipped", "true");
    return "skip";
  }
  if (env.ACTIONS_ID_TOKEN_REQUEST_URL && env.ACTIONS_ID_TOKEN_REQUEST_TOKEN) {
    // Fail closed: a pull request signs in only when it is known to come from this repository. pull_request_target
    // never does (it runs the base repository's identity for anyone's pull request); a key is the explicit way there.
    const pr = pullRequestOrigin(env, readEvent);
    if (pr !== "none" && pr !== "same-repo") {
      log(`::notice::No sign-in with GitHub OIDC for ${pr === "target" ? "pull_request_target" : "a pull request this action cannot tell is from this repository"}. ${inputs.mode} skipped; pass api-key to run it there.`);
      setOutput("skipped", "true");
      return "skip";
    }
    // The token is asked for one app (audience lefine:<app id>), so the CLI must know the id, not a name.
    if (inputs.app && !APP_ID.test(inputs.app)) {
      throw new Error(`Signing in with no secret needs the app's id (app_...), not "${inputs.app}". Set app: to the id (lefine apps), or pass api-key.`);
    }
    if (!inputs.app && !appIdInConfig(inputs.dir, readFile)) {
      throw new Error(`Signing in with no secret needs the app's id: set app: app_..., or run npx lefine init so lefine.ts names it (${inputs.dir}).`);
    }
    if (olderThan(inputs.cliVersion, OIDC_CLI_VERSION)) {
      throw new Error(`Signing in with no secret needs @lefine/cli ${OIDC_CLI_VERSION} or newer; this step runs ${inputs.cliVersion}. Set cli-version: ${OIDC_CLI_VERSION} (once it is on npm), or pass api-key.`);
    }
    log("::notice::Signing in to Lefine with this run's GitHub OIDC token (no stored secret).");
    return "oidc";
  }
  throw new Error(
    `No way to sign in to Lefine. Either give the job \`permissions: id-token: write\` and trust this repository once (npx lefine ci trust add <owner/name> --project <app id>), with no secret; or create a key in Lefine (Settings, API keys, ${access}), save it as the repository secret LEFINE_API_KEY, and pass api-key: \${{ secrets.LEFINE_API_KEY }}.`,
  );
}

const APP_ID = /^app_[a-z0-9]{3,64}$/;

/**
 * Where the run's pull request comes from, for the OIDC decision: "none" (not a pull request event), "target"
 * (pull_request_target), "same-repo", or "unknown" (the event cannot be read, or its head repository is gone or
 * another one). Only "none" and "same-repo" may sign in.
 */
export function pullRequestOrigin(env, readEvent = (path) => JSON.parse(readFileSync(path, "utf-8"))) {
  if (env.GITHUB_EVENT_NAME === "pull_request_target") return "target";
  if (env.GITHUB_EVENT_NAME !== "pull_request") return "none";
  try {
    const pr = readEvent(env.GITHUB_EVENT_PATH ?? "").pull_request;
    const head = pr?.head?.repo?.full_name;
    return head && head === pr?.base?.repo?.full_name ? "same-repo" : "unknown";
  } catch {
    return "unknown";
  }
}

/** Whether lefine.ts (or src/lefine.ts) in the working directory names the app id, as npx lefine init writes it. */
function appIdInConfig(dir, readFile) {
  for (const file of ["lefine.ts", "src/lefine.ts"]) {
    try {
      if (/project:\s*["']app_[a-z0-9]{3,64}["']/.test(readFile(`${dir.replace(/\/+$/, "")}/${file}`))) return true;
    } catch {
      /* not there */
    }
  }
  return false;
}

/**
 * Text from the CLI or the server (key names, texts) must not become a workflow command: a key named
 * "x\n::add-mask::..." or "::set-output" would otherwise run. Echoed output goes between ::stop-commands::
 * markers with a fresh token; values inside a command we write are escaped the way @actions/core does.
 */
export function escapeData(value) {
  return String(value).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
}
const oneLine = (value) => String(value).replace(/[\r\n]+/g, " ");
function logUntrusted(log, text) {
  if (!text.trim()) return;
  const token = randomBytes(16).toString("hex");
  log(`::stop-commands::${token}`);
  log(text.trimEnd());
  log(`::${token}::`);
}

const shown = (args) => `lefine ${args.slice(args.indexOf("strings")).join(" ")}`;

function push(inputs, { env, exec, readEvent, log, setOutput, summary }) {
  if (signIn(inputs, { env, readEvent, log, setOutput }, "Read and write") === "skip") return 0;

  const { command, args, env: cliEnv } = cliCommand(inputs, env);
  log(`Running ${shown(args)}`);
  const res = exec(command, args, { env: cliEnv });
  logUntrusted(log, res.stderr);
  if (res.status !== 0) {
    logUntrusted(log, res.stdout);
    throw new Error(`lefine strings push failed (exit ${res.status}).`);
  }

  const result = parsePushResult(res.stdout);
  const nothing = result.created + result.updated === 0;
  setOutput("created", String(result.created));
  setOutput("updated", String(result.updated));
  setOutput("skipped", String(nothing));
  const line = nothing
    ? "Nothing to push. Lefine already has these texts."
    : `Pushed ${result.created} new and ${result.updated} changed texts to Lefine.`;
  log(line);
  summary(`### Lefine strings push\n\n${line}${result.dropped ? ` ${result.dropped} were dropped; run \`lefine strings push\` locally to see why.` : ""}`);
  return 0;
}

/**
 * Per locale, how many texts it serves fewer than the fullest locale (the source) in the next release:
 * `willServe` from the release preview, which leaves out empty texts and unreviewed AI drafts.
 */
export function untranslatedByLocale(preview) {
  const locales = Array.isArray(preview?.locales) ? preview.locales : [];
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  const most = Math.max(0, ...locales.map((l) => n(l.willServe)));
  return locales.map((l) => ({ locale: String(l.locale), untranslated: most - n(l.willServe) })).filter((l) => l.untranslated > 0);
}

/**
 * Three answers from the CLI, no checks of our own: `strings missing` (names in the code with no key in
 * Lefine) and `strings status` (the release preview: what each locale will serve, and the texts that lost a
 * variable or a plural branch against their source, as the Releases tab warns).
 */
function check(inputs, ctx) {
  const { env, exec, log, setOutput, summary } = ctx;
  if (signIn(inputs, ctx, "Read") === "skip") return 0;

  const call = (command) => {
    const { command: bin, args, env: cliEnv } = cliCommand(inputs, env, command);
    log(`Running ${shown(args)}`);
    const res = exec(bin, args, { env: cliEnv });
    logUntrusted(log, res.stderr);
    let json = null;
    try {
      json = parseJson(res.stdout);
    } catch {
      /* reported below */
    }
    // `missing` exits 1 when it finds names; that is an answer (ok: true), not a failure.
    if (!json || json.ok === false) {
      logUntrusted(log, res.stdout);
      const old = /unknown command/i.test(res.stderr) ? ` @lefine/cli ${inputs.cliVersion} has no \`strings ${command}\`; set cli-version to a newer one.` : "";
      throw new Error(`lefine strings ${command} failed (exit ${res.status}).${old}`);
    }
    return json;
  };

  const missing = call("missing");
  const unused = call("unused");
  const status = call("status");
  const preview = status.preview ?? {};
  const untranslated = untranslatedByLocale(preview);
  const warnings = Array.isArray(preview.textWarnings) ? preview.textWarnings : [];
  const counts = {
    "missing-keys": Number(missing.missingTotal) || 0,
    untranslated: untranslated.reduce((sum, l) => sum + l.untranslated, 0),
    "text-warnings": Number(preview.textWarningCount) || warnings.length,
    "unused-keys": Number(unused.unusedTotal) || 0,
  };
  const unusedNames = (Array.isArray(unused.unused) ? unused.unused : []).map((k) => `${k.namespace}.${k.key}`);
  for (const [name, value] of Object.entries(counts)) setOutput(name, String(value));

  const lines = [];
  if (counts["missing-keys"]) {
    lines.push(`- **${counts["missing-keys"]} names in the code have no key in Lefine** (users see the raw name): ${(missing.missing ?? []).slice(0, 20).map(oneLine).join(", ")}`);
  }
  if (counts["unused-keys"]) {
    lines.push(`- **${counts["unused-keys"]} keys in Lefine are not used in the code** (a warning): ${unusedNames.slice(0, 20).map(oneLine).join(", ")}`);
    log(`::warning title=Lefine unused keys::${escapeData(`${counts["unused-keys"]} keys in Lefine are not used in the code: ${unusedNames.slice(0, 20).join(", ")}${unusedNames.length > 20 ? ", ..." : ""}`)}`);
  }
  if (counts.untranslated) {
    lines.push(`- **Untranslated texts:** ${untranslated.map((l) => `${oneLine(l.locale)} ${l.untranslated}`).join(", ")}`);
  }
  if (counts["text-warnings"]) {
    lines.push(`- **${counts["text-warnings"]} texts do not match their source** (waiting to be published):`);
    for (const w of warnings.slice(0, 20)) {
      const what = [...(w.missing ?? []).map((m) => `lost ${m}`), ...(w.extra ?? []).map((m) => `added ${m}`)].join(", ") || String(w.reason);
      const where = `${w.locale} ${w.namespace}.${w.key}`;
      lines.push(`  - ${oneLine(where)}: ${oneLine(what)}`);
      log(`::warning title=Lefine::${escapeData(`${where}: ${what}`)}`);
    }
  }

  const failing = Object.keys(counts).filter((c) => counts[c] > 0 && inputs.failOn.includes(c));
  setOutput("skipped", "false");
  const head = lines.length === 0 ? "Every check passed: no missing keys, no untranslated texts, no texts that lost a variable." : lines.join("\n");
  logUntrusted(log, head);
  summary(`### Lefine strings check\n\n${head}`);
  if (inputs.comment) {
    commentOnPullRequest(inputs, ctx, checkComment({ counts, failing, missing: missing.missing ?? [], unused: unusedNames, untranslated, warnings }));
  }
  if (failing.length) {
    log(`::error::Lefine check failed: ${failing.map((c) => `${c} ${counts[c]}`).join(", ")}.`);
    return 1;
  }
  return 0;
}

export const COMMENT_MARKER = "<!-- lefine-strings-check -->";

/** A name from the server as Markdown code: no backticks, no new lines, so it cannot close the span or ping anyone. */
const code = (value) => `\`${oneLine(value).replace(/`/g, "'").slice(0, 200)}\``;

/** The pull request comment of check mode: what fails, what warns, in lists of at most 50. */
export function checkComment({ counts, failing, missing, unused, untranslated, warnings }) {
  const list = (names) => [...names.slice(0, 50).map((n) => `- ${code(n)}`), ...(names.length > 50 ? [`- ...and ${names.length - 50} more`] : [])];
  const out = [COMMENT_MARKER, "### Lefine strings check", ""];
  const mark = (name) => (failing.includes(name) ? "fails this check" : "a warning");
  if (counts["missing-keys"]) out.push(`**${counts["missing-keys"]} names in the code have no key in Lefine** (${mark("missing-keys")}; users would see the raw name):`, ...list(missing), "");
  if (counts["unused-keys"]) out.push(`**${counts["unused-keys"]} keys in Lefine are not used in the code** (${mark("unused-keys")}; \`lefine strings unused --delete\` removes them after a person approves):`, ...list(unused), "");
  if (counts.untranslated) out.push(`**Untranslated texts** (${mark("untranslated")}): ${untranslated.map((l) => `${code(l.locale)} ${l.untranslated}`).join(", ")}`, "");
  if (counts["text-warnings"]) out.push(`**${counts["text-warnings"]} texts do not match their source** (${mark("text-warnings")}):`, ...list(warnings.map((w) => `${w.locale} ${w.namespace}.${w.key}`)), "");
  if (out.length === 3) out.push("Every check passed: no missing or unused keys, no untranslated texts, no texts that lost a variable.");
  return out.join("\n").trimEnd();
}

/**
 * One comment per pull request, found by its marker and updated on each run (so a push does not add another).
 * Needs `permissions: pull-requests: write`; without it the check still passes or fails, with a warning.
 */
function commentOnPullRequest(inputs, { env, exec, readEvent, log }, body) {
  if (env.GITHUB_EVENT_NAME !== "pull_request" || !inputs.githubToken || !env.GITHUB_REPOSITORY) return;
  let number;
  try {
    number = (readEvent ?? ((path) => JSON.parse(readFileSync(path, "utf-8"))))(env.GITHUB_EVENT_PATH ?? "").pull_request?.number;
  } catch {
    return;
  }
  if (!Number.isInteger(number) || !/^[\w.-]+\/[\w.-]+$/.test(env.GITHUB_REPOSITORY)) return;
  const ghEnv = { ...env, GH_TOKEN: inputs.githubToken };
  for (const key of Object.keys(ghEnv)) if (key.startsWith("INPUT_")) delete ghEnv[key];
  const gh = (...args) => exec("gh", args, { env: ghEnv });
  const issue = `repos/${env.GITHUB_REPOSITORY}/issues`;
  // Only our own comment is updated: anyone can post a comment that starts with the marker. The default token is
  // github-actions[bot] (it cannot read /user); a personal or app token says who it is.
  const me = gh("api", "user", "--jq", ".login");
  const login = me.status === 0 && /^[A-Za-z0-9-]+(\[bot\])?$/.test(me.stdout.trim()) ? me.stdout.trim() : "github-actions[bot]";
  const found = gh("api", `${issue}/${number}/comments`, "--paginate", "--jq", `.[] | select(.user.login == "${login}" and (.body | startswith("${COMMENT_MARKER}"))) | .id`);
  const id = found.status === 0 ? found.stdout.split("\n").map((l) => l.trim()).find((l) => /^\d+$/.test(l)) : undefined;
  const res = id ? gh("api", "-X", "PATCH", `${issue}/comments/${id}`, "-f", `body=${body}`) : gh("api", "-X", "POST", `${issue}/${number}/comments`, "-f", `body=${body}`);
  if (found.status !== 0 || res.status !== 0) log("::warning title=Lefine::Could not comment on the pull request. Give the job permissions: pull-requests: write, or set comment: false.");
}

function pull(inputs, { env, exec, log, setOutput, summary }) {
  const base = inputs.base || env.GITHUB_BASE_REF || env.GITHUB_REF_NAME;
  if (!base) throw new Error("No base branch. Set base: main.");
  if (base === inputs.branch) throw new Error(`base and branch are both "${base}". The action force-pushes branch, so it must be its own.`);

  const { command, args, env: cliEnv } = cliCommand(inputs, env);
  log(`Running ${shown(args)}`);
  const res = exec(command, args, { env: cliEnv });
  logUntrusted(log, res.stdout);
  logUntrusted(log, res.stderr);
  if (res.status !== 0) throw new Error(`lefine strings pull failed (exit ${res.status}).`);

  const git = (...gitArgs) => {
    const r = exec("git", gitArgs, {});
    if (r.status !== 0) throw new Error(`git ${gitArgs[0]} failed: ${r.stderr.trim() || r.stdout.trim()}`);
    return r.stdout;
  };
  const scope = inputs.output ? joinPath(inputs.dir, inputs.output) : inputs.dir;
  const files = filesToCommit(git("status", "--porcelain", "-z", "--untracked-files=all", "--", scope), inputs);
  setOutput("changed-files", String(files.length));
  if (files.length === 0) {
    log("No translation changed. No pull request.");
    setOutput("skipped", "true");
    summary("### Lefine strings pull\n\nNo translation changed.");
    return 0;
  }

  git("checkout", "-B", inputs.branch);
  git("add", "--", ...files);
  git("-c", `user.name=${BOT_NAME}`, "-c", `user.email=${BOT_EMAIL}`, "-c", "commit.gpgsign=false", "commit", "--no-verify", "-m", inputs.prTitle);
  git("push", "--force", "origin", `HEAD:refs/heads/${inputs.branch}`);

  const ghEnv = { ...cliEnv, GH_TOKEN: inputs.githubToken };
  const gh = (...ghArgs) => {
    const r = exec("gh", ghArgs, { env: ghEnv });
    if (r.status !== 0) throw new Error(`gh ${ghArgs.slice(0, 2).join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}`);
    return r.stdout.trim();
  };
  let url = gh("pr", "list", "--head", inputs.branch, "--base", base, "--state", "open", "--json", "url", "--jq", ".[0].url // empty");
  const opened = !url;
  if (opened) {
    const body = [
      `Published translations from Lefine, pulled by \`lefine strings pull\` (${files.length} file${files.length === 1 ? "" : "s"}).`,
      "",
      `The action owns the \`${inputs.branch}\` branch and force-pushes it on every run. Edit texts in Lefine, not here.`,
    ].join("\n");
    url = gh("pr", "create", "--base", base, "--head", inputs.branch, "--title", inputs.prTitle, "--body", body);
  }
  setOutput("pr-url", url);
  setOutput("skipped", "false");
  const line = `${opened ? "Opened" : "Updated"} ${url} with ${files.length} changed file${files.length === 1 ? "" : "s"}.`;
  log(line);
  summary(`### Lefine strings pull\n\n${line}`);
  return 0;
}

function joinPath(dir, path) {
  if (path.startsWith("/") || dir === "." || dir === "") return path;
  return `${dir.replace(/\/+$/, "")}/${path}`;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = run();
}
