import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs without types: the action runs without a build step
import { checkComment, cliCommand, COMMENT_MARKER, DEFAULT_CLI_VERSION, filesToCommit, olderThan, parsePushResult, readInputs, run, runsWithoutSecrets, untranslatedByLocale } from "../run.mjs";

type Call = { command: string; args: string[]; env?: Record<string, string> };
type Reply = { status?: number; stdout?: string; stderr?: string };

/** Drives run() with a fake exec: replies are matched by the first words of the call. */
function harness(env: Record<string, string>, replies: Record<string, Reply> = {}) {
  const calls: Call[] = [];
  const logs: string[] = [];
  const outputs: Record<string, string> = {};
  const exec = (command: string, args: string[], options: { env?: Record<string, string> } = {}) => {
    calls.push({ command, args, env: options.env });
    const key = Object.keys(replies).find((k) => `${command} ${args.join(" ")}`.startsWith(k));
    const reply = key ? replies[key] : {};
    return { status: reply.status ?? 0, stdout: reply.stdout ?? "", stderr: reply.stderr ?? "" };
  };
  const code = run({
    env,
    exec,
    readEvent: () => ({}),
    log: (line: string) => logs.push(line),
    setOutput: (name: string, value: string) => (outputs[name] = value),
    summary: () => {},
  });
  return { code, calls, logs, outputs };
}

const PUSH_JSON = JSON.stringify({ applied: true, tally: { created: 3, updated: 1, skipped: 10, dropped: 0 }, runs: [] });

describe("push", () => {
  it("runs the pinned CLI with --yes --json and the key only in LEFINE_TOKEN", () => {
    const { code, calls, outputs, logs } = harness(
      { INPUT_MODE: "push", INPUT_API_KEY: "lfn_secret", INPUT_APP: "app_123", INPUT_WORKING_DIRECTORY: "web", INPUT_GITHUB_TOKEN: "ghs_x", PATH: "/bin" },
      { "npx --yes @lefine/cli@0.1.0 strings push": { stdout: PUSH_JSON } },
    );
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["--yes", "@lefine/cli@0.1.0", "strings", "push", "-p", "app_123", "-d", "web", "--yes", "--json"]);
    expect(calls[0].args.join(" ")).not.toContain("lfn_secret");
    expect(calls[0].env).toMatchObject({ LEFINE_TOKEN: "lfn_secret", PATH: "/bin" });
    // The CLI does not see the action's inputs (key, GitHub token).
    expect(Object.keys(calls[0].env ?? {}).some((k) => k.startsWith("INPUT_"))).toBe(false);
    expect(outputs).toEqual({ created: "3", updated: "1", skipped: "false" });
    expect(logs).toContain("::add-mask::lfn_secret");
  });

  it("passes --file, --locale and the API origin through", () => {
    const { args, env } = cliCommand(
      { ...readInputs({}), apiKey: "k", sourceFile: "src/i18n/en.json", sourceLocale: "en", apiUrl: "https://dash.example" },
      {},
    );
    expect(args).toEqual(expect.arrayContaining(["--file", "src/i18n/en.json", "--locale", "en"]));
    expect(env.LEFINE_API_URL).toBe("https://dash.example");
  });

  it("reports nothing to push as skipped", () => {
    const { code, outputs } = harness(
      { INPUT_MODE: "push", INPUT_API_KEY: "k" },
      { npx: { stdout: JSON.stringify({ applied: false, tally: { created: 0, updated: 0, skipped: 4, dropped: 0 } }) } },
    );
    expect(code).toBe(0);
    expect(outputs.skipped).toBe("true");
  });

  it("fails when the CLI fails", () => {
    const { code, logs } = harness({ INPUT_MODE: "push", INPUT_API_KEY: "k" }, { npx: { status: 1, stdout: '{"error":"wrong workspace"}' } });
    expect(code).toBe(1);
    expect(logs.join("\n")).toContain("wrong workspace");
    expect(logs.at(-1)).toMatch(/^::error::lefine strings push failed/);
  });

  it("fails with the fix when the key is missing on the repo's own run", () => {
    const { code, calls, logs } = harness({ INPUT_MODE: "push", GITHUB_EVENT_NAME: "push" });
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
    expect(logs.at(-1)).toContain("LEFINE_API_KEY");
  });

  it("with no key but id-token: write, runs the CLI keyless: it signs in with the run's GitHub OIDC token", () => {
    const oidc = { ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.test/idtoken", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-token", INPUT_CLI_VERSION: "0.9.0" };
    const { code, calls } = harness({ INPUT_MODE: "push", INPUT_APP: "app_123", GITHUB_EVENT_NAME: "push", ...oidc }, { npx: { stdout: PUSH_JSON } });
    expect(code).toBe(0);
    expect(calls).toHaveLength(1);
    // The runner's OIDC request variables reach the CLI; no LEFINE_TOKEN is made up.
    expect(calls[0]!.env).toMatchObject({ ACTIONS_ID_TOKEN_REQUEST_URL: oidc.ACTIONS_ID_TOKEN_REQUEST_URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN: oidc.ACTIONS_ID_TOKEN_REQUEST_TOKEN });
    expect(calls[0]!.env!.LEFINE_TOKEN).toBeUndefined();
  });

  describe("sign-in order: key, fork skip, then GitHub OIDC by default", () => {
    const oidc = { ACTIONS_ID_TOKEN_REQUEST_URL: "https://pipelines.test/idtoken", ACTIONS_ID_TOKEN_REQUEST_TOKEN: "runner-token", INPUT_CLI_VERSION: "0.9.0" };

    it("the default pin is the newest CLI on npm, the same in action.yml and run.mjs", () => {
      expect(readInputs({}).cliVersion).toBe(DEFAULT_CLI_VERSION);
      const yml = readFileSync(resolve(__dirname, "../action.yml"), "utf-8");
      expect(yml).toContain(`default: "${DEFAULT_CLI_VERSION}"`);
    });

    it("keyless with a CLI older than 0.9.0 fails with the fix, before running anything", () => {
      const { code, calls, logs } = harness({ INPUT_MODE: "push", INPUT_APP: "app_123", GITHUB_EVENT_NAME: "push", ...oidc, INPUT_CLI_VERSION: "0.1.0" });
      expect(code).toBe(1);
      expect(calls).toHaveLength(0);
      expect(logs.at(-1)).toContain("needs @lefine/cli 0.9.0 or newer");
      expect(olderThan("0.5.1", "0.9.0")).toBe(true);
      expect(olderThan("0.9.0", "0.9.0")).toBe(false);
      expect(olderThan("1.0.0", "0.9.0")).toBe(false);
      expect(olderThan("latest", "0.9.0")).toBe(false);
    });

    it("a key wins when it is set, even with an OIDC token on offer", () => {
      const { code, calls, logs } = harness({ INPUT_MODE: "push", INPUT_API_KEY: "lfn_secret", INPUT_APP: "app_123", GITHUB_EVENT_NAME: "push", ...oidc }, { npx: { stdout: PUSH_JSON } });
      expect(code).toBe(0);
      expect(calls[0]!.env!.LEFINE_TOKEN).toBe("lfn_secret");
      expect(logs.join("\n")).not.toContain("OIDC");
    });

    it("with no key, says it signs in with the run's OIDC token, and the CLI gets no key", () => {
      const { code, calls, logs } = harness({ INPUT_MODE: "check", INPUT_APP: "app_123", GITHUB_EVENT_NAME: "push", ...oidc }, {
        "npx --yes @lefine/cli@0.9.0 strings missing": { stdout: JSON.stringify({ ok: true, missingTotal: 0, missing: [] }) },
        "npx --yes @lefine/cli@0.9.0 strings unused": { stdout: JSON.stringify({ ok: true, unusedTotal: 0, unused: [] }) },
        "npx --yes @lefine/cli@0.9.0 strings status": { stdout: JSON.stringify({ ok: true, liveRevision: 3, pending: { locales: [], counts: {} }, delivery: { checks: [] }, warnings: [] }) },
      });
      expect(logs.join("\n")).toContain("GitHub OIDC token (no stored secret)");
      expect(calls.length).toBeGreaterThan(0);
      for (const call of calls) expect(call.env!.LEFINE_TOKEN).toBeUndefined();
      expect(code).toBe(0);
    });

    it("a fork's pull request never signs in, even when GitHub offers an OIDC token (pull_request_target)", () => {
      const env = { INPUT_MODE: "push", INPUT_APP: "app_123", GITHUB_EVENT_NAME: "pull_request_target", GITHUB_EVENT_PATH: "/event.json", ...oidc };
      const fork = { pull_request: { head: { repo: { full_name: "someone/web" } }, base: { repo: { full_name: "acme/web" } } } };
      const calls: Call[] = [];
      const outputs: Record<string, string> = {};
      const code = run({ env, exec: (command: string, args: string[]) => (calls.push({ command, args }), { status: 0, stdout: PUSH_JSON, stderr: "" }), readEvent: () => fork, log: () => {}, setOutput: (n: string, v: string) => (outputs[n] = v), summary: () => {} });
      expect(code).toBe(0);
      expect(calls).toHaveLength(0);
      expect(outputs.skipped).toBe("true");
    });

    it("fails closed on pull requests: only one known to come from this repository signs in, never pull_request_target", () => {
      const runPr = (event: string, payload: unknown | Error) => {
        const calls: Call[] = [];
        const outputs: Record<string, string> = {};
        const code = run({
          env: { INPUT_MODE: "push", INPUT_APP: "app_123", GITHUB_EVENT_NAME: event, GITHUB_EVENT_PATH: "/event.json", ...oidc },
          exec: (command: string, args: string[]) => (calls.push({ command, args }), { status: 0, stdout: PUSH_JSON, stderr: "" }),
          readEvent: () => {
            if (payload instanceof Error) throw payload;
            return payload;
          },
          log: () => {},
          setOutput: (n: string, v: string) => (outputs[n] = v),
          summary: () => {},
        });
        return { code, ran: calls.length > 0, skipped: outputs.skipped === "true" };
      };
      const same = { pull_request: { head: { repo: { full_name: "acme/web" } }, base: { repo: { full_name: "acme/web" } } } };
      expect(runPr("pull_request", same)).toEqual({ code: 0, ran: true, skipped: false });
      expect(runPr("pull_request_target", same)).toEqual({ code: 0, ran: false, skipped: true });
      // A deleted fork has head.repo null; an unreadable event is not trusted either.
      expect(runPr("pull_request", { pull_request: { head: { repo: null }, base: { repo: { full_name: "acme/web" } } } })).toEqual({ code: 0, ran: false, skipped: true });
      expect(runPr("pull_request", new Error("no event file"))).toEqual({ code: 0, ran: false, skipped: true });
    });

    it("OIDC needs the app id: a workspace/app name is refused with the fix", () => {
      const { code, calls, logs } = harness({ INPUT_MODE: "push", INPUT_APP: "acme/web", GITHUB_EVENT_NAME: "push", ...oidc });
      expect(code).toBe(1);
      expect(calls).toHaveLength(0);
      expect(logs.at(-1)).toContain("needs the app's id (app_...)");
    });

    it("with no app input, the id comes from lefine.ts; without one it says how to get it", () => {
      const dir = mkdtempSync(join(tmpdir(), "lefine-action-"));
      try {
        const missing = harness({ INPUT_MODE: "push", INPUT_WORKING_DIRECTORY: dir, GITHUB_EVENT_NAME: "push", ...oidc });
        expect(missing.code).toBe(1);
        expect(missing.logs.at(-1)).toContain("npx lefine init");
        writeFileSync(join(dir, "lefine.ts"), 'export const lefine = createLefine({ project: "app_abc123", defaultLocale: "en" });\n');
        const ok = harness({ INPUT_MODE: "push", INPUT_WORKING_DIRECTORY: dir, GITHUB_EVENT_NAME: "push", ...oidc }, { npx: { stdout: PUSH_JSON } });
        expect(ok.code).toBe(0);
        expect(ok.calls).toHaveLength(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  });

  it("the missing-key error names the keyless way first", () => {
    const { logs } = harness({ INPUT_MODE: "push", GITHUB_EVENT_NAME: "push" });
    expect(logs.at(-1)).toContain("id-token: write");
    expect(logs.at(-1)).toContain("lefine ci trust add");
  });

  it("skips, green, on a fork's pull request (no secrets there)", () => {
    const env = { INPUT_MODE: "push", GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: "/e.json" };
    const fork = () => ({ pull_request: { head: { repo: { full_name: "someone/web" } }, base: { repo: { full_name: "acme/web" } } } });
    expect(runsWithoutSecrets(env, fork)).toBe(true);
    const same = () => ({ pull_request: { head: { repo: { full_name: "acme/web" } }, base: { repo: { full_name: "acme/web" } } } });
    expect(runsWithoutSecrets(env, same)).toBe(false);
    expect(runsWithoutSecrets({ GITHUB_ACTOR: "dependabot[bot]" })).toBe(true);
  });
});

describe("check", () => {
  const status = (preview: object) => ({ stdout: JSON.stringify({ ok: true, app: "app_1", pending: 1, preview }) });
  const clean = { locales: [{ locale: "en", willServe: 4 }, { locale: "de", willServe: 4 }], textWarnings: [], textWarningCount: 0 };
  const lostName = {
    locales: [{ locale: "en", willServe: 5 }, { locale: "de", willServe: 3 }, { locale: "fr", willServe: 5 }],
    textWarnings: [{ locale: "fr", namespace: "common", key: "save", reason: "variables", missing: ["{name}"], extra: [] }],
    textWarningCount: 1,
  };

  it("passes when the code's keys exist, every language is translated and no text lost a variable", () => {
    const { code, calls, outputs } = harness(
      { INPUT_MODE: "check", INPUT_API_KEY: "k", INPUT_APP: "app_1" },
      {
        "npx --yes @lefine/cli@0.1.0 strings missing": { stdout: JSON.stringify({ ok: true, missingTotal: 0, missing: [] }) },
        "npx --yes @lefine/cli@0.1.0 strings unused": { stdout: JSON.stringify({ ok: true, unusedTotal: 0, unused: [] }) },
        "npx --yes @lefine/cli@0.1.0 strings status": status(clean),
      },
    );
    expect(code).toBe(0);
    expect(calls.map((c) => c.args.slice(2).join(" "))).toEqual(["strings missing -p app_1 -d . --json", "strings unused -p app_1 -d . --json", "strings status -p app_1 -d . --json"]);
    expect(outputs).toMatchObject({ "missing-keys": "0", untranslated: "0", "text-warnings": "0", "unused-keys": "0" });
  });

  describe("doctor in check mode: unused keys warn, a pull request gets one comment", () => {
    const clean = { ok: true, liveRevision: 3, pending: { locales: [], counts: {} }, delivery: { checks: [] }, warnings: [], preview: { locales: [], textWarnings: [], textWarningCount: 0 } };
    const replies = (unused: unknown, missing: unknown = { ok: true, missingTotal: 0, missing: [] }) => ({
      "npx --yes @lefine/cli@0.1.0 strings missing": { status: (missing as { missingTotal: number }).missingTotal ? 1 : 0, stdout: JSON.stringify(missing) },
      "npx --yes @lefine/cli@0.1.0 strings unused": { stdout: JSON.stringify(unused) },
      "npx --yes @lefine/cli@0.1.0 strings status": { stdout: JSON.stringify(clean) },
    });
    const UNUSED = { ok: true, unusedTotal: 2, unused: [{ keyId: "key_1", namespace: "old", key: "banner" }, { keyId: "key_2", namespace: "old", key: "promo" }] };

    it("unused keys are a warning: annotated, counted, the step still passes", () => {
      const { code, outputs, logs } = harness({ INPUT_MODE: "check", INPUT_API_KEY: "k", INPUT_APP: "app_1" }, replies(UNUSED));
      expect(code).toBe(0);
      expect(outputs["unused-keys"]).toBe("2");
      expect(logs.some((l) => l.startsWith("::warning title=Lefine unused keys::2 keys in Lefine are not used in the code: old.banner, old.promo"))).toBe(true);
    });

    it("fail-on: unused-keys makes them fail", () => {
      const { code, logs } = harness({ INPUT_MODE: "check", INPUT_API_KEY: "k", INPUT_APP: "app_1", INPUT_FAIL_ON: "missing-keys,unused-keys" }, replies(UNUSED));
      expect(code).toBe(1);
      expect(logs.at(-1)).toContain("unused-keys 2");
    });

    it("on a pull request: one comment with the lists, made once and then updated in place", () => {
      const missing = { ok: true, missingTotal: 1, missing: ["home.title"] };
      const runOnPr = (existing: string) => {
        const calls: Call[] = [];
        const logs: string[] = [];
        const code = run({
          env: { INPUT_MODE: "check", INPUT_API_KEY: "k", INPUT_APP: "app_1", INPUT_GITHUB_TOKEN: "ghs_x", GITHUB_EVENT_NAME: "pull_request", GITHUB_EVENT_PATH: "/e.json", GITHUB_REPOSITORY: "acme/web" },
          exec: (command: string, args: string[], options: { env?: Record<string, string> } = {}) => {
            calls.push({ command, args, env: options.env });
            const line = `${command} ${args.join(" ")}`;
            if (command === "gh" && args[1] === "user") return { status: 1, stdout: "", stderr: "Resource not accessible by integration" };
            if (command === "gh" && args.includes("--paginate")) return { status: 0, stdout: existing, stderr: "" };
            if (command === "gh") return { status: 0, stdout: "{}", stderr: "" };
            const key = Object.keys(replies(UNUSED, missing)).find((k) => line.startsWith(k));
            const reply = key ? (replies(UNUSED, missing) as Record<string, { status?: number; stdout: string }>)[key]! : { stdout: "" };
            return { status: reply.status ?? 0, stdout: reply.stdout, stderr: "" };
          },
          readEvent: () => ({ pull_request: { number: 7 } }),
          log: (l: string) => logs.push(l),
          setOutput: () => {},
          summary: () => {},
        });
        return { code, gh: calls.filter((c) => c.command === "gh") };
      };
      const first = runOnPr("");
      expect(first.code).toBe(1); // missing keys fail by default
      const post = first.gh.at(-1)!;
      expect(post.args.slice(0, 4)).toEqual(["api", "-X", "POST", "repos/acme/web/issues/7/comments"]);
      const body = post.args.at(-1)!;
      expect(body.startsWith(`body=${COMMENT_MARKER}`)).toBe(true);
      expect(body).toContain("1 names in the code have no key in Lefine** (fails this check");
      expect(body).toContain("- `home.title`");
      expect(body).toContain("2 keys in Lefine are not used in the code** (a warning");
      expect(body).toContain("- `old.banner`");
      // The token reaches gh as GH_TOKEN only, and no INPUT_ variable does.
      expect(post.env!.GH_TOKEN).toBe("ghs_x");
      expect(Object.keys(post.env!).some((k) => k.startsWith("INPUT_"))).toBe(false);

      // Only a marked comment by the token's own identity is looked for (the default token: github-actions[bot]).
      const list = first.gh.find((c) => c.args.includes("--paginate"))!;
      expect(list.args.at(-1)).toContain('.user.login == "github-actions[bot]"');
      const again = runOnPr("123456\n");
      expect(again.gh.at(-1)!.args.slice(0, 4)).toEqual(["api", "-X", "PATCH", "repos/acme/web/issues/comments/123456"]);
    });

    it("no comment outside a pull request, with comment: false, or without a token", () => {
      for (const env of [
        { GITHUB_EVENT_NAME: "push" },
        { GITHUB_EVENT_NAME: "pull_request", INPUT_COMMENT: "false" },
        { GITHUB_EVENT_NAME: "pull_request", INPUT_GITHUB_TOKEN: "" },
      ]) {
        const { calls } = harness({ INPUT_MODE: "check", INPUT_API_KEY: "k", INPUT_APP: "app_1", INPUT_GITHUB_TOKEN: "ghs_x", GITHUB_REPOSITORY: "acme/web", ...env }, replies(UNUSED));
        expect(calls.some((c) => c.command === "gh")).toBe(false);
      }
    });

    it("server names in the comment cannot break out of code or ping anyone", () => {
      const body = checkComment({
        counts: { "missing-keys": 1, "unused-keys": 0, untranslated: 0, "text-warnings": 0 },
        failing: ["missing-keys"],
        missing: ["a`b\n@everyone <img src=x>"],
        unused: [],
        untranslated: [],
        warnings: [],
      });
      expect(body).toContain("- `a'b @everyone <img src=x>`");
      expect(body.split("\n").filter((l) => l.startsWith("- ")).length).toBe(1);
    });

    it("an all-clear comment when nothing is found", () => {
      expect(checkComment({ counts: { "missing-keys": 0, "unused-keys": 0, untranslated: 0, "text-warnings": 0 }, failing: [], missing: [], unused: [], untranslated: [], warnings: [] })).toContain("Every check passed");
    });
  });

  it("fails on each problem and annotates the lost variable", () => {
    const { code, outputs, logs } = harness(
      { INPUT_MODE: "check", INPUT_API_KEY: "k" },
      {
        // missing exits 1 when it finds names: still an answer.
        "npx --yes @lefine/cli@0.1.0 strings missing": { status: 1, stdout: JSON.stringify({ ok: true, missingTotal: 2, missing: ["home.title", "home.cta"] }) },
        "npx --yes @lefine/cli@0.1.0 strings unused": { stdout: JSON.stringify({ ok: true, unusedTotal: 0, unused: [] }) },
        "npx --yes @lefine/cli@0.1.0 strings status": status(lostName),
      },
    );
    expect(code).toBe(1);
    expect(outputs).toMatchObject({ "missing-keys": "2", untranslated: "2", "text-warnings": "1" });
    expect(logs).toContain("::warning title=Lefine::fr common.save: lost {name}");
    expect(logs.at(-1)).toBe("::error::Lefine check failed: missing-keys 2, untranslated 2, text-warnings 1.");
  });

  it("fail-on picks what fails; none only reports", () => {
    const replies = {
      "npx --yes @lefine/cli@0.1.0 strings missing": { stdout: JSON.stringify({ ok: true, missingTotal: 0, missing: [] }) },
      "npx --yes @lefine/cli@0.1.0 strings unused": { stdout: JSON.stringify({ ok: true, unusedTotal: 0, unused: [] }) },
      "npx --yes @lefine/cli@0.1.0 strings status": status(lostName),
    };
    expect(harness({ INPUT_MODE: "check", INPUT_API_KEY: "k", INPUT_FAIL_ON: "none" }, replies).code).toBe(0);
    expect(harness({ INPUT_MODE: "check", INPUT_API_KEY: "k", INPUT_FAIL_ON: "missing-keys" }, replies).code).toBe(0);
    expect(harness({ INPUT_MODE: "check", INPUT_API_KEY: "k", INPUT_FAIL_ON: "text-warnings" }, replies).code).toBe(1);
    expect(harness({ INPUT_MODE: "check", INPUT_API_KEY: "k", INPUT_FAIL_ON: "typos" }, replies).code).toBe(1);
  });

  it("fails on a CLI error, and says when the pinned CLI is too old for check", () => {
    const { code, logs } = harness(
      { INPUT_MODE: "check", INPUT_API_KEY: "k" },
      { npx: { status: 1, stderr: "error: unknown command 'missing'" } },
    );
    expect(code).toBe(1);
    expect(logs.at(-1)).toContain("has no `strings missing`; set cli-version");
  });

  it("a key name from the server cannot start a workflow command", () => {
    const evil = { ...lostName, textWarnings: [{ ...lostName.textWarnings[0], key: "save\n::add-mask::x" }] };
    const { logs } = harness(
      { INPUT_MODE: "check", INPUT_API_KEY: "k" },
      {
        "npx --yes @lefine/cli@0.1.0 strings missing": { stdout: JSON.stringify({ ok: true, missingTotal: 1, missing: ["a\n::set-output name=x::1"] }) },
        "npx --yes @lefine/cli@0.1.0 strings unused": { stdout: JSON.stringify({ ok: true, unusedTotal: 0, unused: [] }) },
        "npx --yes @lefine/cli@0.1.0 strings status": status(evil),
      },
    );
    expect(logs).toContain("::warning title=Lefine::fr common.save%0A::add-mask::x: lost {name}");
    // Every other line with server text sits between ::stop-commands::<token> and ::<token>::.
    const open = logs.findIndex((l: string) => l.startsWith("::stop-commands::") && logs[logs.indexOf(l) + 1]?.includes("set-output"));
    expect(open).toBeGreaterThanOrEqual(0);
    expect(logs[open + 2]).toBe(`::${logs[open].slice("::stop-commands::".length)}::`);
    expect(logs[open + 1]).not.toMatch(/\n::/);
  });

  it("counts untranslated texts against the fullest language", () => {
    expect(untranslatedByLocale(lostName.locales ? lostName : {})).toEqual([{ locale: "de", untranslated: 2 }]);
    expect(untranslatedByLocale({})).toEqual([]);
  });
});

describe("pull", () => {
  const env = { INPUT_MODE: "pull", INPUT_OUTPUT: "locales", INPUT_GITHUB_TOKEN: "ghs_x", GITHUB_REF_NAME: "main" };
  const status = ["?? locales/de.json", " M locales/fr.json", " M locales/en.json", "?? locales/.pull-state.json", ""].join("\0");

  it("commits the changed translations, not the source file or the pull state, and opens a PR", () => {
    const { code, calls, outputs } = harness(env, {
      "git status": { stdout: status },
      "gh pr list": { stdout: "" },
      "gh pr create": { stdout: "https://github.com/acme/web/pull/7\n" },
    });
    expect(code).toBe(0);
    const line = (c: Call) => `${c.command} ${c.args.join(" ")}`;
    expect(line(calls[0])).toBe("npx --yes @lefine/cli@0.1.0 strings pull -d . --force -o locales");
    expect(calls.map(line)).toEqual(
      expect.arrayContaining([
        "git checkout -B lefine/strings",
        "git add -- locales/de.json locales/fr.json",
        "git push --force origin HEAD:refs/heads/lefine/strings",
      ]),
    );
    const create = calls.find((c) => line(c).startsWith("gh pr create"))!;
    expect(create.args).toEqual(expect.arrayContaining(["--base", "main", "--head", "lefine/strings"]));
    expect(create.env?.GH_TOKEN).toBe("ghs_x");
    expect(outputs).toMatchObject({ "changed-files": "2", "pr-url": "https://github.com/acme/web/pull/7", skipped: "false" });
  });

  it("updates the open PR instead of opening a second one", () => {
    const { calls, outputs } = harness(env, {
      "git status": { stdout: status },
      "gh pr list": { stdout: "https://github.com/acme/web/pull/5\n" },
    });
    expect(calls.some((c) => c.command === "gh" && c.args[1] === "create")).toBe(false);
    expect(outputs["pr-url"]).toBe("https://github.com/acme/web/pull/5");
  });

  it("does nothing when no translation changed", () => {
    const { code, calls, outputs } = harness(env, { "git status": { stdout: "?? locales/.pull-state.json\0" } });
    expect(code).toBe(0);
    expect(calls.map((c) => c.command)).toEqual(["npx", "git"]);
    expect(outputs).toMatchObject({ "changed-files": "0", skipped: "true" });
  });

  it("refuses to force-push the base branch", () => {
    const { code, calls } = harness({ ...env, INPUT_BRANCH: "main" });
    expect(code).toBe(1);
    expect(calls).toHaveLength(0);
  });
});

describe("helpers", () => {
  it("keeps the source file when include-source is on, and honours another source locale", () => {
    const z = "?? l/de.json\0 M l/pt-br.json\0 M l/README.md\0";
    expect(filesToCommit(z, { includeSource: false, sourceLocale: "pt-BR" })).toEqual(["l/de.json"]);
    expect(filesToCommit(z, { includeSource: true, sourceLocale: "pt-BR" })).toEqual(["l/de.json", "l/pt-br.json"]);
  });

  it("reads the push JSON even after a stray line", () => {
    expect(parsePushResult(`npm warn\n${PUSH_JSON}`)).toMatchObject({ applied: true, created: 3, updated: 1 });
  });

  it("rejects a cli-version that is not a version and an unknown mode", () => {
    expect(harness({ INPUT_MODE: "push", INPUT_API_KEY: "k", INPUT_CLI_VERSION: "../evil" }).code).toBe(1);
    expect(harness({ INPUT_MODE: "sync" }).code).toBe(1);
  });

  it("action.yml hands every input to the script as env, never as ${{ }} in run", () => {
    const yml = readFileSync(resolve(__dirname, "../action.yml"), "utf-8");
    const run = yml.slice(yml.indexOf("      run:"));
    expect(run).not.toContain("${{");
    for (const input of [...yml.matchAll(/^ {2}([a-z-]+):\n {4}description/gm)].map((m) => m[1])) {
      if (["created", "updated", "skipped", "changed-files", "pr-url", "missing-keys", "untranslated", "text-warnings", "unused-keys"].includes(input)) continue;
      expect(yml).toContain(`INPUT_${input.toUpperCase().replace(/-/g, "_")}: \${{ inputs.${input} }}`);
    }
  });
});
