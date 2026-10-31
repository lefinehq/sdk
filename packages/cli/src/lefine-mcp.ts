#!/usr/bin/env node
/**
 * `lefine-mcp`: Lefine's MCP server for clients that start a local process (Claude Desktop, IDE configs).
 * It bridges stdio to https://dash.lefine.ai/v1/mcp with your key. Clients that speak remote MCP can
 * use that URL directly instead.
 *
 * Key: LEFINE_TOKEN, else the one `lefine login` saved. No project env files are read, on purpose: a
 * cloned project must not be able to redirect the key (same rule as the `lefine` CLI).
 */

import { readFileSync } from "node:fs";
import { resolveLefineAuth } from "./lefine/credentials.js";
import { runBridge } from "./lefine/mcp-bridge.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf-8")) as { version: string };

const args = process.argv.slice(2);
if (args.includes("--version")) {
  process.stdout.write(`${pkg.version}\n`);
  process.exit(0);
}
if (args.includes("--help")) {
  process.stderr.write(
    [
      "lefine-mcp: Lefine as a local MCP server (stdio).",
      "",
      "Sign in once:   npx lefine login      (or set LEFINE_TOKEN)",
      'Claude Desktop: { "mcpServers": { "lefine": { "command": "npx", "args": ["-y", "@lefine/mcp"] } } }',
      "Remote clients can skip this and use https://dash.lefine.ai/v1/mcp with the header Authorization: Bearer <key>.",
      "",
    ].join("\n"),
  );
  process.exit(0);
}

let auth: { token: string; apiUrl: string } | null = null;
try {
  const found = resolveLefineAuth({});
  auth = found ? { token: found.token, apiUrl: found.apiUrl } : null;
} catch (error) {
  process.stderr.write(`lefine-mcp: ${error instanceof Error ? error.message : String(error)}\n`);
}
if (!auth) process.stderr.write("lefine-mcp: not signed in. Run `npx lefine login` or set LEFINE_TOKEN.\n");

await runBridge(process.stdin, {
  auth,
  fetch,
  write: (line) => process.stdout.write(`${line}\n`),
  log: (line) => process.stderr.write(`${line}\n`),
  clientVersion: pkg.version,
});
