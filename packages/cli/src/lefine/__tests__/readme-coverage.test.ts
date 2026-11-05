import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Every command registered in lefine.ts must be named in the @lefine/cli README (SURFACE_GAPS 2026-11-05 rank 6).
const root = join(import.meta.dir, "../../../..");
const source = readFileSync(join(root, "cli/src/lefine.ts"), "utf8");
const readme = readFileSync(join(root, "lefine-cli/README.md"), "utf8");

/** Full command paths, e.g. "strings keys list", "ci trust add", "init". */
function registeredCommands(): string[] {
  const vars: Record<string, string> = { program: "" };
  const out: string[] = [];
  const re = /(?:const\s+(\w+)\s*=\s*)?(?:projectOptions\(\s*|contentOptions\(\s*)?(\w+)\s*\.command\("([^" ]+)/g;
  for (const m of source.matchAll(re)) {
    const [, assigned, parent, name] = m;
    if (!(parent in vars)) continue;
    const path = [vars[parent], name].filter(Boolean).join(" ");
    if (assigned) vars[assigned] = path;
    else out.push(path);
  }
  return out;
}

describe("lefine-cli README", () => {
  const commands = registeredCommands();

  test("finds the registered commands", () => {
    expect(commands.length).toBeGreaterThanOrEqual(30);
    expect(commands).toContain("init");
    expect(commands).toContain("ci trust add");
    expect(commands).toContain("content push");
  });

  test("names every registered command", () => {
    const missing = commands.filter((c) => !readme.includes(`lefine ${c}`));
    expect(missing).toEqual([]);
  });

  test("starts from lefine init", () => {
    expect(readme.indexOf("lefine init")).toBeLessThan(readme.indexOf("## Strings"));
  });
});
