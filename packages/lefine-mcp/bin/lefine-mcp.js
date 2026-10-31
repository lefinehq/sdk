#!/usr/bin/env node
// @lefine/mcp is `lefine mcp` now. This name keeps working for configs that already say `npx -y @lefine/mcp`.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const manifest = createRequire(import.meta.url).resolve("lefine/package.json");
const { bin } = JSON.parse(readFileSync(manifest, "utf-8"));
process.argv.splice(2, 0, "mcp");
await import(pathToFileURL(join(dirname(manifest), bin.lefine)).href);
