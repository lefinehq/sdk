import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importCommand } from "../import-command.js";

const FIX = join(import.meta.dir, "fixtures", "tms");
const realFetch = globalThis.fetch;
const realExit = process.exit;
const realLog = console.log;
const realErr = console.error;
let dir: string;
let logs: string[];
let calls: Array<{ name: string; input: any }>;

const APP = { id: "app_web1", slug: "web", name: "Web", sourceLocale: "en", targetLocales: ["de", "en-GB"], keyCount: 0 };
const PREVIEW = (created: number) => ({
  digest: "a".repeat(64),
  source: created,
  tally: { created, updated: 0, skipped: 0, dropped: 0 },
  dropped: [],
  newNamespace: false,
  alreadyImported: null,
  changes: { locales: [] },
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lefine-import-"));
  process.env.LEFINE_HOME = join(dir, "home");
  process.env.LEFINE_TOKEN = "lfn_test_token_value";
  process.env.LEFINE_API_URL = "http://api.test";
  logs = [];
  calls = [];
  console.log = (...a: unknown[]) => void logs.push(a.join(" "));
  console.error = (...a: unknown[]) => void logs.push(a.join(" "));
  process.exit = ((code?: number) => {
    throw new Error(`exit:${code ?? 0}`);
  }) as typeof process.exit;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const name = String(input).split("/v1/ops/")[1]!;
    const body = JSON.parse(String(init?.body));
    calls.push({ name, input: body.input });
    if (name === "strings.apps.list") return Response.json({ ok: true, data: { items: [APP] } });
    if (name === "strings.import.preview") return Response.json({ ok: true, data: PREVIEW(Object.keys(JSON.parse(body.input.content)).length) });
    if (name === "strings.import.apply") return Response.json({ ok: true, data: { run: { id: "run_1", status: "succeeded", steps: [] }, replayed: false } });
    return Response.json({ ok: false, error: { code: "NOT_FOUND", message: name } }, { status: 404 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  process.exit = realExit;
  console.log = realLog;
  console.error = realErr;
  delete process.env.LEFINE_HOME;
  delete process.env.LEFINE_TOKEN;
  delete process.env.LEFINE_API_URL;
  rmSync(dir, { recursive: true, force: true });
});

const applies = () => calls.filter((c) => c.name === "strings.import.apply").map((c) => ({ locale: c.input.locale, namespace: c.input.namespace, state: c.input.state, content: JSON.parse(c.input.content) }));

describe("lefine import", () => {
  it("Crowdin's JSON zip: the source first, then de-DE mapped to the app's de, as reviewed (no review state in JSON)", async () => {
    await importCommand(join(FIX, "crowdin/zip"), { from: "crowdin", project: "app_web1", yes: true });
    expect(applies()).toEqual([
      { locale: "en", namespace: "common", state: undefined, content: { welcome: "Welcome, {{name}}!", "nav.save": "Save", "nav.cancel": "Cancel", items_one: "{{count}} item", items_other: "{{count}} items" } },
      { locale: "de", namespace: "common", state: "reviewed", content: { welcome: "Willkommen, {{name}}!", "nav.save": "Speichern", "nav.cancel": "Abbrechen", items_one: "{{count}} Artikel", items_other: "{{count}} Artikel" } },
    ]);
    expect(logs.join("\n")).toContain("de-DE → de: the app has the language, not that region.");
  });

  it("Lokalise XLIFF: one import per state, approved first; the source language from the XLIFF", async () => {
    await importCommand(join(FIX, "lokalise/de.xliff"), { from: "lokalise", project: "app_web1", yes: true });
    expect(applies().map((a) => [a.locale, a.namespace, a.state, Object.keys(a.content)])).toEqual([
      ["en", "common", undefined, ["welcome", "items"]],
      ["en", "nav", undefined, ["save", "cancel"]],
      ["de", "common", "approved", ["welcome"]],
      ["de", "nav", "reviewed", ["save", "cancel"]],
      ["de", "common", "reviewed", ["items"]],
    ]);
  });

  it("Phrase Strings JSON: en-US matches en, en-GB is its own language; a language the app lacks is skipped with a note", async () => {
    await importCommand(join(FIX, "phrase/strings.json"), { from: "phrase", project: "app_web1", yes: true });
    expect(applies().map((a) => [a.locale, a.state])).toEqual([
      ["en", undefined],
      ["de", "reviewed"],
    ]);
    calls.length = 0;
    logs.length = 0;
    await importCommand(join(FIX, "phrase/en-GB.xlf"), { from: "phrase", project: "app_web1", yes: true });
    // de-DE is the XLIFF's base language here: the app's de (a target), reviewed; en-GB keeps its signed-off text approved.
    expect(applies().map((a) => [a.locale, a.state, Object.keys(a.content)])).toEqual([
      ["de", "reviewed", ["welcome", "items"]],
      ["de", "reviewed", ["save"]],
      ["en-GB", "approved", ["welcome"]],
      ["en-GB", "reviewed", ["save"]],
      ["en-GB", "reviewed", ["items"]],
    ]);
    expect(logs.join("\n")).toContain("No en (the app's source language) in the export");
  });

  it("Transifex XLIFF: approved=yes lands approved, the plural group as one ICU text", async () => {
    await importCommand(join(FIX, "transifex/de.xlf"), { from: "transifex", project: "app_web1", yes: true });
    expect(applies().map((a) => [a.locale, a.namespace, a.state, Object.keys(a.content)])).toEqual([
      ["en", "common", undefined, ["welcome", "trial"]],
      ["en", "nav", undefined, ["save", "cancel"]],
      ["de", "common", "approved", ["welcome"]],
      ["de", "nav", "reviewed", ["save"]],
      ["de", "common", "reviewed", ["trial"]],
    ]);
  });

  it("POEditor: JSON with --locale; a PO file's fuzzy entries are left out and the note says how to bring them", async () => {
    // POEditor's JSON says no language; a file not named for one takes --locale (a name like fr.json would win).
    const terms = join(dir, "terms.json");
    writeFileSync(terms, readFileSync(join(FIX, "poeditor/fr.json"), "utf-8"));
    await importCommand(terms, { from: "poeditor", project: "app_web1", locale: "de", yes: true });
    expect(applies()[0]).toMatchObject({ locale: "de", state: "reviewed" });
    calls.length = 0;
    logs.length = 0;
    await importCommand(join(FIX, "poeditor/ja.po"), { from: "poeditor", project: "app_web1", locale: "de", yes: true });
    // ja is not a language of the app: skipped, with the fuzzy note.
    const text = logs.join("\n");
    expect(text).toContain("1 fuzzy entry (needs review in the tool) left out; --include-fuzzy brings them in as reviewed.");
    expect(text).toContain("Skipped ja");
    expect(applies()).toEqual([]);
  });

  it("refuses Crowdin XLIFF, an unknown tool and a bad --state before any call to Lefine", async () => {
    await expect(importCommand(join(FIX, "crowdin/de-DE.xlf"), { from: "crowdin", project: "app_web1", yes: true })).rejects.toThrow("exit:1");
    expect(logs.join("\n")).toContain("download the translations as JSON");
    await expect(importCommand(join(FIX, "crowdin/zip"), { from: "smartling", project: "app_web1", yes: true })).rejects.toThrow("exit:1");
    await expect(importCommand(join(FIX, "crowdin/zip"), { from: "crowdin", state: "final", project: "app_web1", yes: true })).rejects.toThrow("exit:1");
    expect(calls).toEqual([]);
  });

  it("in CI without --yes it shows the source plan and imports nothing", async () => {
    await expect(importCommand(join(FIX, "crowdin/zip"), { from: "crowdin", project: "app_web1" })).rejects.toThrow("exit:1");
    expect(calls.some((c) => c.name === "strings.import.apply")).toBe(false);
    expect(logs.join("\n")).toContain("--yes");
  });
});
