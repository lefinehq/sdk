import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { HELP, metaOutput } from "../bin/meta.js";
import { routeArgs } from "../bin/route.js";

const tty = { stdinIsTTY: true, stdoutIsTTY: true };
const client = { stdinIsTTY: false, stdoutIsTTY: false };

describe("npx @lefine/mcp routing", () => {
  it("started by an AI app (stdin is a pipe): the stdio server, as before", () => {
    expect(routeArgs([], client)).toEqual(["mcp"]);
  });
  it("a person in a terminal with no arguments: the setup wizard", () => {
    expect(routeArgs([], tty)).toEqual(["setup"]);
  });
  it("stdin a terminal but stdout piped (npx @lefine/mcp | cat): not the wizard", () => {
    expect(routeArgs([], { stdinIsTTY: true, stdoutIsTTY: false })).toEqual(["mcp"]);
  });
  it("setup and its flags mirror `lefine setup`, in a terminal or not", () => {
    expect(routeArgs(["setup", "--yes"], client)).toEqual(["setup", "--yes"]);
    expect(routeArgs(["--remove"], client)).toEqual(["setup", "--remove"]);
    expect(routeArgs(["--list"], tty)).toEqual(["setup", "--list"]);
    expect(routeArgs(["--doctor"], tty)).toEqual(["setup", "--doctor"]);
    expect(routeArgs(["--client=cursor"], tty)).toEqual(["setup", "--client=cursor"]);
  });
  it("an explicit `mcp` stays the server", () => {
    expect(routeArgs(["mcp"], tty)).toEqual(["mcp"]);
  });
  it("other arguments (--version, --help) keep going to the server as before", () => {
    expect(routeArgs(["--version"], tty)).toEqual(["mcp", "--version"]);
  });
  it("the server's own flags go to the server, in a terminal or not", () => {
    expect(routeArgs(["--read-only"], client)).toEqual(["mcp", "--read-only"]);
    expect(routeArgs(["--toolsets=content,strings"], client)).toEqual(["mcp", "--toolsets=content,strings"]);
    expect(routeArgs(["--allow-dir", "/tmp/x"], tty)).toEqual(["mcp", "--allow-dir", "/tmp/x"]);
    expect(routeArgs(["--tools-ttl", "0"], tty)).toEqual(["mcp", "--tools-ttl", "0"]);
  });
  it("--readonly (one word) is the setup flag, --read-only (two words) is the server flag", () => {
    expect(routeArgs(["--readonly"], client)).toEqual(["setup", "--readonly"]);
  });
});

describe("npx @lefine/mcp --version and --help", () => {
  const own = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string };
  const bin = new URL("../bin/lefine-mcp.js", import.meta.url).pathname;

  it("--version is this package's version, not lefine's", () => {
    expect(metaOutput(["--version"], "1.2.3")).toBe("1.2.3\n");
    expect(execFileSync("node", [bin, "--version"], { encoding: "utf-8" })).toBe(`${own.version}\n`);
  });
  it("--help names lefine-mcp and lists the server flags", () => {
    const out = execFileSync("node", [bin, "--help"], { encoding: "utf-8" });
    expect(out).toBe(HELP);
    expect(out).not.toContain("Usage: lefine mcp");
    for (const flag of ["--read-only", "--toolsets", "--allow-dir", "--tools-ttl", "LEFINE_TOKEN"]) expect(out).toContain(flag);
  });
  it("only as the first argument: `setup --help` still goes to lefine setup", () => {
    expect(metaOutput(["setup", "--help"], "1.0.0")).toBeNull();
    expect(metaOutput([], "1.0.0")).toBeNull();
  });
});
