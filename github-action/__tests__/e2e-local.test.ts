/**
 * The action end to end against a running Lefine (the local dev API by default): real CLI, real git, a bare
 * repo as origin, and a fake `gh` that records what it was asked. Skipped unless LEFINE_E2E_TOKEN and
 * LEFINE_E2E_APP are set.
 *
 *   LEFINE_E2E_TOKEN=lfn_...           a key with strings Read and write on the app
 *   LEFINE_E2E_APP=app_...             an app with a published release (pull reads it from the CDN)
 *   LEFINE_E2E_API=http://localhost:8787   API origin; the CDN is <API>/cdn unless LEFINE_E2E_CDN is set
 *
 * Build the CLI first (`cd packages/lefine-cli && bun run build`): the action runs that build, not npm's.
 * It pushes one new key per run into the namespace `ghaction` and leaves it pending (not published).
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs without types: the action runs without a build step
import { run } from "../run.mjs";

const token = process.env.LEFINE_E2E_TOKEN ?? "";
const app = process.env.LEFINE_E2E_APP ?? "";
const api = (process.env.LEFINE_E2E_API || "http://localhost:8787").replace(/\/+$/, "");
const cdn = process.env.LEFINE_E2E_CDN || `${api}/cdn`;
const cliBin = resolve(__dirname, "../../packages/lefine-cli/dist/lefine.js");

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "commit.gpgsign=false", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

/** A repo with origin, locales/en.json holding one new key, and a `gh` on PATH that logs its calls. */
function sandbox() {
  const root = mkdtempSync(join(tmpdir(), "lefine-gha-e2e-"));
  const repo = join(root, "repo");
  const bin = join(root, "bin");
  mkdirSync(join(repo, "locales"), { recursive: true });
  mkdirSync(bin);
  git(root, "init", "-q", "--bare", "remote.git");
  git(root, "init", "-q", "-b", "main", "repo");
  git(repo, "remote", "add", "origin", "../remote.git");
  const key = `e2e_${Date.now()}`;
  writeFileSync(join(repo, "locales/en.json"), JSON.stringify({ ghaction: { [key]: `GitHub Action check ${key}` } }, null, 2));
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  git(repo, "push", "-q", "origin", "main");
  const ghLog = join(root, "gh.log");
  writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$*" >> "${ghLog}"\ncase "$2" in list) echo "";; create) echo https://github.com/acme/web/pull/1;; esac\n`);
  chmodSync(join(bin, "gh"), 0o755);
  return { root, repo, bin, ghLog, key };
}

/** Log lines safe to show in a failure message: never the ::add-mask:: line, which carries the key itself. */
const unmasked = (line: string) => !line.startsWith("::add-mask::");

function action(box: ReturnType<typeof sandbox>, inputs: Record<string, string>) {
  const logs: string[] = [];
  const outputs: Record<string, string> = {};
  const env: Record<string, string> = {
    PATH: `${box.bin}:${process.env.PATH}`,
    HOME: process.env.HOME ?? "",
    LEFINE_HOME: join(box.root, "lefine-home"), // no saved key from this machine
    LEFINE_NO_BROWSER: "1", // the CLI prints approval links, never opens them
    LEFINE_ACTION_CLI_BIN: cliBin,
    GITHUB_REF_NAME: "main",
    GITHUB_EVENT_NAME: "push",
    INPUT_APP: app,
    INPUT_API_URL: api,
    INPUT_CDN_URL: cdn,
    INPUT_GITHUB_TOKEN: "ghs_fake",
    ...inputs,
  };
  const code = run({ env, cwd: box.repo, log: (l: string) => logs.push(l), setOutput: (k: string, v: string) => (outputs[k] = v), summary: () => {} });
  return { code, logs, outputs };
}

describe.skipIf(!token || !app)("the action against a running Lefine", () => {
  it("push sends the new key once, check reports it untranslated, pull opens a PR with the translations", () => {
    expect(existsSync(cliBin), `build the CLI first: ${cliBin}`).toBe(true);
    const box = sandbox();

    const first = action(box, { INPUT_MODE: "push", INPUT_API_KEY: token });
    expect(first.code, first.logs.filter(unmasked).join("\n")).toBe(0);
    expect(first.outputs).toMatchObject({ created: "1", updated: "0", skipped: "false" });

    // The same file again: Lefine has it now.
    const again = action(box, { INPUT_MODE: "push", INPUT_API_KEY: token });
    expect(again.code, again.logs.filter(unmasked).join("\n")).toBe(0);
    expect(again.outputs).toMatchObject({ created: "0", skipped: "true" });

    // The new key has no translation yet: the source serves one text more than the others.
    const check = action(box, { INPUT_MODE: "check", INPUT_API_KEY: token });
    expect(Number(check.outputs.untranslated), check.logs.filter(unmasked).join("\n")).toBeGreaterThan(0);
    expect(check.code).toBe(1);
    // Doctor's unused scan ran through the real CLI: a count (the sandbox's code names only the new key).
    expect(check.outputs["unused-keys"], check.logs.filter(unmasked).join("\n")).toMatch(/^\d+$/);
    expect(check.logs.at(-1)).toMatch(/^::error::Lefine check failed: .*untranslated/);
    expect(action(box, { INPUT_MODE: "check", INPUT_API_KEY: token, INPUT_FAIL_ON: "none" }).code).toBe(0);

    // Pull reads the published texts from the CDN: every language but en is a new file.
    const pull = action(box, { INPUT_MODE: "pull", INPUT_OUTPUT: "locales" });
    expect(pull.code, pull.logs.filter(unmasked).join("\n")).toBe(0);
    expect(Number(pull.outputs["changed-files"])).toBeGreaterThan(0);
    expect(pull.outputs["pr-url"]).toBe("https://github.com/acme/web/pull/1");
    const committed = git(box.root, "--git-dir=remote.git", "show", "--name-only", "--format=", "lefine/strings").split("\n");
    expect(committed.every((f) => f.startsWith("locales/") && f.endsWith(".json"))).toBe(true);
    expect(committed).not.toContain("locales/en.json");
    expect(committed).not.toContain("locales/.pull-state.json");
    const gh = readFileSync(box.ghLog, "utf-8");
    expect(gh).toContain("pr list --head lefine/strings --base main");
    expect(gh).toContain("pr create --base main --head lefine/strings");
  }, 120_000);
});
