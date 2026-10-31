import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringsSnapshotCommand } from "../strings-snapshot.js";

const realExit = process.exit;
const realLog = console.log;
const realErr = console.error;
let dir: string;
let logs: string[];
const APP = "app_0123456789abcdef0123456789abcdef";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lefine-snap-"));
  logs = [];
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  console.error = (...a: unknown[]) => void logs.push(a.join(" "));
  process.exit = ((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as typeof process.exit;
});
afterEach(() => {
  process.exit = realExit;
  console.log = realLog;
  console.error = realErr;
  delete process.env.LEFINE_CDN_URL;
  rmSync(dir, { recursive: true, force: true });
});

describe("lefine strings snapshot", () => {
  it("reads the app id from lefine.ts and writes what the app's own createSnapshot returns", async () => {
    writeFileSync(join(dir, "lefine.ts"), `export const lefine = createLefine({ project: "${APP}", locales: ["en"], defaultLocale: "en" });\n`);
    process.env.LEFINE_CDN_URL = "http://edge.test/";
    const asked: unknown[] = [];
    const load = async () => async (config: { project: string; cdn?: string }) => (asked.push(config), { [`lefine:${APP}:manifest`]: "{}", [`lefine:${APP}:en`]: "{}" });
    await stringsSnapshotCommand({ dir }, { load });
    expect(asked).toEqual([{ project: APP, cdn: "http://edge.test" }]);
    expect(Object.keys(JSON.parse(readFileSync(join(dir, "lefine-snapshot.json"), "utf-8")))).toEqual([`lefine:${APP}:manifest`, `lefine:${APP}:en`]);
    expect(logs.join("\n")).toContain("1 language of");
  });

  it("a name alias is refused (a snapshot is read by app id); nothing published is said, not written", async () => {
    await expect(stringsSnapshotCommand({ dir, project: "acme/web" })).rejects.toThrow("exit:1");
    expect(logs.join("\n")).toContain("by app id");
    logs = [];
    await expect(stringsSnapshotCommand({ dir, project: APP }, { load: async () => async () => ({ [`lefine:${APP}:manifest`]: "{}" }) })).rejects.toThrow("exit:1");
    expect(logs.join("\n")).toContain("Nothing is published");
  });

  it("outside the lefine package (run from source) it says how to run it, and never loads the app's own modules", async () => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "app", dependencies: { lefine: "1" } }));
    await expect(stringsSnapshotCommand({ dir, project: APP })).rejects.toThrow("exit:1");
    expect(logs.join("\n")).toContain("npx lefine strings snapshot");
  });
});
