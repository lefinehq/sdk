import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHECK_INTERVAL_MS,
  aiNotice,
  cachedUpdate,
  cliNotice,
  compareVersions,
  hostPackage,
  pickUpdate,
  refreshUpdate,
  serverNotice,
  tagOf,
  updateCheckDisabled,
} from "../update-check.js";
import { localNpxArgs } from "../setup-command.js";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lefine-update-"));
  file = join(dir, "sub", "update-check.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const lefine = { name: "lefine", version: "0.11.1" };
const mcpRc = { name: "@lefine/mcp", version: "1.0.0-rc.2" };

describe("compareVersions / pickUpdate", () => {
  test("semver order, a prerelease is below its release", () => {
    expect(compareVersions("0.12.0", "0.11.9")).toBe(1);
    expect(compareVersions("0.9.0", "0.10.0")).toBe(-1);
    expect(compareVersions("1.0.0-rc.3", "1.0.0-rc.2")).toBe(1);
    expect(compareVersions("1.0.0-rc.10", "1.0.0-rc.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0-rc.9")).toBe(1);
    expect(compareVersions("1.0.0-rc.2", "1.0.0-rc.2")).toBe(0);
    expect(compareVersions("junk", "1.0.0")).toBe(0);
  });

  test("a stable version looks at latest only; a next tag it is not on is ignored", () => {
    expect(pickUpdate(lefine, { latest: "0.12.0", next: "1.0.0-rc.1" })).toEqual({ ...lefine, latest: "0.12.0", tag: "latest" });
    expect(pickUpdate(lefine, { latest: "0.11.1", next: "1.0.0-rc.1" })).toBeNull();
    expect(pickUpdate({ name: "@lefine/mcp", version: "0.2.7" }, { latest: "0.2.7", next: "1.0.0-rc.2" })).toBeNull();
  });

  test("a prerelease compares with next, and with latest when that is higher", () => {
    expect(pickUpdate(mcpRc, { latest: "0.2.7", next: "1.0.0-rc.3" })).toEqual({ ...mcpRc, latest: "1.0.0-rc.3", tag: "next" });
    expect(pickUpdate(mcpRc, { latest: "1.0.0", next: "1.0.0-rc.3" })).toEqual({ ...mcpRc, latest: "1.0.0", tag: "latest" });
    expect(pickUpdate(mcpRc, { latest: "0.2.7", next: "1.0.0-rc.2" })).toBeNull();
  });

  test("tagOf: a prerelease is next, else latest", () => {
    expect(tagOf("1.0.0-rc.2")).toBe("next");
    expect(tagOf("0.11.1")).toBe("latest");
  });
});

describe("updateCheckDisabled", () => {
  test("CI, GitHub Actions, LEFINE_NO_UPDATE_CHECK and NO_UPDATE_NOTIFIER turn it off; 0 and empty do not", () => {
    expect(updateCheckDisabled({})).toBe(false);
    expect(updateCheckDisabled({ CI: "true" })).toBe(true);
    expect(updateCheckDisabled({ GITHUB_ACTIONS: "true" })).toBe(true);
    expect(updateCheckDisabled({ LEFINE_NO_UPDATE_CHECK: "1" })).toBe(true);
    expect(updateCheckDisabled({ NO_UPDATE_NOTIFIER: "" })).toBe(true);
    expect(updateCheckDisabled({ LEFINE_NO_UPDATE_CHECK: "0", CI: "" })).toBe(false);
  });
});

describe("refreshUpdate / cachedUpdate", () => {
  test("asks the registry, writes the cache (owner-only dir), and the next start reads it without the network", async () => {
    let calls = 0;
    const fetchTags = async () => (calls++, { latest: "0.12.0" });
    const got = await refreshUpdate(lefine, { env: {}, file, now: () => 1_000, fetchTags });
    expect(got).toMatchObject({ latest: "0.12.0", tag: "latest" });
    expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ lefine: { checkedAt: 1_000, tags: { latest: "0.12.0" } } });
    expect(cachedUpdate(lefine, { env: {}, file })).toMatchObject({ latest: "0.12.0" });
    // Updated: the same cache now says nothing.
    expect(cachedUpdate({ ...lefine, version: "0.12.0" }, { env: {}, file })).toBeNull();
    expect(calls).toBe(1);
  });

  test("at most once per 24 hours; after that it asks again and keeps other packages' entries", async () => {
    let calls = 0;
    const fetchTags = async () => (calls++, { latest: "0.12.0" });
    await refreshUpdate(lefine, { env: {}, file, now: () => 0, fetchTags });
    expect(await refreshUpdate(lefine, { env: {}, file, now: () => CHECK_INTERVAL_MS - 1, fetchTags })).toBeNull();
    expect(calls).toBe(1);
    await refreshUpdate(mcpRc, { env: {}, file, now: () => CHECK_INTERVAL_MS - 1, fetchTags: async () => ({ next: "1.0.0-rc.3", latest: "0.2.7" }) });
    await refreshUpdate(lefine, { env: {}, file, now: () => CHECK_INTERVAL_MS, fetchTags });
    expect(calls).toBe(2);
    expect(Object.keys(JSON.parse(readFileSync(file, "utf-8"))).sort()).toEqual(["@lefine/mcp", "lefine"]);
  });

  test("CI and LEFINE_NO_UPDATE_CHECK: no request, no cache file, nothing reported", async () => {
    let calls = 0;
    const fetchTags = async () => (calls++, { latest: "9.9.9" });
    for (const env of [{ CI: "1" }, { LEFINE_NO_UPDATE_CHECK: "1" }]) {
      expect(await refreshUpdate(lefine, { env, file, fetchTags })).toBeNull();
    }
    expect(calls).toBe(0);
    expect(existsSync(file)).toBe(false);
    writeFileSync(join(dir, "c.json"), JSON.stringify({ lefine: { checkedAt: 0, tags: { latest: "9.9.9" } } }));
    expect(cachedUpdate(lefine, { env: { CI: "1" }, file: join(dir, "c.json") })).toBeNull();
  });

  test("offline or a registry error: null, no cache written, no throw", async () => {
    expect(await refreshUpdate(lefine, { env: {}, file, fetchTags: async () => null })).toBeNull();
    expect(await refreshUpdate(lefine, { env: {}, file, fetchTags: async () => Promise.reject(new Error("ENOTFOUND")) })).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  test("a hanging registry is given up on after the timeout", async () => {
    const t0 = Date.now();
    const got = await refreshUpdate(lefine, { env: {}, file, timeoutMs: 60, fetchTags: () => new Promise(() => {}) });
    expect(got).toBeNull();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(existsSync(file)).toBe(false);
  });

  test("a broken or foreign cache file is treated as empty", async () => {
    writeFileSync(join(dir, "bad.json"), "{not json");
    expect(cachedUpdate(lefine, { env: {}, file: join(dir, "bad.json") })).toBeNull();
    writeFileSync(join(dir, "arr.json"), "[1]");
    expect(await refreshUpdate(lefine, { env: {}, file: join(dir, "arr.json"), fetchTags: async () => ({ latest: "0.12.0" }) })).toMatchObject({ latest: "0.12.0" });
  });
});

describe("what people see", () => {
  const u = { ...lefine, latest: "0.12.0", tag: "latest" };
  test("CLI line: npx users get the npx command, others npm i", () => {
    expect(cliNotice(u, { npm_command: "exec" })).toBe("lefine 0.12.0 is out (you have 0.11.1). Update: npx lefine@latest ...   (silence: LEFINE_NO_UPDATE_CHECK=1)");
    expect(cliNotice(u, {})).toContain("Update: npm i lefine@latest");
  });
  test("MCP stderr line and the AI sentence name the version and the fix command", () => {
    const m = { ...mcpRc, latest: "1.0.0-rc.3", tag: "next" };
    expect(serverNotice(m)).toBe("lefine mcp: 1.0.0-rc.3 is out (you run 1.0.0-rc.2). Restart your AI app to get it. Still 1.0.0-rc.2 after a restart? Run: npx @lefine/mcp@next setup --local");
    expect(aiNotice(m)).toContain("a newer Lefine MCP (1.0.0-rc.3) is out");
    expect(aiNotice(m)).toContain("restarting this app gets it");
    expect(aiNotice(m)).not.toContain("\n");
  });
});

describe("the package a process runs as", () => {
  test("LEFINE_HOST_PACKAGE (set by the @lefine/mcp bin) wins over the CLI's own package", () => {
    expect(hostPackage({ LEFINE_HOST_PACKAGE: "@lefine/mcp@1.0.0-rc.2" })).toEqual(mcpRc);
    expect(hostPackage({})).toMatchObject({ name: "lefine" });
  });
  test("setup writes a tagged command in the package the person ran", () => {
    expect(localNpxArgs(lefine)).toEqual(["-y", "lefine@latest", "mcp"]);
    expect(localNpxArgs({ name: "lefine", version: "0.12.0-rc.1" })).toEqual(["-y", "lefine@next", "mcp"]);
    expect(localNpxArgs(mcpRc)).toEqual(["-y", "@lefine/mcp@next"]);
    expect(localNpxArgs({ name: "@lefine/mcp", version: "1.0.0" })).toEqual(["-y", "@lefine/mcp@latest"]);
  });
});
