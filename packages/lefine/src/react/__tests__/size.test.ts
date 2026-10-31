import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { expect, it } from "vitest";

// What a Client Component pays for lefine/react (useStrings, StringsProvider, the formatter), React not counted.
// No Next import: it must work in any React app. Fails at 2.5 KB.
it("lefine/react stays under 2.5 KB gzip", () => {
  const dir = mkdtempSync(join(tmpdir(), "lefine-react-size-"));
  try {
    const entry = join(dir, "entry.ts");
    writeFileSync(entry, `import { useStrings, StringsProvider } from ${JSON.stringify(fileURLToPath(new URL("../index.tsx", import.meta.url)))};\nglobalThis.x = [useStrings, StringsProvider];\n`);
    const external = ["react", "react/jsx-runtime"].flatMap((m) => ["--external", m]);
    // As a production build sees it: the dev-only warnings (strings/dev.ts) are dropped.
    const define = ["--define", 'process.env.NODE_ENV="production"'];
    const code = execFileSync("bun", ["build", entry, "--minify", "--target=browser", "--format=esm", ...external, ...define], { encoding: "utf-8" });
    expect(code).not.toContain("lefine strings push");
    // The dev overlay is not in a production build at all: no marks, no layer, no badge code.
    for (const devOnly of ["\u2063", "data-lefine-dev", "MutationObserver", "this text has a problem", "data-lefine-toast", "updated in Lefine"]) expect(code, devOnly).not.toContain(devOnly);
    // ...and it is there in development, so the check above means something.
    const dev = execFileSync("bun", ["build", entry, "--minify", "--target=browser", "--format=esm", ...external, "--define", 'process.env.NODE_ENV="development"'], { encoding: "utf-8" });
    expect(dev).toContain("data-lefine-dev");
    expect(dev).toContain("data-lefine-toast");
    expect(code).not.toContain("parseMessage");
    expect(code).not.toMatch(/from\s*"next/);
    const size = gzipSync(code, { level: 9 }).length;
    console.log(`lefine/react: ${size} B gzip`);
    expect(size).toBeLessThan(2560);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
