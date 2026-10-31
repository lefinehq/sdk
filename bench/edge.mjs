// A Lefine edge for the bench, serving what a publish writes for one app: the schema-2 manifest, each language's
// versioned translations.json and its compiled messages.ir.json (same compiler as the publish). EDGE_DELAY_MS adds a
// round trip to every answer, so a cold render can be measured at the real edge's latency from this machine.
//
//   EDGE_DELAY_MS=40 node bench/edge.mjs      (port 8898)
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { compileMessages } from "../packages/lefine/dist/strings/compile.js";
import { IR_FORMAT } from "../packages/lefine/dist/strings/ir.js";

const here = dirname(fileURLToPath(import.meta.url));
const APP = "app_bench0000000000000000000000000001";
const VERSION = "mh3k2lc0-a1b2c3d4";
const LOCALES = ["en", "de", "tr"];
const delay = Number(process.env.EDGE_DELAY_MS ?? 0);
const sha = (s) => createHash("sha256").update(s).digest("hex");
const count = (v) => (v && typeof v === "object" ? Object.values(v).reduce((n, x) => n + count(x), 0) : 1);

const files = new Map();
const manifest = { schema: 2, revision: 1, languages: LOCALES.map((code, i) => ({ code, isSource: i === 0 })), files: {} };
for (const lc of LOCALES) {
  const body = readFileSync(join(here, "edge-data", `${lc}.json`), "utf-8");
  const tree = JSON.parse(body);
  manifest.files[lc] = { version: VERSION, sha256: sha(body), keyCount: count(tree), ir: true };
  files.set(`/${APP}/v/${VERSION}/${lc}/translations.json`, body);
  files.set(`/${APP}/v/${VERSION}/${lc}/messages.ir.json`, JSON.stringify({ format: IR_FORMAT, sha256: sha(body), messages: compileMessages(tree) }));
}
files.set(`/${APP}/manifest.json`, JSON.stringify(manifest));

let requests = 0;
createServer((req, res) => {
  requests++;
  const body = files.get(new URL(req.url, "http://x").pathname);
  setTimeout(() => {
    res.writeHead(body ? 200 : 404, { "content-type": "application/json", "cache-control": "public, max-age=60" });
    res.end(body ?? "{}");
  }, delay);
}).listen(8898, () => console.log(`bench edge on :8898, delay ${delay} ms`));
process.on("SIGTERM", () => {
  console.log(`requests: ${requests}`);
  process.exit(0);
});
