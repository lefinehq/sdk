import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * DX walk 2026-10-29: `lefine strings types` (0.1.0) writes `declare module "lefine/strings" { ... }` with no import of
 * lefine/strings. A Next app imports only lefine/next and lefine/react, so that module was not in the program, the
 * augmentation did nothing and every key compiled. The entries now take their types through lefine/strings.
 */
const SRC = resolve(__dirname, "../..");
const OLD_GENERATED = [
  "export type LefineMessages = { nav: { home: string; pricing: string } };",
  "export type LefineArgs = {};",
  'declare module "lefine/strings" {',
  "  interface StringsConfig { Messages: LefineMessages; Args: LefineArgs }",
  "}",
].join("\n");

function check(entry: "lefine/react" | "lefine/server", use: string[]): string[] {
  const dir = mkdtempSync(join(tmpdir(), "lefine-augment-"));
  try {
    writeFileSync(join(dir, "lefine-strings.d.ts"), OLD_GENERATED);
    const head = entry === "lefine/react" ? 'import { useStrings } from "lefine/react";' : 'import { createStrings } from "lefine/server";';
    writeFileSync(join(dir, "use.ts"), [head, ...use, "export {};"].join("\n"));
    const program = ts.createProgram([join(dir, "use.ts"), join(dir, "lefine-strings.d.ts")], {
      strict: true,
      noEmit: true,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
      target: ts.ScriptTarget.ES2022,
      lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
      jsx: ts.JsxEmit.ReactJSX,
      skipLibCheck: true,
      types: [],
      paths: {
        "lefine/strings": [join(SRC, "strings/index.ts")],
        "lefine/react": [join(SRC, "react/index.tsx")],
        "lefine/server": [join(SRC, "server/index.ts")],
      },
    });
    return ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file?.fileName.endsWith("use.ts"))
      .map((d) => ts.flattenDiagnosticMessageText(d.messageText, "\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("typed keys reach every entry, with no import of lefine/strings in the app", () => {
  it("useStrings (lefine/react): known keys compile, an unknown key or namespace does not", () => {
    expect(check("lefine/react", ['const t = useStrings("nav");', 't("home");'])).toEqual([]);
    expect(check("lefine/react", ['const t = useStrings("nav");', 't("nope");'])).not.toEqual([]);
    expect(check("lefine/react", ['useStrings("nope");'])).not.toEqual([]);
  }, 60_000);

  it("getStrings (lefine/server, and lefine/next through it)", () => {
    const s = 'const s = createStrings({ project: "app_x" });';
    expect(check("lefine/server", [s, 'async function f() { const t = await s.getStrings("en", "nav"); t("pricing"); }'])).toEqual([]);
    expect(check("lefine/server", [s, 'async function f() { const t = await s.getStrings("en", "nav"); t("nope"); }'])).not.toEqual([]);
  }, 60_000);
});
