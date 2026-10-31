import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

// audit #1: package.json's bin must be a real, self-contained CLI. Built into a temp folder next to a copy of
// package.json (the CLI reads its version from there), run with plain node.
it("the lefine bin builds and runs with no dependencies installed", () => {
  const root = fileURLToPath(new URL("../..", import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), "lefine-bin-"));
  try {
    cpSync(join(root, "package.json"), join(dir, "package.json"));
    execFileSync("bun", [join(root, "scripts/build-cli.ts"), join(dir, "dist")], { encoding: "utf-8" });
    const run = (...args: string[]) => execFileSync("node", [join(dir, "dist/cli.js"), ...args], { encoding: "utf-8", cwd: dir });
    expect(run("--version").trim()).toBe(JSON.parse(readFileSync(join(root, "package.json"), "utf-8")).version);
    const help = run("--help");
    for (const command of ["init", "login", "strings", "content", "migrate", "mcp"]) expect(help).toContain(command);
    expect(run("strings", "--help")).toContain("types");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 60_000);
