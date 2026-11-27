import { describe, expect, it } from "vitest";
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
});
