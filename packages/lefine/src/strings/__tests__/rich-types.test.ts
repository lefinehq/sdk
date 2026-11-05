import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * DX clean-room 2026-11-05: the README's `t.rich("terms", { a: (chunks) => <a>{chunks}</a> })` failed `tsc` in strict
 * mode with TS7006 (chunks implicitly any); `(chunks: ReactNode)` failed with TS2322. The handler's parameter was
 * not contextually typed because the values type was a union of handlers and plain values. These compile the README
 * form for useStrings and getStrings, with and without the types `lefine strings types` writes.
 */
const SRC = resolve(__dirname, "../..");
const TYPES = resolve(SRC, "../node_modules/@types/react");

const GENERATED = [
  "export type LefineMessages = { nav: { home: string; terms: string; count: string } };",
  'export type LefineArgs = { "nav.count": { n: number } };',
  'declare module "lefine/strings" {',
  "  interface StringsConfig { Messages: LefineMessages; Args: LefineArgs }",
  "}",
].join("\n");

function check(entry: "react" | "server", body: string[], typed: boolean): string[] {
  const dir = mkdtempSync(join(tmpdir(), "lefine-rich-"));
  try {
    const files = [join(dir, "use.tsx")];
    if (typed) {
      writeFileSync(join(dir, "lefine-strings.d.ts"), GENERATED);
      files.push(join(dir, "lefine-strings.d.ts"));
    }
    const head =
      entry === "react"
        ? 'import { useStrings } from "lefine/react";\nfunction C() { const t = useStrings(' + (typed ? '"nav"' : "") + ");"
        : 'import { createStrings } from "lefine/server";\nconst s = createStrings({ project: "app_x" });\nasync function C() { const t = await s.getStrings("en"' + (typed ? ', "nav"' : "") + ");";
    writeFileSync(join(dir, "use.tsx"), [head, ...body, "}", "export { C };"].join("\n"));
    const program = ts.createProgram(files, {
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
        react: [TYPES],
        "react/jsx-runtime": [join(TYPES, "jsx-runtime")],
      },
    });
    return ts
      .getPreEmitDiagnostics(program)
      .filter((d) => d.file?.fileName.endsWith("use.tsx"))
      .map((d) => `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const README_FORM = ['  return t.rich(typed ? "terms" : "terms", { a: (chunks) => <a href="/terms">{chunks}</a> });'];
const body = (typed: boolean) => [`  return t.rich("terms", { a: (chunks) => <a href="/terms">{chunks}</a>, b: (c) => <b>{c}</b> });`];

describe("t.rich handlers are typed from the call", () => {
  for (const entry of ["react", "server"] as const) {
    for (const typed of [false, true]) {
      const label = `${entry}, ${typed ? "typed messages" : "untyped"}`;
      it(`${label}: (chunks) => <a>{chunks}</a> compiles in strict mode`, () => {
        expect(check(entry, body(typed), typed)).toEqual([]);
      }, 60_000);
    }
  }

  it("a handler can mix with plain values, and a key with arguments still needs them", () => {
    const mixed = ['  return t.rich("count", { n: 3, b: (chunks) => <b>{chunks}</b> });'];
    expect(check("react", mixed, true)).toEqual([]);
    expect(check("react", ['  return t.rich("count", { b: (chunks) => <b>{chunks}</b> });'], true)).not.toEqual([]);
  }, 60_000);

  it("chunks is an array a handler can render, and strings stay valid", () => {
    expect(check("react", ['  return t.rich("terms", { a: (chunks) => <a>{chunks.length}{chunks.map((c) => String(c))}</a> });'], true)).toEqual([]);
    expect(check("react", ['  return t.rich("terms", { a: "plain" });'], true)).toEqual([]);
  }, 60_000);

  it("the result is a ReactNode, so it renders", () => {
    const lines = ['  const out: import("react").ReactNode = t.rich("terms", { a: (chunks) => <a>{chunks}</a> });', "  return out;"];
    expect(check("react", lines, true)).toEqual([]);
  }, 60_000);

  it("still rejects an unknown key and a value that is not a handler or plain value", () => {
    expect(check("react", ['  return t.rich("nope", { a: (c) => <a>{c}</a> });'], true)).not.toEqual([]);
    expect(check("react", ['  return t.rich("terms", { a: {} });'], true)).not.toEqual([]);
  }, 60_000);
});
void README_FORM;
