import { describe, it, expect } from "bun:test";
import { describeChangesSince, parseSinceRevision } from "../changes-report.js";
import type { CdnChangesFile } from "../../analyzer/types.js";

const changes = (revision: number): CdnChangesFile => ({
  revision,
  version: "v",
  previousVersion: null,
  publishedAt: "2026-10-22T10:00:00.000Z",
  locales: {
    de: {
      added: 2,
      changed: 1,
      removed: 0,
      keys: { added: [["common", "a"], ["billing", "b.c"]], changed: [["common", "save"]], removed: [] },
      truncated: false,
    },
    fr: { added: 0, changed: 0, removed: 0, keys: { added: [], changed: [], removed: [] }, truncated: false },
  },
});

describe("parseSinceRevision", () => {
  it("accepts whole numbers only", () => {
    expect(parseSinceRevision("180")).toBe(180);
    expect(parseSinceRevision("0")).toBe(0);
    for (const bad of ["", "abc", "-1", "1.5", "1e3"]) expect(parseSinceRevision(bad)).toBeNull();
  });
});

describe("describeChangesSince", () => {
  it("one revision behind: a complete list per locale, unchanged locales left out", () => {
    const lines = describeChangesSince({ revision: 7 }, 6, changes(7));
    expect(lines[0]).toBe("Changes since revision 6 (now 7):");
    expect(lines).toContain("  de: +2 added, ~1 changed, -0 removed");
    expect(lines).toContain("      + billing:b.c");
    expect(lines).toContain("      ~ common:save");
    expect(lines.some((l) => l.includes("fr:"))).toBe(false);
  });

  it("further behind: says the list is only the last release", () => {
    const lines = describeChangesSince({ revision: 7 }, 3, changes(7));
    expect(lines[0]).toContain("4 ahead of 3");
    expect(lines[0]).toContain("only the last release");
  });

  it("already current: nothing changed", () => {
    expect(describeChangesSince({ revision: 7 }, 7, null)).toEqual(["Already at revision 7. Nothing changed since 7."]);
  });

  it("no change list (pruned): says so, does not invent one", () => {
    const lines = describeChangesSince({ revision: 7 }, 2, null);
    expect(lines[0]).toContain("not available");
  });

  it("a change list for another revision is not trusted", () => {
    expect(describeChangesSince({ revision: 7 }, 6, changes(5))[0]).toContain("not available");
  });

  it("a schema-1 manifest has no revisions", () => {
    expect(describeChangesSince({}, 1, null)[0]).toContain("no revisions");
  });

  it("restricts to the selected locales", () => {
    const lines = describeChangesSince({ revision: 7 }, 6, changes(7), ["fr"]);
    expect(lines).toContain("  No text changed in the selected locales.");
  });

  it("caps the key list and says how many more", () => {
    const many = changes(7);
    many.locales.de!.keys.added = Array.from({ length: 13 }, (_, i) => ["ns", `k${i}`] as [string, string]);
    many.locales.de!.truncated = true;
    const lines = describeChangesSince({ revision: 7 }, 6, many);
    expect(lines).toContain("      + ... 3 more");
    expect(lines.some((l) => l.includes("cut the key list"))).toBe(true);
  });
});
