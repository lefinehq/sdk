#!/usr/bin/env bun
/**
 * Publishes every package whose version is not on npm yet, and tags only what npm really has.
 *
 * Replaces `bun publish ... || true; changeset tag`, which tagged packages npm never got (2026-08-09:
 * seven tags, one package on npm) because `bun publish` exits 0 on a failed publish. Here:
 *
 *   1. Order: a package after the workspace packages it depends on (core before next).
 *   2. `dist/` must have the files package.json points at (an empty dist/ once shipped silently).
 *   3. `bun pm pack` writes the tarball, so `workspace:` ranges become real versions; a tarball that
 *      still says `workspace:` is refused (use-intl 0.10.1 went out like that).
 *      The ranges must also equal each workspace package's current version (a stale bun.lock packs an old one).
 *   4. `npm publish <tarball>`: in GitHub Actions npm signs in through trusted publishing (OIDC,
 *      no token) and adds provenance when the repo is public. Locally it uses your npm login.
 *   5. A package is tagged and printed as `New tag: name@version` only after `npm view name@version`
 *      returns it, and npm's `dist.integrity` is the sha512 of the tarball we packed.
 *   6. With `--out <dir>` the tarballs stay there, with `SHA256SUMS` and `release.json` (name, version,
 *      sha256, integrity, result). The Release workflow uploads that folder as an artifact, so the
 *      digest of what went to npm is on record. Without `--out` a temp folder is used and removed.
 *
 * Only Lefine packages (`lefine`, `@lefine/*`) are considered. The @better-i18n/* packages live in this
 * monorepo too but are released separately; pass --include-better to release them from here.
 *
 * Usage: bun scripts/release.ts [--dry-run] [--include-better] [--out <dir>]. Exits 1 if any package failed; the rest still go out.
 */
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO = fileURLToPath(new URL("..", import.meta.url));
const DRY = process.argv.includes("--dry-run");
const INCLUDE_BETTER = process.argv.includes("--include-better");
const OUT_ARG = process.argv.indexOf("--out");
const OUT = OUT_ARG > 0 ? process.argv[OUT_ARG + 1] : undefined;

interface Pkg {
  dir: string;
  name: string;
  version: string;
  private?: boolean;
  main?: string;
  types?: string;
  exports?: unknown;
  bin?: string | Record<string, string>;
  dependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
}

export function readPackages(root: string, all = false): Pkg[] {
  const dir = join(root, "packages");
  return readdirSync(dir)
    .filter((d) => existsSync(join(dir, d, "package.json")))
    .map((d) => ({ dir: join(dir, d), ...JSON.parse(readFileSync(join(dir, d, "package.json"), "utf-8")) }) as Pkg)
    .filter((p) => all || !p.private);
}

/** Packages this script releases by default: the unscoped `lefine` and everything under `@lefine/`. */
export const LEFINE_PACKAGE = /^(lefine|@lefine\/.+)$/;

export function isLefine(p: Pick<Pkg, "name">): boolean {
  return LEFINE_PACKAGE.test(p.name);
}

/** Dependencies on a private workspace package: npm would ship a package nobody can install. */
export function privateDeps(p: Pkg, everything: Pkg[]): string[] {
  const hidden = new Set(everything.filter((x) => x.private).map((x) => x.name));
  return Object.keys({ ...p.dependencies, ...p.peerDependencies }).filter((d) => hidden.has(d));
}

/**
 * Dependencies that failed earlier in this run. A package that needs a version npm does not have cannot be
 * installed, so it waits: 2026-11-28 @lefine/mcp 1.0.0-rc.2 went out needing lefine ^0.11.1, whose publish had
 * just failed, and `npx @lefine/mcp@next` stopped installing.
 */
export function failedDeps(p: Pkg, failedNames: Set<string>): string[] {
  return Object.keys({ ...p.dependencies, ...p.peerDependencies }).filter((d) => failedNames.has(d));
}

/** Dependencies first. Only edges inside the list count; a cycle keeps the remaining order. */
export function publishOrder(pkgs: Pkg[]): Pkg[] {
  const names = new Set(pkgs.map((p) => p.name));
  const done = new Set<string>();
  const out: Pkg[] = [];
  const visit = (p: Pkg, path: Set<string>) => {
    if (done.has(p.name) || path.has(p.name)) return;
    path.add(p.name);
    for (const dep of Object.keys({ ...p.dependencies, ...p.peerDependencies })) {
      const d = names.has(dep) ? pkgs.find((x) => x.name === dep) : undefined;
      if (d) visit(d, path);
    }
    done.add(p.name);
    out.push(p);
  };
  for (const p of [...pkgs].sort((a, b) => a.name.localeCompare(b.name))) visit(p, new Set());
  return out;
}

/**
 * Dependencies the source declares as `workspace:` whose range in the packed manifest is not the workspace
 * package's current version. `bun pm pack` takes the version from bun.lock, so a stale lockfile ships an old
 * range (@lefine/mcp rc.0 went out asking for lefine ^0.10.0 while the repo was at 0.11.0).
 */
export function staleWorkspaceRanges(source: Pkg, packedManifest: string, everything: Pkg[]): string[] {
  type Fields = Record<"dependencies" | "peerDependencies" | "optionalDependencies", Record<string, string> | undefined>;
  const packed = JSON.parse(packedManifest) as Fields;
  const declared = source as unknown as Fields;
  const bad: string[] = [];
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
    for (const [name, range] of Object.entries(declared[field] ?? {})) {
      if (!range.startsWith("workspace:")) continue;
      const target = everything.find((x) => x.name === name);
      if (!target) continue;
      const got = packed[field]?.[name];
      const ok = [target.version, `^${target.version}`, `~${target.version}`];
      if (got === undefined || !ok.includes(got)) bad.push(`${name} ${got ?? "(missing)"} (workspace is ${target.version})`);
    }
  }
  return bad;
}

/** Files package.json promises (main, types, bin, every string under exports). */
export function promisedFiles(p: Pkg): string[] {
  const files = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === "string" && v.startsWith("./") && !v.includes("*") && !v.endsWith("package.json")) files.add(v);
    else if (v && typeof v === "object") for (const x of Object.values(v)) add(x);
  };
  add(p.main && `./${p.main.replace(/^\.\//, "")}`);
  add(p.types && `./${p.types.replace(/^\.\//, "")}`);
  add(p.exports);
  // A bin that is not built (lefine's dist/cli.js) would install a command that does not exist.
  for (const bin of typeof p.bin === "string" ? [p.bin] : Object.values(p.bin ?? {})) add(`./${bin.replace(/^\.\//, "")}`);
  return [...files];
}

/** sha256 (hex, for SHA256SUMS) and integrity (sha512, the format of npm's `dist.integrity`) of a tarball. */
export function digests(file: string): { sha256: string; integrity: string } {
  const bytes = readFileSync(file);
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
  };
}

export interface Packed {
  name: string;
  version: string;
  tarball: string;
  sha256: string;
  integrity: string;
  result: "published" | "dry-run" | "failed";
}

/** A prerelease (1.0.0-rc.0) goes to the `next` tag: npm refuses one without --tag, and `latest` must stay what `npx` installs. */
export function distTag(version: string): string[] {
  return version.includes("-") ? ["--tag", "next"] : [];
}

/** The `sha256sum -c` format: `<hex>  <file>`. */
export function sha256sums(packed: Packed[]): string {
  return packed.map((p) => `${p.sha256}  ${p.tarball}\n`).join("");
}

function npmIntegrity(name: string, version: string): string {
  const r = spawnSync("npm", ["view", `${name}@${version}`, "dist.integrity", "--prefer-online"], { encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

function onNpm(name: string, version: string): boolean {
  const r = spawnSync("npm", ["view", `${name}@${version}`, "version", "--prefer-online"], { encoding: "utf-8" });
  return r.status === 0 && r.stdout.trim() === version;
}

/** npm can take a few minutes before a new version shows in `npm view`. */
async function waitOnNpm(name: string, version: string, tries = 18): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    if (onNpm(name, version)) return true;
    await new Promise((r) => setTimeout(r, 10_000));
  }
  return false;
}

async function main(): Promise<void> {
  const failed: string[] = [];
  const failedNames = new Set<string>();
  const records: Packed[] = [];
  const out = OUT ? resolve(OUT) : mkdtempSync(join(tmpdir(), "release-"));
  mkdirSync(out, { recursive: true });
  const everything = readPackages(REPO, true);
  const candidates = readPackages(REPO).filter((p) => INCLUDE_BETTER || isLefine(p));
  const ignored = readPackages(REPO).length - candidates.length;
  if (ignored > 0) console.log(`ignored  ${ignored} non-Lefine package(s) (pass --include-better to release them)`);
  for (const p of publishOrder(candidates)) {
    const id = `${p.name}@${p.version}`;
    if (onNpm(p.name, p.version)) {
      console.log(`skip     ${id} (on npm)`);
      continue;
    }
    const blocked = failedDeps(p, failedNames);
    if (blocked.length > 0) {
      console.log(`FAILED   ${id}: waits for ${blocked.join(", ")}, which did not publish in this run`);
      failed.push(id);
      failedNames.add(p.name);
      continue;
    }
    const hidden = privateDeps(p, everything);
    if (hidden.length > 0) {
      console.log(`FAILED   ${id}: depends on ${hidden.join(", ")}, which is private (not on npm yet). Publish that first.`);
      failed.push(id);
      failedNames.add(p.name);
      continue;
    }
    const missing = promisedFiles(p).filter((f) => !existsSync(join(p.dir, f)));
    if (missing.length > 0) {
      console.log(`FAILED   ${id}: not built, missing ${missing.join(", ")}`);
      failed.push(id);
      failedNames.add(p.name);
      continue;
    }
    // --quiet prints only the tarball's file name.
    const packed = execFileSync("bun", ["pm", "pack", "--destination", out, "--quiet"], { cwd: p.dir, encoding: "utf-8" }).trim().split("\n").pop()!;
    const tarball = join(out, basename(packed));
    const manifest = execFileSync("tar", ["-xOzf", tarball, "package/package.json"], { encoding: "utf-8" });
    if (manifest.includes('"workspace:')) {
      console.log(`FAILED   ${id}: the tarball still has a workspace: range (run bun install so the lockfile knows the versions)`);
      failed.push(id);
      failedNames.add(p.name);
      continue;
    }
    const stale = staleWorkspaceRanges(p, manifest, everything);
    if (stale.length > 0) {
      console.log(`FAILED   ${id}: the tarball's dependency ranges are out of date: ${stale.join("; ")}. Run bun install so bun.lock knows the current versions, then release again.`);
      failed.push(id);
      failedNames.add(p.name);
      continue;
    }
    const record: Packed = { name: p.name, version: p.version, tarball: basename(tarball), ...digests(tarball), result: "failed" };
    records.push(record);
    console.log(`packed   ${id} sha256:${record.sha256}`);
    const publish = spawnSync("npm", ["publish", tarball, "--access", "public", ...distTag(p.version), ...(DRY ? ["--dry-run"] : [])], { stdio: "inherit" });
    if (DRY) {
      console.log(publish.status === 0 ? `dry-run  ${id}` : `FAILED   ${id} (dry run)`);
      if (publish.status === 0) record.result = "dry-run";
      else {
        failed.push(id);
        failedNames.add(p.name);
      }
      failedNames.add(p.name);
      continue;
    }
    // A failed exit can still mean "already there" when a retry races npm's processing: npm decides.
    if (!(await waitOnNpm(p.name, p.version, publish.status === 0 ? 18 : 3))) {
      console.log(`FAILED   ${id}: npm publish exited ${publish.status} and npm does not have it`);
      failed.push(id);
      failedNames.add(p.name);
      continue;
    }
    // npm has this version, but is it our tarball? A raced or earlier publish of the same version is not.
    const remote = npmIntegrity(p.name, p.version);
    if (remote !== record.integrity) {
      console.log(`FAILED   ${id}: npm has it, but its integrity ${remote || "(none)"} is not our tarball's ${record.integrity}`);
      failed.push(id);
      failedNames.add(p.name);
      continue;
    }
    record.result = "published";
    spawnSync("git", ["tag", id], { cwd: REPO, stdio: "ignore" });
    console.log(`New tag: ${id}`);
  }
  if (OUT) {
    writeFileSync(join(out, "SHA256SUMS"), sha256sums(records));
    writeFileSync(join(out, "release.json"), `${JSON.stringify(records, null, 2)}\n`);
    console.log(`\nTarballs, SHA256SUMS and release.json are in ${out}`);
  } else rmSync(out, { recursive: true, force: true });
  if (failed.length > 0) {
    console.log(`\n${failed.length} not published: ${failed.join(", ")}. Run the release again; what is on npm is skipped.`);
    process.exit(1);
  }
}

// Run only as a script, not when a test imports the helpers.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) await main();
