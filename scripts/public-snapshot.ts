// Builds the public SDK repo's tree from this repo's HEAD: `bun scripts/public-snapshot.ts <out-dir>`.
// Copies PUBLIC_PATHS (scripts/check-public.ts), leaves out DROPPED, takes the marketing site's scripts and CI job
// out of the root package.json and ci.yml, then runs the public gate on the result and fails if it finds anything.
// <out-dir> must be empty or hold only a .git folder. Committed files only: uncommitted edits are not copied.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { DROPPED, PUBLIC_PATHS, findPrivateRefs, loadDenyList } from "./check-public";

const ROOT = resolve(import.meta.dir, "..");
/** Root scripts that build or deploy what the snapshot leaves out. */
const DROPPED_SCRIPTS = ["landing:dev", "landing:build", "landing:deploy", "hydrogen-demo:deploy", "example:dev"];
/** CI jobs for what the snapshot leaves out. */
const DROPPED_JOBS = ["landing-i18n"];

function run(cmd: string, args: string[], cwd: string, input?: Buffer): Buffer {
  const r = spawnSync(cmd, args, { cwd, input, maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr?.toString()}`);
  return r.stdout;
}

/** The workflow without the named top-level jobs (a job runs from its `  name:` line to the next one). */
export function withoutJobs(yml: string, jobs: string[]): string {
  const lines = yml.split("\n");
  const out: string[] = [];
  let skipping = false;
  for (const line of lines) {
    const job = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (job) skipping = jobs.includes(job[1]!);
    else if (/^\S/.test(line)) skipping = false;
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === "node_modules") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else yield p;
  }
}

export function buildSnapshot(out: string): { files: number; findings: ReturnType<typeof findPrivateRefs> } {
  if (existsSync(out) && readdirSync(out).some((n) => n !== ".git")) throw new Error(`${out} is not empty`);
  mkdirSync(out, { recursive: true });
  run("tar", ["-x", "-C", out], ROOT, run("git", ["archive", "HEAD", "--", ...PUBLIC_PATHS], ROOT));
  for (const f of DROPPED) rmSync(join(out, f), { force: true });

  const pkgPath = join(out, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  for (const s of DROPPED_SCRIPTS) delete pkg.scripts?.[s];
  delete pkg.patchedDependencies; // the one patch is the marketing site's
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  const ciPath = join(out, ".github/workflows/ci.yml");
  if (existsSync(ciPath)) writeFileSync(ciPath, withoutJobs(readFileSync(ciPath, "utf8"), DROPPED_JOBS));

  // The private list of names must be there: a snapshot checked with the generic rule only is not checked.
  const denied = loadDenyList(ROOT);
  if (denied.size === 0) throw new Error("the private deny list is not loaded (PUBLIC_CHECK_DENY or internal/public-deny.txt)");
  const findings = [];
  let files = 0;
  for (const p of walk(out)) {
    files++;
    const file = relative(out, p);
    const buf = readFileSync(p);
    if (!buf.includes(0)) findings.push(...findPrivateRefs(file, buf.toString("utf8"), denied));
  }
  return { files, findings };
}

if (import.meta.main) {
  const out = process.argv[2];
  if (!out) {
    console.error("usage: bun scripts/public-snapshot.ts <out-dir>");
    process.exit(2);
  }
  const { files, findings } = buildSnapshot(resolve(out));
  for (const f of findings) console.log(`${f.file}:${f.line}  ${f.rule}  ${f.text}`);
  console.log(`${files} files in ${out}; ${findings.length} private reference(s).`);
  process.exit(findings.length ? 1 : 0);
}
