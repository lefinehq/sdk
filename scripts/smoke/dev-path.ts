#!/usr/bin/env bun
/**
 * The developer path, end to end, the way a new customer walks it (README.md next to this file):
 *
 *   1. a fresh Next.js app (create-next-app)        5. read the text back from the CDN with lefine/server
 *   2. lefine installed (this repo's build, or npm)  6. lefine strings types, then tsc: a known key compiles and an
 *   3. npx lefine init --app <id>                       unknown one is a type error
 *   4. strings push, then publish (a person approves, or SMOKE_APPROVE_CMD does it on the local stack)
 *
 * Exit 0 only when every step passed. Nothing here prints a key. The temp app is deleted unless a step failed or
 * --keep is given.
 */

import { spawn, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dir, "../..");
const env = process.env;
const API = (env.LEFINE_API_URL ?? "https://dash.lefine.ai").replace(/\/+$/, "");
const CDN = (env.LEFINE_CDN_URL ?? (API.includes("localhost") ? `${API}/cdn` : "https://cdn.lefine.ai")).replace(/\/+$/, "");
const APP = env.LEFINE_SMOKE_APP ?? "";
const PACKAGE = env.LEFINE_SMOKE_PACKAGE ?? "local";
const KEEP = process.argv.includes("--keep");
/** --example nextjs|vite-react|expo: run oss/examples/<name> instead of a fresh create-next-app. */
const EXAMPLE = (() => {
  const i = process.argv.indexOf("--example");
  return i < 0 ? null : (process.argv[i + 1] ?? "");
})();
const EXAMPLES = ["nextjs", "vite-react", "expo"];
/** --offline (with --example): no Lefine at all, for CI: install the example with this repo's lefine, typecheck, build. */
const OFFLINE = process.argv.includes("--offline");
const RUN = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`;
const TEXT = `Smoke run ${RUN}`;

if (OFFLINE && !EXAMPLE) fatal("--offline needs --example <name>.");
if (!OFFLINE && !/^app_[a-z0-9]{3,64}$/.test(APP)) fatal("Set LEFINE_SMOKE_APP to the app id (app_...) the smoke run may publish to.");
if (EXAMPLE !== null && !EXAMPLES.includes(EXAMPLE)) fatal(`--example takes ${EXAMPLES.join(", ")}.`);
if (!OFFLINE && !env.LEFINE_TOKEN) fatal("Set LEFINE_TOKEN to a key with publish access to that app (Settings, API keys).");

const work = mkdtempSync(join(tmpdir(), "lefine-smoke-"));
const app = join(work, EXAMPLE ? `example-${EXAMPLE}` : "smoke-app");
const results: Array<{ step: string; ok: boolean; ms: number; note: string }> = [];
// The CLI and npm see the stack; the key goes through the environment only, never an argument.
const childEnv = { ...env, LEFINE_API_URL: API, LEFINE_CDN_URL: CDN, LEFINE_NO_BROWSER: "1", NO_COLOR: "1", CI: "1" };

function fatal(message: string): never {
  console.error(`smoke: ${message}`);
  process.exit(2);
}

function sh(command: string, args: string[], cwd: string, timeoutMs = 300_000): { status: number; out: string } {
  const r = spawnSync(command, args, { cwd, env: childEnv, encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status ?? 1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

async function step(name: string, run: () => Promise<string> | string): Promise<void> {
  const start = Date.now();
  process.stdout.write(`• ${name} ... `);
  try {
    const note = await run();
    results.push({ step: name, ok: true, ms: Date.now() - start, note });
    console.log(`ok (${((Date.now() - start) / 1000).toFixed(1)} s)${note ? `  ${note}` : ""}`);
  } catch (err) {
    const note = err instanceof Error ? err.message : String(err);
    results.push({ step: name, ok: false, ms: Date.now() - start, note });
    console.log("FAILED");
    console.log(note.split("\n").slice(-25).map((l) => `    ${l}`).join("\n"));
    finish(1);
  }
}

function must(r: { status: number; out: string }, what: string): string {
  if (r.status !== 0) throw new Error(`${what} exited ${r.status}\n${r.out}`);
  return r.out;
}

function finish(code: number): never {
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} steps passed. API ${API}, CDN ${CDN}, app ${APP}, run ${RUN}.`);
  if (code === 0 && !KEEP) rmSync(work, { recursive: true, force: true });
  else console.log(`The app is kept at ${app}`);
  process.exit(code);
}

/** Runs the publish and answers its approval with SMOKE_APPROVE_CMD (local), or waits for a person (prod). */
function publish(extra: string[] = []): Promise<string> {
  return new Promise((done, fail) => {
    const child = spawn("npx", ["lefine", "strings", "publish", "--yes", ...extra], { cwd: app, env: childEnv });
    let out = "";
    let approved = false;
    const onData = (chunk: Buffer) => {
      out += chunk.toString();
      const id = /\/approvals\/(apr_[a-f0-9]+)/.exec(out)?.[1];
      if (id && !approved) {
        approved = true;
        if (env.SMOKE_APPROVE_CMD) {
          const r = spawnSync("sh", ["-c", env.SMOKE_APPROVE_CMD], { env: { ...childEnv, LEFINE_APPROVAL_ID: id }, encoding: "utf8", timeout: 60_000 });
          out += `\n[approve] ${(r.stdout ?? "").trim()} ${(r.stderr ?? "").trim()}`;
        } else {
          // The CLI opens no browser here (LEFINE_NO_BROWSER=1): the person opens the link.
          console.log(`\n    A person approves the publish: ${/https?:\/\/\S+\/approvals\/apr_[a-f0-9]+/.exec(out)?.[0]}`);
        }
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);
    child.on("close", (code) => (code === 0 ? done(out) : fail(new Error(`publish exited ${code}\n${out}`))));
  });
}

console.log(`Lefine developer-path smoke run ${RUN}${EXAMPLE ? ` (example ${EXAMPLE})` : ""}\n  API ${API}\n  CDN ${CDN}\n  app ${APP}\n  lefine from ${PACKAGE}\n`);

let tarball = "";
await step("lefine package", () => {
  if (PACKAGE === "npm") return "lefine@latest from npm";
  if (PACKAGE !== "local") {
    if (!existsSync(PACKAGE)) throw new Error(`LEFINE_SMOKE_PACKAGE: no file ${PACKAGE}`);
    tarball = resolve(PACKAGE);
    return tarball;
  }
  // This repo's packages/lefine, built and packed as npm would publish it.
  must(sh("bun", ["run", "build"], join(REPO, "packages/lefine")), "build packages/lefine");
  must(sh("npm", ["pack", "--pack-destination", work], join(REPO, "packages/lefine")), "npm pack");
  const name = readdirSync(work).find((f) => /^lefine-.*\.tgz$/.test(f));
  if (!name) throw new Error("npm pack wrote no tarball");
  tarball = join(work, name);
  return name;
});

if (EXAMPLE) {
  await runExample(EXAMPLE);
  finish(0);

/** The env each example reads its app id and edge from (README.md of each example). */
function exampleEnv(name: string): Record<string, string> {
  const prefix = name === "nextjs" ? "LEFINE_" : name === "vite-react" ? "VITE_LEFINE_" : "EXPO_PUBLIC_LEFINE_";
  return { [`${prefix}APP`]: APP, [`${prefix}CDN`]: CDN };
}

/** Reads one text back through the example's own installed lefine/server, the way the app reads it. */
async function readBack(locale: string, key: string, expected: string): Promise<string> {
  writeFileSync(
    join(app, "smoke-read.mjs"),
    `import { createStrings } from "lefine/server";
const s = createStrings({ project: ${JSON.stringify(APP)}, cdn: ${JSON.stringify(CDN)} });
const props = await s.load(${JSON.stringify(locale)}, ["example"]);
console.log(JSON.stringify(props.messages?.example?.[${JSON.stringify(key)}] ?? null));`,
  );
  const deadline = Date.now() + 90_000;
  for (;;) {
    const seen = must(sh("node", ["smoke-read.mjs"], app, 60_000), "lefine/server read").trim();
    if (seen === JSON.stringify(expected)) return `${locale} example.${key} = ${seen}`;
    if (Date.now() > deadline) throw new Error(`the CDN serves ${seen}, expected ${JSON.stringify(expected)}`);
    await new Promise((r) => setTimeout(r, 5_000));
  }
}

async function runExample(name: string): Promise<void> {
  const source = join(REPO, "examples", name);
  const de = JSON.parse(readFileSync(join(source, "locales", "de.json"), "utf8")).example as Record<string, string>;
  Object.assign(childEnv, exampleEnv(name));

  await step(`copy examples/${name}, install`, () => {
    cpSync(source, app, { recursive: true, filter: (p) => !/[\\/](node_modules|\.next|dist|\.expo)([\\/]|$)/.test(p) });
    // Local: the example's own "lefine" range points at this repo's tarball before the one install (the range may name
    // a version npm does not have yet). npm: the range as committed, the way a reader of the README installs it.
    if (tarball) {
      const pkgPath = join(app, "package.json");
      const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
      pkg.dependencies.lefine = `file:${tarball}`;
      writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
    }
    // --ignore-scripts: no dependency's install script runs here or in CI (this repo's .npmrc policy).
    must(sh("npm", ["install", "--no-audit", "--no-fund", "--ignore-scripts"], app, 900_000), "npm install");
    return tarball ? "lefine from this repo" : "lefine from npm, as the example names it";
  });

  if (OFFLINE) {
    await step(name === "nextjs" ? "tsc --noEmit" : name === "vite-react" ? "tsc -b && vite build" : "tsc, expo export (Hermes bytecode)", () => {
      if (name === "nextjs") must(sh("npx", ["tsc", "--noEmit"], app, 300_000), "tsc");
      else if (name === "vite-react") must(sh("npm", ["run", "build"], app, 600_000), "npm run build");
      else {
        must(sh("npx", ["tsc", "--noEmit"], app, 300_000), "tsc");
        must(sh("npx", ["expo", "export", "--platform", "android", "--output-dir", "dist"], app, 900_000), "expo export");
      }
      return "offline: no Lefine, types and build only";
    });
    return;
  }

  await step("strings push --all locales", () => {
    const out = must(sh("npx", ["lefine", "strings", "push", "--all", "locales", "--yes", "--project", APP], app), "strings push --all");
    return (out.match(/Pushed [^\n]*|Nothing to push[^\n]*/g) ?? []).join("; ");
  });

  await step("strings publish (with approval)", async () => {
    const out = await publish(["--project", APP]);
    if (/Nothing to publish/.test(out)) return "nothing new: already live";
    if (!/Published/.test(out) || /failed/i.test(out)) throw new Error(`publish did not finish cleanly\n${out}`);
    return /Published[^\n]*/.exec(out)?.[0] ?? "";
  });

  await step("read from the CDN (lefine/server)", () => readBack("de", "title", de.title!));

  if (name === "nextjs") {
    await step("next build, next start, GET /de", async () => {
      must(sh("npx", ["next", "build"], app, 900_000), "next build");
      const port = String(3100 + Math.floor(Math.random() * 800));
      const server = spawn("npx", ["next", "start", "-p", port], { cwd: app, env: childEnv });
      try {
        const deadline = Date.now() + 60_000;
        for (;;) {
          try {
            const html = await (await fetch(`http://localhost:${port}/de`)).text();
            if (html.includes(de.title!)) return `/de shows "${de.title}"`;
            if (Date.now() > deadline) throw new Error(`/de does not show "${de.title}"\n${html.slice(0, 400)}`);
          } catch (err) {
            if (Date.now() > deadline) throw err;
          }
          await new Promise((r) => setTimeout(r, 1_000));
        }
      } finally {
        server.kill();
      }
    });
  } else if (name === "vite-react") {
    await step("tsc -b && vite build", () => {
      must(sh("npm", ["run", "build"], app, 600_000), "npm run build");
      return "dist/ built";
    });
  } else {
    await step("tsc, expo export (Hermes bytecode)", () => {
      must(sh("npx", ["tsc", "--noEmit"], app, 300_000), "tsc");
      must(sh("npx", ["expo", "export", "--platform", "android", "--output-dir", "dist"], app, 900_000), "expo export");
      const hbc = readdirSync(join(app, "dist", "_expo", "static", "js", "android")).find((f) => f.endsWith(".hbc"));
      if (!hbc) throw new Error("expo export wrote no Hermes bundle");
      return hbc;
    });
  }
}
}

await step("create-next-app", () => {
  must(
    sh("npx", ["--yes", "create-next-app@latest", "smoke-app", "--ts", "--app", "--no-eslint", "--no-tailwind", "--no-src-dir", "--import-alias", "@/*", "--use-npm", "--yes", "--skip-install", "--disable-git"], work, 600_000),
    "create-next-app",
  );
  must(sh("npm", ["install", "--no-audit", "--no-fund"], app, 600_000), "npm install");
  must(sh("npm", ["install", "--no-audit", "--no-fund", tarball || "lefine@latest"], app, 600_000), "npm install lefine");
  const next = JSON.parse(sh("node", ["-p", "JSON.stringify(require('next/package.json').version)"], app).out.trim() || '""');
  return `next ${next}`;
});

await step("npx lefine init", () => {
  const out = must(sh("npx", ["lefine", "init", "--app", APP, "--no-install"], app), "lefine init");
  for (const file of ["lefine.ts", "proxy.ts", "app/[locale]/layout.tsx", "app/[locale]/page.tsx"]) {
    if (!existsSync(join(app, file))) throw new Error(`init did not write ${file}\n${out}`);
  }
  return "lefine.ts, proxy.ts, app/[locale]/ written";
});

await step("strings push", () => {
  // One fixed key whose text changes every run, so runs do not pile up keys.
  writeFileSync(join(app, "smoke-source.json"), JSON.stringify({ smoke: { hello: TEXT } }, null, 2));
  const out = must(sh("npx", ["lefine", "strings", "push", "--file", "smoke-source.json", "--yes"], app), "strings push");
  if (!/Pushed|Nothing to push/.test(out)) throw new Error(`push did not say it pushed\n${out}`);
  return /Pushed [^\n]*/.exec(out)?.[0] ?? "";
});

await step("strings publish (with approval)", async () => {
  const out = await publish();
  if (!/Published/.test(out) || /failed/i.test(out)) throw new Error(`publish did not finish cleanly\n${out}`);
  return /Published[^\n]*/.exec(out)?.[0] ?? "";
});

await step("read from the CDN (lefine/server)", async () => {
  // The SDK the app ships with, not a hand-made fetch: manifest, then the language file. The edge keeps files 60 s.
  writeFileSync(
    join(app, "smoke-read.mjs"),
    `import { createStrings } from "lefine/server";
const s = createStrings({ project: ${JSON.stringify(APP)}, cdn: ${JSON.stringify(CDN)} });
const props = await s.load("en", ["smoke"]);
console.log(JSON.stringify(props.messages?.smoke?.hello ?? null));`,
  );
  const deadline = Date.now() + 90_000;
  let seen = "";
  for (;;) {
    seen = must(sh("node", ["smoke-read.mjs"], app, 60_000), "lefine/server read").trim();
    if (seen === JSON.stringify(TEXT)) return `en smoke.hello = ${seen}`;
    if (Date.now() > deadline) throw new Error(`the CDN serves ${seen}, expected ${JSON.stringify(TEXT)}`);
    await new Promise((r) => setTimeout(r, 5_000));
  }
});

await step("typed keys catch a bad key", () => {
  must(sh("npx", ["lefine", "strings", "types"], app), "strings types");
  writeFileSync(join(app, "app", "smoke-good.tsx"), `"use client";\nimport { useStrings } from "lefine/react";\nexport function SmokeGood() {\n  const t = useStrings("smoke");\n  return <p>{t("hello")}</p>;\n}\n`);
  must(sh("npx", ["tsc", "--noEmit", "-p", "."], app), "tsc with a known key");
  writeFileSync(join(app, "app", "smoke-bad.tsx"), `"use client";\nimport { useStrings } from "lefine/react";\nexport function SmokeBad() {\n  const t = useStrings("smoke");\n  return <p>{t("no_such_key_${RUN.replace(/-/g, "_")}")}</p>;\n}\n`);
  const bad = sh("npx", ["tsc", "--noEmit", "-p", "."], app);
  rmSync(join(app, "app", "smoke-bad.tsx"));
  if (bad.status === 0) throw new Error("tsc accepted an unknown key: typed keys do nothing");
  const lines = bad.out.split("\n").filter((l) => /error TS/.test(l));
  if (!lines.length || !lines.every((l) => l.includes("smoke-bad.tsx"))) throw new Error(`tsc failed, but not only on the bad key\n${bad.out}`);
  return lines[0]!.replace(/^.*error /, "error ").slice(0, 120);
});

finish(0);
