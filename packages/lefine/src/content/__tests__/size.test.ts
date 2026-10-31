import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";

/**
 * What an app pays for each entry: minified with bun, gzip level 9. The limits sit about 25% above the size on
 * 2026-10-26 (index 3878 B), so a real jump fails here before it ships.
 */
const LIMITS = { index: 5 * 1024 } as const;

function gzipSize(entry: keyof typeof LIMITS): number {
  const dir = mkdtempSync(join(tmpdir(), "lefine-content-size-"));
  try {
    // Import everything and keep it: bundling the entry itself lets the bundler drop it (sideEffects: false).
    const file = join(dir, "entry.ts");
    writeFileSync(file, `import * as m from ${JSON.stringify(fileURLToPath(new URL(`../${entry}.ts`, import.meta.url)))};\nglobalThis.m = m;\n`);
    const code = execFileSync("bun", ["build", file, "--minify", "--target=browser", "--format=esm"], { encoding: "utf-8" });
    expect(code.length).toBeGreaterThan(1000);
    return gzipSync(code, { level: 9 }).length;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("bundle size", () => {
  for (const entry of Object.keys(LIMITS) as Array<keyof typeof LIMITS>) {
    it(`lefine/content${entry === "index" ? "" : `/${entry}`} stays under ${LIMITS[entry]} B gzip`, () => {
      const size = gzipSize(entry);
      console.log(`lefine/content ${entry}: ${size} B gzip`);
      expect(size).toBeLessThan(LIMITS[entry]);
    });
  }
});
