#!/usr/bin/env node
// `npx @lefine/mcp` is the friendly front door to Lefine's MCP server.
//   In a terminal, no arguments: the setup wizard (same code as `npx lefine setup`).
//   `setup`, `--remove`, `--list`, `--doctor`, `--print`: the same as `lefine setup ...`.
//   Started by an AI app (stdin is not a terminal): the stdio server, as before. Existing configs that say
//   `npx -y @lefine/mcp` keep working.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { metaOutput } from "./meta.js";
import { routeArgs } from "./route.js";

const own = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8"));
const meta = metaOutput(process.argv.slice(2), own.version);
if (meta !== null) {
  process.stdout.write(meta);
  process.exit(0);
}

const manifest = createRequire(import.meta.url).resolve("lefine/package.json");
const { bin } = JSON.parse(readFileSync(manifest, "utf-8"));
const args = process.argv.slice(2);
process.argv.splice(2, args.length, ...routeArgs(args, { stdinIsTTY: process.stdin.isTTY === true, stdoutIsTTY: process.stdout.isTTY === true }));
await import(pathToFileURL(join(dirname(manifest), bin.lefine)).href);
