// The benchmark: lefine vs next-intl vs Paraglide vs Lingui (and a no-i18n baseline) on the same Next 16 page,
// 3 languages x 200 keys (plurals and dates), rendered on every request. Rerun with:
//
//   node bench/run.mjs            (installs, builds, measures; writes bench/results/latest.json)
//   node bench/run.mjs --skip-build
//   node bench/run.mjs --label=after   (runs are kept per label; report.mjs compares the labels)
//
// What it measures, per app, on /de:
//   - client JS: every <script src> the page loads, each gzipped (level 9), summed
//   - page weight: the HTML document gzipped (it carries the RSC payload, where next-intl, Lingui and lefine put messages)
//   - cold render: the first request after `next start` is ready, median of 3 restarts: with Next's data cache
//     emptied (a fresh deploy; lefine fetches from the edge) and with it filled (a restart)
//   - warm render: median and p95 of 200 sequential requests after 20 warm-up ones (full body)
//   - output check: the rendered de text of a plural (k171) and a date (k191), so every app is known to be right
// The lefine app reads from bench/edge.mjs, delayed by the measured round trip to cdn.lefine.ai (see edgeRtt).
import { execSync, spawn } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
// BENCH_APPS=a,b measures some (an older lefine has no snapshot support, so its run leaves lefine-snapshot out).
const APPS = process.env.BENCH_APPS?.split(",") ?? ["baseline", "lefine", "lefine-snapshot", "next-intl", "paraglide", "lingui"];
const skipBuild = process.argv.includes("--skip-build");
/** Runs are kept per label (bench/results/runs/<label>/): report.mjs compares labels as before / after. */
const label = process.argv.find((a) => a.startsWith("--label="))?.slice("--label=".length) ?? "current";
const WARMUP = 20;
const RUNS = 200;

const sh = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: ["ignore", "pipe", "pipe"], encoding: "utf-8" });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const p95 = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * 0.95)];
const gz = (buf) => gzipSync(buf, { level: 9 }).length;

/** Round trips to the real edge from this machine: the first (new TLS connection) and the median of 20 after it. */
async function edgeRtt() {
  const url = "https://cdn.lefine.ai/flags/4x3/de.svg";
  const times = [];
  for (let i = 0; i < 21; i++) {
    const t = performance.now();
    const res = await fetch(url, { cache: "no-store" });
    await res.arrayBuffer();
    times.push(performance.now() - t);
  }
  return { url, first: Math.round(times[0]), warmMedian: Math.round(median(times.slice(1))) };
}

async function timed(url) {
  const t = performance.now();
  const res = await fetch(url, { cache: "no-store" });
  const body = await res.text();
  return { ms: performance.now() - t, status: res.status, body };
}

async function waitUp(url) {
  for (let i = 0; i < 300; i++) {
    try {
      await fetch(url, { method: "HEAD" });
      return;
    } catch {
      await sleep(100);
    }
  }
  throw new Error(`${url} never came up`);
}

const textOf = (html, id) => {
  // Every app renders <p> per key in order: k171 is the 171st <p> inside <main>.
  const main = html.slice(html.indexOf("<main>"));
  const ps = [...main.matchAll(/<p>(.*?)<\/p>/g)].map((m) => m[1].replace(/<!-- -->/g, ""));
  return ps[Number(id.slice(1)) - 1] ?? null;
};

const COLD_RUNS = 3;

/** One `next start`: optionally with Next's data cache emptied first, then the first request to /de. */
async function startOnce(app, port, emptyCache, then) {
  const cwd = join(here, "apps", app);
  if (emptyCache) rmSync(join(cwd, ".next", "cache", "fetch-cache"), { recursive: true, force: true });
  const server = spawn("npx", ["next", "start", "-p", String(port)], { cwd, env: { ...process.env, NODE_ENV: "production" }, stdio: "ignore" });
  try {
    // "Ready" without touching the page: the first page request below is the cold one.
    await waitUp(`http://localhost:${port}/_next/static/does-not-exist`);
    const url = `http://localhost:${port}/de`;
    const cold = await timed(url);
    if (cold.status !== 200) throw new Error(`${app}: /de answered ${cold.status}`);
    return { cold, extra: then ? await then(url, cold) : null };
  } finally {
    server.kill("SIGTERM");
    await sleep(500);
  }
}

async function measure(app, port) {
  // Cold, empty data cache: the first request after a deploy (lefine fetches from the edge here).
  const coldEmpty = [];
  let first = null;
  for (let i = 0; i < COLD_RUNS; i++) {
    const run = await startOnce(app, port, true, i === 0 ? async (url, cold) => {
      const scripts = [...cold.body.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]);
      let js = 0;
      for (const src of new Set(scripts)) js += gz(Buffer.from(await (await fetch(new URL(src, url))).arrayBuffer()));
      for (let w = 0; w < WARMUP; w++) await timed(url);
      const warm = [];
      for (let w = 0; w < RUNS; w++) warm.push((await timed(url)).ms);
      return { js, scripts: new Set(scripts).size, warm };
    } : null);
    coldEmpty.push(run.cold.ms);
    if (i === 0) first = run;
  }
  // Cold process, data cache filled: a restart of a server that has served before (lefine reads its cached files).
  const coldFilled = [];
  for (let i = 0; i < COLD_RUNS; i++) coldFilled.push((await startOnce(app, port, false, null)).cold.ms);
  const { js, scripts, warm } = first.extra;
  return {
    app,
    clientJsGzip: js,
    scripts,
    htmlGzip: gz(Buffer.from(first.cold.body)),
    coldEmptyCacheMs: Math.round(median(coldEmpty)),
    coldFilledCacheMs: Math.round(median(coldFilled)),
    warmMedianMs: Number(median(warm).toFixed(2)),
    warmP95Ms: Number(p95(warm).toFixed(2)),
    sample: { k001: textOf(first.cold.body, "k001"), k171: textOf(first.cold.body, "k171"), k191: textOf(first.cold.body, "k191") },
  };
}

function versions() {
  const of = (app, dep) => {
    try {
      return JSON.parse(readFileSync(join(here, "apps", app, "node_modules", dep, "package.json"), "utf-8")).version;
    } catch {
      return null;
    }
  };
  return {
    next: of("baseline", "next"),
    react: of("baseline", "react"),
    "next-intl": of("next-intl", "next-intl"),
    "@inlang/paraglide-js": of("paraglide", "@inlang/paraglide-js"),
    "@lingui/core": of("lingui", "@lingui/core"),
    lefine: `${of("lefine", "lefine")} (this repo, ${process.env.LEFINE_REF ?? sh("git rev-parse --short HEAD").trim()})`,
    node: process.version,
  };
}

function machine() {
  let osName = `${os.type()} ${os.release()}`;
  try {
    osName = `macOS ${sh("sw_vers -productVersion").trim()}`;
  } catch {
    // not macOS: os.type() and os.release() stay
  }
  return { cpu: os.cpus()[0]?.model, cores: os.cpus().length, memoryGb: Math.round(os.totalmem() / 2 ** 30), os: osName, arch: os.arch() };
}

// ── run ──
sh("node bench/gen.mjs");
// The edge runs from the start: the lefine-snapshot app reads it at build time (npx lefine strings snapshot).
const rtt = await edgeRtt();
console.log(`edge round trip: first ${rtt.first} ms, then ${rtt.warmMedian} ms`);
// A fixed delay, so runs on different days (or before / after a change) compare: the measured round trip moves
// between runs (21-40 ms seen here). BENCH_EDGE_DELAY_MS changes it.
const edgeDelay = Number(process.env.BENCH_EDGE_DELAY_MS ?? 25);
const edge = spawn("node", [join(here, "edge.mjs")], { env: { ...process.env, EDGE_DELAY_MS: String(edgeDelay) }, stdio: "ignore" });
await sleep(500);

if (!skipBuild) {
  mkdirSync(join(here, ".cache"), { recursive: true });
  // LEFINE_TARBALL: measure another build of lefine (an older commit, for a before / after); default: this repo's.
  if (process.env.LEFINE_TARBALL) copyFileSync(process.env.LEFINE_TARBALL, join(here, ".cache", "lefine-0.0.0.tgz"));
  else {
    sh("bun run build", join(root, "packages", "lefine"));
    sh(`bun pm pack --destination ${join(here, ".cache")}`, join(root, "packages", "lefine"));
  }
  for (const app of APPS) {
    console.log(`install + build ${app}`);
    sh("npm install --no-audit --no-fund", join(here, "apps", app));
    // A fresh tarball of lefine each run: npm keeps a file: dependency until asked again.
    if (app.startsWith("lefine")) sh("npm install --no-audit --no-fund ../../.cache/lefine-0.0.0.tgz", join(here, "apps", app));
    sh("npm run build", join(here, "apps", app));
  }
}

const results = [];
try {
  let port = 3301;
  for (const app of APPS) {
    console.log(`measure ${app}`);
    results.push(await measure(app, port++));
  }
} finally {
  edge.kill("SIGTERM");
}

const out = { label, ranAt: new Date().toISOString(), machine: machine(), versions: versions(), edgeRtt: rtt, edgeDelayMs: edgeDelay, method: { warmup: WARMUP, runs: RUNS, coldRuns: COLD_RUNS, page: "/de" }, results };
mkdirSync(join(here, "results"), { recursive: true });
writeFileSync(join(here, "results", "latest.json"), `${JSON.stringify(out, null, 2)}\n`);
// Every run is kept: bench/report.mjs shows the spread of the timings across runs (sizes do not move).
mkdirSync(join(here, "results", "runs", label), { recursive: true });
writeFileSync(join(here, "results", "runs", label, `${out.ranAt.replace(/[:.]/g, "-")}.json`), `${JSON.stringify(out, null, 2)}\n`);
console.table(results.map(({ sample: _sample, ...r }) => r));
console.log(results.map((r) => `${r.app}: ${JSON.stringify(r.sample)}`).join("\n"));
