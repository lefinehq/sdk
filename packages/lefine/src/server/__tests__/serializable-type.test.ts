import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// TanStack Start checks a server function's result type (ValidateSerializable in @tanstack/router-core). On the IR's
// old variadic tag tuple, `[string, typeof TAG, ...Node[]]`, that check recursed until TypeScript stopped with TS2589
// ("Type instantiation is excessively deep") in a fresh `npx lefine init` app (2026-10-28, the npm publish dry run).
// This runs tsc on the init template's server function, with the TanStack Start the landing app installs.
const repo = fileURLToPath(new URL("../../../../../", import.meta.url));
const start = join(repo, "apps/landing/node_modules/@tanstack/react-start");
const tsc = join(repo, "packages/lefine/node_modules/.bin/tsc");

describe("lefine/server through TanStack Start's serializable check", () => {
  it.skipIf(!existsSync(start))("strings().load() in createServerFn type-checks (no TS2589)", () => {
    const dir = mkdtempSync(join(tmpdir(), "lefine-tss-types-"));
    try {
      const server = fileURLToPath(new URL("../index.js", import.meta.url));
      writeFileSync(
        join(dir, "check.ts"),
        `import { createServerFn } from "@tanstack/react-start";
import { createStrings } from ${JSON.stringify(server)};
const strings = createStrings({ project: "app_3f9c0e4b2a7d4e1f9b6c5a8d7e2f1a0b" });
export const loadStrings = createServerFn({ method: "GET" })
  .validator((locale: string) => locale)
  .handler(({ data }) => strings.load(data, ["home"]));
`,
      );
      writeFileSync(
        join(dir, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { strict: true, noEmit: true, skipLibCheck: true, target: "ES2022", module: "ESNext", moduleResolution: "Bundler", lib: ["ES2022", "DOM"], jsx: "react-jsx", types: ["node"], typeRoots: [join(repo, "packages/lefine/node_modules/@types"), join(repo, "node_modules/@types")], paths: { "@tanstack/react-start": [start] } },
          files: ["check.ts"],
        }),
      );
      let out = "";
      try {
        execFileSync(tsc, ["-p", join(dir, "tsconfig.json")], { encoding: "utf-8" });
      } catch (err) {
        out = String((err as { stdout?: string }).stdout || err);
      }
      expect(out).toBe("");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
