import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { digests, privateDeps, promisedFiles, publishOrder, readPackages, sha256sums } from "../../scripts/release.ts";

const REPO = resolve(__dirname, "../..");

describe("scripts/release.ts", () => {
  it("publishes a package after the workspace packages it depends on", () => {
    const order = publishOrder(readPackages(REPO)).map((p) => p.name);
    for (const dependent of ["@better-i18n/next", "@better-i18n/use-intl", "@better-i18n/expo", "@better-i18n/remix", "@better-i18n/server", "@better-i18n/vite"]) {
      expect(order.indexOf("@better-i18n/core"), dependent).toBeLessThan(order.indexOf(dependent));
    }
  });

  it("refuses a package that depends on a private one", () => {
    const all = readPackages(REPO, true).map((p) => (p.name === "lefine" ? { ...p, private: true } : p));
    const mcp = all.find((p) => p.name === "@lefine/mcp")!;
    expect(privateDeps(mcp, all)).toEqual(["lefine"]);
  });

  it("lefine is public (on npm since 0.1.0, 2026-10-29), goes before @lefine/mcp, which depends on it, and its bin is checked", () => {
    const all = readPackages(REPO, true);
    expect(all.find((p) => p.name === "lefine")?.private).toBeFalsy();
    expect(privateDeps(all.find((p) => p.name === "@lefine/mcp")!, all)).toEqual([]);
    const order = publishOrder(readPackages(REPO)).map((p) => p.name);
    expect(order.indexOf("lefine")).toBeLessThan(order.indexOf("@lefine/mcp"));
    const lefine = all.find((p) => p.name === "lefine")!;
    expect(promisedFiles(lefine)).toContain("./dist/cli.js");
    expect(promisedFiles(all.find((p) => p.name === "@lefine/mcp")!)).toContain("./bin/lefine-mcp.js");
  });

  it("checks every file package.json points at", () => {
    expect(
      promisedFiles({
        dir: "",
        name: "x",
        version: "1.0.0",
        main: "dist/index.js",
        types: "./dist/index.d.ts",
        exports: { ".": { types: "./dist/index.d.ts", default: "./dist/index.js" }, "./next": "./dist/next.js", "./package.json": "./package.json", "./*": "./dist/*.js" },
      }).sort(),
    ).toEqual(["./dist/index.d.ts", "./dist/index.js", "./dist/next.js"]);
  });

  it("records the tarball's sha256 and the sha512 integrity npm reports as dist.integrity", () => {
    const file = join(mkdtempSync(join(tmpdir(), "release-test-")), "x-1.0.0.tgz");
    writeFileSync(file, "tarball bytes");
    const d = digests(file);
    expect(d.sha256).toBe(createHash("sha256").update("tarball bytes").digest("hex"));
    expect(d.integrity).toBe(`sha512-${createHash("sha512").update("tarball bytes").digest("base64")}`);
    expect(sha256sums([{ name: "x", version: "1.0.0", tarball: "x-1.0.0.tgz", ...d, result: "published" }])).toBe(`${d.sha256}  x-1.0.0.tgz\n`);
  });

  it("every published package names this repo, as npm trusted publishing requires", () => {
    for (const p of readPackages(REPO)) {
      const repo = (p as { repository?: { url?: string } }).repository;
      expect(repo?.url, p.name).toBe("git+https://github.com/lefinehq/sdk.git");
    }
  });
});

describe(".github/workflows/publish.yml", () => {
  const yml = readFileSync(resolve(REPO, ".github/workflows/publish.yml"), "utf-8");

  const job = (name: string) => yml.split(/\n {2}(?=[a-z-]+:\n)/).find((s) => s.startsWith(`${name}:`)) ?? "";

  it("publishes through OIDC, with no npm token", () => {
    expect(yml).not.toMatch(/secrets\.NPM_TOKEN|NODE_AUTH_TOKEN|_authToken/);
    expect(job("publish")).toContain("id-token: write");
    expect(job("publish")).toContain("run: bun scripts/release.ts --out release-artifacts");
  });

  it("a push to main only opens the Version Packages PR; publishing runs only from workflow_dispatch on main", () => {
    const version = job("version");
    expect(version).toContain("github.event_name == 'push'");
    expect(version).toContain("changesets/action@");
    expect(version).not.toMatch(/^\s+publish:|id-token|release\.ts|npm publish/m);
    const publish = job("publish");
    expect(publish).toContain("github.event_name == 'workflow_dispatch' && github.ref == 'refs/heads/main'");
  });

  it("uploads the tarballs and their digests as an artifact, even when a package failed", () => {
    const publish = job("publish");
    expect(publish).toMatch(/uses: actions\/upload-artifact@[0-9a-f]{40}/);
    expect(publish).toContain("path: release-artifacts/");
  });

  it("pins an npm that can do trusted publishing (>= 11.5.1)", () => {
    const [, major, minor] = /npm@(\d+)\.(\d+)\.\d+/.exec(yml) ?? [];
    expect(Number(major) > 11 || (Number(major) === 11 && Number(minor) >= 5)).toBe(true);
  });
});

describe(".github/workflows/ci.yml package-check", () => {
  const yml = readFileSync(resolve(REPO, ".github/workflows/ci.yml"), "utf-8");
  const matrix = /package: \[([^\]]*)\]/.exec(yml)?.[1].split(",").map((s) => s.trim()) ?? [];

  it("checks every published Lefine package, and each has a check:package script", () => {
    const lefine = readPackages(REPO).filter((p) => p.name === "lefine" || p.name.startsWith("@lefine/"));
    expect(lefine.length).toBeGreaterThan(0);
    for (const p of lefine) {
      const folder = p.dir.split(/[\\/]/).pop()!;
      expect(matrix, p.name).toContain(folder);
      expect((p as { scripts?: Record<string, string> }).scripts?.["check:package"], p.name).toBeTruthy();
    }
  });
});
