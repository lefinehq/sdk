// Writes the measured part of docs/benchmark.md (between the bench markers) from every run in bench/results/runs:
// sizes from the latest run (they do not move between runs), timings as the median of the runs with their range.
//
//   node bench/report.mjs
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const doc = join(here, "..", "docs", "benchmark.md");
// Runs are kept per label (bench/results/runs/<label>/), labels in name order: the last one is "now".
const dir = join(here, "results", "runs");
const labels = readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
const runsOf = (label) =>
  readdirSync(join(dir, label))
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, label, f), "utf-8")));
if (labels.length === 0) throw new Error("no runs: node bench/run.mjs first");
const runs = runsOf(labels[labels.length - 1]);
const last = runs[runs.length - 1];
const APPS = last.results.map((r) => r.app);
const kb = (b) => `${(b / 1024).toFixed(1)} KB`;
const delta = (b, base) => (b - base >= 0 ? `+${kb(b - base)}` : `−${kb(base - b)}`);
const med = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const timing = (app, key, from = runs) => {
  const xs = from.map((r) => r.results.find((x) => x.app === app)?.[key]).filter((x) => typeof x === "number");
  if (xs.length === 0) return "—";
  const m = med(xs);
  return xs.length > 1 ? `${m} (${Math.min(...xs)}–${Math.max(...xs)})` : `${m}`;
};
const base = last.results.find((r) => r.app === "baseline");

const lines = [
  `<!-- bench:start (written by node bench/report.mjs from ${runs.length} runs labelled ${labels[labels.length - 1]}; do not edit by hand) -->`,
  "",
  `Machine: ${last.machine.cpu}, ${last.machine.cores} cores, ${last.machine.memoryGb} GB, ${last.machine.os} (${last.machine.arch}). ${runs.length} runs, ${last.ranAt.slice(0, 10)}.`,
  "",
  `Versions: Next ${last.versions.next}, React ${last.versions.react}, next-intl ${last.versions["next-intl"]}, Paraglide JS ${last.versions["@inlang/paraglide-js"]}, Lingui ${last.versions["@lingui/core"]}, lefine ${last.versions.lefine}, Node ${last.versions.node}. All built with Turbopack (\`next build\`).`,
  "",
  `Edge round trip from this machine to cdn.lefine.ai: ${last.edgeRtt.first} ms on a new connection (TLS), ${last.edgeRtt.warmMedian} ms after (median of 20). The bench edge answers the lefine apps with a fixed ${last.edgeDelayMs ?? last.edgeRtt.warmMedian} ms delay, so runs compare; it does not add the TLS handshake.`,
  "",
  "### Size (what a visitor downloads for /de)",
  "",
  "| | Client JS, gzip | vs no i18n | HTML (with the RSC payload), gzip | vs no i18n | JS + HTML vs no i18n |",
  "|---|---|---|---|---|---|",
  ...APPS.map((app) => {
    const r = last.results.find((x) => x.app === app);
    return app === "baseline"
      ? `| no i18n (baseline) | ${kb(r.clientJsGzip)} | | ${kb(r.htmlGzip)} | | |`
      : `| ${app} | ${kb(r.clientJsGzip)} | ${delta(r.clientJsGzip, base.clientJsGzip)} | ${kb(r.htmlGzip)} | ${delta(r.htmlGzip, base.htmlGzip)} | **${delta(r.clientJsGzip + r.htmlGzip, base.clientJsGzip + base.htmlGzip)}** |`;
  }),
  "",
  "### Server render time (ms, median of the runs, range in brackets)",
  "",
  "| | First request after a deploy (empty data cache) | First request after a restart (data cache kept) | Warm, median of 200 | Warm, p95 |",
  "|---|---|---|---|---|",
  ...APPS.map((app) => `| ${app === "baseline" ? "no i18n (baseline)" : app} | ${timing(app, "coldEmptyCacheMs")} | ${timing(app, "coldFilledCacheMs")} | ${timing(app, "warmMedianMs")} | ${timing(app, "warmP95Ms")} |`),
  "",
  ...(labels.length > 1
    ? [
        "### lefine before and after (ms; median of each label's runs, range in brackets)",
        "",
        `| | ${labels.map((l) => `${l} (${runsOf(l)[0]?.versions.lefine.replace(/^.*\(this repo, (\w+)\)$/, "$1") ?? ""})`).join(" | ")} |`,
        `|---|${labels.map(() => "---").join("|")}|`,
        ...["coldEmptyCacheMs", "coldFilledCacheMs", "warmMedianMs", "warmP95Ms"].flatMap((key) =>
          ["lefine", "lefine-snapshot"].map((app) => `| ${app}: ${{ coldEmptyCacheMs: "first request after a deploy", coldFilledCacheMs: "after a restart", warmMedianMs: "warm median", warmP95Ms: "warm p95" }[key]} | ${labels.map((l) => timing(app, key, runsOf(l))).join(" | ")} |`),
        ),
        "",
      ]
    : []),
  "### Output check (de, from the rendered HTML)",
  "",
  "| | k171 (plural, count 3) | k191 (date, `{d, date, medium}`) |",
  "|---|---|---|",
  ...last.results.filter((r) => r.app !== "baseline").map((r) => `| ${r.app} | ${r.sample.k171} | ${r.sample.k191} |`),
  "",
  "<!-- bench:end -->",
];

const text = readFileSync(doc, "utf-8");
const start = text.indexOf("<!-- bench:start");
const end = text.indexOf("<!-- bench:end -->");
if (start < 0 || end < 0) throw new Error("docs/benchmark.md has no bench markers");
writeFileSync(doc, text.slice(0, start) + lines.join("\n") + text.slice(end + "<!-- bench:end -->".length));
console.log(`docs/benchmark.md: ${runs.length} runs`);
