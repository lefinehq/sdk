// scripts/check-public.ts: the gate that keeps private references out of the public SDK repo. The real list of denied
// names is private (internal/public-deny.txt, or the PUBLIC_CHECK_DENY secret); these tests pass a list of their own.
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DENIED_HASHES, checkPublic, findPrivateRefs, loadDenyList } from "../../scripts/check-public";

// Samples are built here, so this file does not cite a hash or id itself (the gate reads it too).
const ID = Array.from({ length: 32 }, (_, i) => (i % 16).toString(16)).join("");
const denied = loadDenyList("/nowhere", {
  PUBLIC_CHECK_DENY: [
    "# a comment",
    "private path\tacme/secret",
    "internal host\tintra.example.dev",
    "internal address\t10.1.2.3",
    "private config\tACME_SIGNING_KEY",
    `account id\t${ID}`,
  ].join("\n"),
});
const H1 = ["3f9a", "2c1d"].join("");
const H2 = ["9e4c", "2bbb"].join("");
const rules = (text: string) => findPrivateRefs("f", text, denied).map((f) => f.rule);

describe("check:public", () => {
  it("finds a denied path pair anywhere in a longer path or URL", () => {
    expect(rules("see acme/secret/src/x.ts")).toEqual(["private path"]);
    expect(rules("https://github.com/acme/secret/blob/main/a.md")).toEqual(["private path"]);
    expect(rules("acme/secretive and other/acme")).toEqual([]);
  });

  it("finds a denied host as itself or under a subdomain, an address, a name and an id", () => {
    expect(rules("https://intra.example.dev/x")).toEqual(["internal host"]);
    expect(rules("api.intra.example.dev")).toEqual(["internal host"]);
    expect(rules("ssh root@10.1.2.3")).toEqual(["internal address"]);
    expect(rules("export ACME_SIGNING_KEY=")).toEqual(["private config"]);
    expect(rules(`account_id = ${ID}`)).toEqual(["account id"]);
  });

  it("finds a commit hash cited next to lefine, not a pinned upstream ref or an id", () => {
    expect(rules(`fixed in lefine (${H1})`)).toEqual(["commit hash next to lefine"]);
    expect(rules(`// lefine: see\n// the review of ${H2}`)).toEqual(["commit hash next to lefine"]);
    expect(rules("lefine uses actions/checkout@34e114876b0b11c390a56381ad16ebd13914f8d5")).toEqual([]);
    expect(rules('lefine const V1 = "mh3k2lc0-a1b2c3d4"')).toEqual([]);
    expect(rules("lefine 12345678 and deadbeefcafe-free text")).toEqual([]);
    expect(rules(`a hash ${H1} far from the package name`)).toEqual([]);
  });

  it("reads the list as <category><TAB><token> lines, and is empty without one", () => {
    expect(denied.size).toBe(5);
    expect(denied.get("acme/secret")).toBe("private path");
    expect(loadDenyList("/nowhere", {}).size).toBe(0);
  });

  it("keeps only high-entropy ids in this file, as hashes: a short name's hash would be reversed by guessing", () => {
    expect(DENIED_HASHES.size).toBeGreaterThan(0);
    for (const [key, rule] of DENIED_HASHES) {
      expect(key).toMatch(/^[0-9a-f]{64}$/);
      expect(rule).toBe("account id");
    }
  });

  it("the public paths of this repo hold no private reference", () => {
    expect(checkPublic(resolve(__dirname, "../.."))).toEqual([]);
  });
});
