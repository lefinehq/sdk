// The public-repo gate: fails when a file in the public SDK paths points into Lefine's private side: a private repo,
// path or config name, an internal host or address, a Cloudflare account id, or a commit hash cited next to "lefine".
// Run in CI and before publish (`bun run check:public`), and by scripts/public-snapshot.ts on the snapshot it builds.
//
// The list of denied names is private: internal/public-deny.txt in Lefine's own repo, or the PUBLIC_CHECK_DENY
// secret in the public repo's CI (same format: <category><TAB><token> per line). It is not kept here, hashed or not:
// a hash of a short host, path or IPv4 address is reversed by trying candidates. Without the list the gate still
// runs its generic rule (commit hashes next to "lefine"); `--require-list` makes a missing list a failure.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

/** High-entropy ids only (128-bit), safe to keep as SHA-256: the account ids. Everything else is in the private list. */
export const DENIED_HASHES: ReadonlyMap<string, string> = new Map<string, string>([
  ["75827919237fe8f5a6284bcdf5043d878c3e6124278ae3ff6bb0ba5a46903a8f", "account id"],
  ["b765b22c6e0bc55588a71275e9bc06099f59434f70df866983c018342336594e", "account id"],
]);

const DENY_FILE = "internal/public-deny.txt";

/** The private list: PUBLIC_CHECK_DENY, else internal/public-deny.txt under `root`. Empty when neither exists. */
export function loadDenyList(root: string, env: Record<string, string | undefined> = process.env): Map<string, string> {
  const path = `${root}/${DENY_FILE}`;
  const text = env.PUBLIC_CHECK_DENY || (existsSync(path) ? readFileSync(path, "utf8") : "");
  const list = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const [category, token] = line.split("\t");
    if (category && token) list.set(token.trim(), category.trim());
  }
  return list;
}

/** The paths that make up the public SDK repo (scripts/public-snapshot.ts copies exactly these). */
export const PUBLIC_PATHS = [
  "packages", "github-action", "examples", "apps/docs", "bench", "skill", "tests", "scripts", ".changeset", ".github",
  ".gitignore", ".gitleaks.toml", ".npmrc", "CODEOWNERS", "README.md", "LICENSE", "package.json", "bun.lock",
  "tsconfig.json", "eslint.config.ts", "vitest.config.ts",
];
/** Files under PUBLIC_PATHS that the snapshot leaves out. */
export const DROPPED = ["apps/docs/.env", "packages/mcp/MANUAL_QA.md", ".github/workflows/deploy-landing.yml"];

export interface Finding { file: string; line: number; rule: string; text: string }

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function* tokens(text: string): Generator<string> {
  for (const m of text.matchAll(/[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+/g)) {
    const parts = m[0].split("/");
    for (let i = 0; i + 1 < parts.length; i++) yield `${parts[i]}/${parts[i + 1]}`;
  }
  for (const m of text.matchAll(/[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi)) {
    const labels = m[0].toLowerCase().split(".");
    for (let i = 0; i + 1 < labels.length; i++) yield labels.slice(i).join(".");
  }
  for (const m of text.matchAll(/\b[A-Z][A-Z0-9_]{3,}\b/g)) yield m[0];
  for (const m of text.matchAll(/\b[0-9a-f]{32}\b/g)) yield m[0];
}

// A short or full commit hash (7-40 hex, letters and digits) with "lefine" close by: a citation of a private commit.
// Not after @, - or / (a pinned upstream ref like actions/checkout@<sha>, or an id like v-a1b2c3d4).
const HEX = /(?<![@\-/])\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*[0-9])[0-9a-f]{7,40}\b/g;
const NEAR = 120;

export function findPrivateRefs(file: string, text: string, denied: ReadonlyMap<string, string> = new Map()): Finding[] {
  const found: Finding[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    const seen = new Set<string>();
    for (const t of tokens(line)) {
      const rule = denied.get(t) ?? DENIED_HASHES.get(sha(t));
      if (rule && !seen.has(rule)) {
        seen.add(rule);
        found.push({ file, line: i + 1, rule, text: line.trim().slice(0, 160) });
      }
    }
  });
  for (const m of text.matchAll(HEX)) {
    const at = m.index ?? 0;
    const around = text.slice(Math.max(0, at - NEAR), at + m[0].length + NEAR);
    if (!/lefine/i.test(around)) continue;
    const line = text.slice(0, at).split("\n").length;
    found.push({ file, line, rule: "commit hash next to lefine", text: (lines[line - 1] ?? "").trim().slice(0, 160) });
  }
  return found;
}

/** Tracked files of the public paths in `root`, minus the dropped ones. */
export function publicFiles(root: string): string[] {
  const r = spawnSync("git", ["ls-files", "-z", "--", ...PUBLIC_PATHS], { cwd: root, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ls-files failed in ${root}: ${r.stderr}`);
  return r.stdout.split("\0").filter((f) => f && !DROPPED.includes(f));
}

export function checkPublic(root: string, denied: ReadonlyMap<string, string> = loadDenyList(root)): Finding[] {
  const found: Finding[] = [];
  for (const file of publicFiles(root)) {
    const buf = readFileSync(`${root}/${file}`);
    if (buf.includes(0)) continue; // binary
    found.push(...findPrivateRefs(file, buf.toString("utf8"), denied));
  }
  return found;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const root = args.find((a) => !a.startsWith("--")) ?? process.cwd();
  const denied = loadDenyList(root);
  if (denied.size === 0) {
    const msg = `check:public: the private deny list is not loaded (PUBLIC_CHECK_DENY or ${DENY_FILE}).`;
    if (args.includes("--require-list")) {
      console.error(`${msg} Refusing: --require-list.`);
      process.exit(1);
    }
    console.log(`${msg} Running the generic rule only.`);
  }
  const found = checkPublic(root, denied);
  for (const f of found) console.log(`${f.file}:${f.line}  ${f.rule}  ${f.text}`);
  console.log(found.length ? `\n${found.length} private reference(s) in public files.` : `check:public: no private references (${denied.size} listed names).`);
  process.exit(found.length ? 1 : 0);
}
