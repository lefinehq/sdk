import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PathError, allowedRoots, isInside, mediaTypeOf, readInside, resolveInside, sniffMatches } from "../mcp-paths.js";

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);

let base: string;
let project: string;
let outside: string;
let roots: string[];

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "lefine-paths-")));
  project = join(base, "project");
  outside = join(base, "outside");
  mkdirSync(join(project, "public"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(project, "public", "hero.png"), PNG);
  writeFileSync(join(outside, "secret.png"), PNG);
  roots = allowedRoots(project);
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

const code = (fn: () => unknown): string | undefined => {
  try {
    fn();
  } catch (e) {
    return e instanceof PathError ? e.code : `other:${String(e)}`;
  }
  return undefined;
};

describe("path guards", () => {
  test("a file inside the project resolves, relative or absolute", () => {
    expect(resolveInside("public/hero.png", roots, project)).toBe(join(project, "public", "hero.png"));
    expect(resolveInside(join(project, "public", "hero.png"), roots, project)).toBe(join(project, "public", "hero.png"));
  });
  test("../ out of the project is refused", () => {
    expect(code(() => resolveInside("../outside/secret.png", roots, project))).toBe("OUTSIDE");
    expect(code(() => resolveInside("public/../../outside/secret.png", roots, project))).toBe("OUTSIDE");
  });
  test("an absolute path outside is refused", () => {
    expect(code(() => resolveInside(join(outside, "secret.png"), roots, project))).toBe("OUTSIDE");
    expect(code(() => resolveInside("/etc/hosts", roots, project))).toBe("OUTSIDE");
  });
  test("a sibling that only shares the name prefix is outside (/a/b vs /a/bc)", () => {
    mkdirSync(join(base, "project-evil"));
    writeFileSync(join(base, "project-evil", "x.png"), PNG);
    expect(isInside(project, join(base, "project-evil"))).toBe(false);
    expect(code(() => resolveInside("../project-evil/x.png", roots, project))).toBe("OUTSIDE");
  });
  test("a symlink inside the project that leads outside is refused, for a file and for a folder", () => {
    symlinkSync(join(outside, "secret.png"), join(project, "public", "link.png"));
    symlinkSync(outside, join(project, "linked-dir"));
    expect(code(() => resolveInside("public/link.png", roots, project))).toBe("SYMLINK");
    expect(code(() => resolveInside("linked-dir/secret.png", roots, project))).toBe("SYMLINK");
    expect(code(() => readInside("public/link.png", roots, project, 1000))).toBe("SYMLINK");
  });
  test("a symlink that stays inside the project is fine", () => {
    symlinkSync(join(project, "public", "hero.png"), join(project, "alias.png"));
    expect(readInside("alias.png", roots, project, 1000).bytes.length).toBe(PNG.length);
  });
  test("--allow-dir opens one more folder, and only that one", () => {
    const more = allowedRoots(project, [outside]);
    expect(resolveInside(join(outside, "secret.png"), more, project)).toBe(join(outside, "secret.png"));
    expect(code(() => resolveInside("/etc/hosts", more, project))).toBe("OUTSIDE");
    expect(code(() => allowedRoots(project, [join(base, "nope")]))).toBe("NOT_FOUND");
  });
  test("a missing file, an empty path and a NUL byte", () => {
    expect(code(() => resolveInside("public/none.png", roots, project))).toBe("NOT_FOUND");
    expect(code(() => resolveInside("", roots, project))).toBe("BAD_PATH");
    expect(code(() => resolveInside("public/hero.png\0.txt", roots, project))).toBe("BAD_PATH");
  });
  test("folders that hold keys are never read, even inside the project", () => {
    mkdirSync(join(project, ".lefine"));
    writeFileSync(join(project, ".lefine", "credentials.json"), "{}");
    writeFileSync(join(project, ".env"), "KEY=1");
    mkdirSync(join(project, ".ssh"));
    writeFileSync(join(project, ".ssh", "id_rsa"), "x");
    for (const p of [".lefine/credentials.json", ".env", ".ssh/id_rsa"]) expect(code(() => resolveInside(p, roots, project))).toBe("DENIED");
  });
  test("a file over the limit is refused before it is read; a folder is not a file", () => {
    writeFileSync(join(project, "big.png"), Buffer.alloc(2048));
    expect(code(() => readInside("big.png", roots, project, 1024))).toBe("TOO_BIG");
    expect(code(() => readInside("public", roots, project, 1024))).toBe("NOT_FILE");
    expect(readInside("public/hero.png", roots, project, 1024).bytes.equals(PNG)).toBe(true);
  });
});

describe("types", () => {
  test("the type comes from the name; unknown names have none", () => {
    expect(mediaTypeOf("a.PNG")).toBe("image/png");
    expect(mediaTypeOf("a.jpeg")).toBe("image/jpeg");
    expect(mediaTypeOf("movie.mp4")).toBe("video/mp4");
    expect(mediaTypeOf("a.pdf")).toBe("application/pdf");
    for (const n of ["notes.txt", ".env", "script.js", "a.exe", "noext", "archive.zip"]) expect(mediaTypeOf(n)).toBeNull();
  });
  test("the first bytes must agree with the name", () => {
    expect(sniffMatches("image/png", PNG)).toBe(true);
    expect(sniffMatches("image/png", Buffer.from("API_KEY=secret\n"))).toBe(false);
    expect(sniffMatches("image/jpeg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0]))).toBe(true);
    expect(sniffMatches("application/pdf", Buffer.from("%PDF-1.7\n"))).toBe(true);
    expect(sniffMatches("application/pdf", PNG)).toBe(false);
    expect(sniffMatches("image/svg+xml", Buffer.from('<?xml version="1.0"?><svg xmlns="x"></svg>'))).toBe(false); // svg is refused by the server, so not sent
    expect(sniffMatches("video/mp4", Buffer.concat([Buffer.alloc(4), Buffer.from("ftypisom")]))).toBe(true);
    expect(sniffMatches("text/plain", Buffer.from("x"))).toBe(false);
  });
});
