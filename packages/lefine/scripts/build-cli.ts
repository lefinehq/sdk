// The `lefine` bin: its source is packages/cli/src/lefine.ts (shared with @lefine/cli and the better-i18n CLI),
// bundled with that package's dependencies into dist/cli.js, so lefine has no runtime dependencies.
// TypeScript stays outside (an optional peer, loaded only by `lefine strings check`).
// `bun scripts/build-cli.ts [outdir]`; default dist/.
import { chmodSync } from "node:fs";
import { dirname, join } from "node:path";

const outdir = process.argv[2] ?? new URL("../dist", import.meta.url).pathname;

// jsonc-parser's package `main` is a UMD file with computed requires ("./impl/format"); bundled, it breaks at
// run time. Its ES module build bundles cleanly, so every import of it (ours and add-mcp's) points there.
const jsoncEsm = {
  name: "jsonc-parser-esm",
  setup(build: import("bun").PluginBuilder) {
    build.onResolve({ filter: /^jsonc-parser$/ }, () => ({
      path: join(dirname(Bun.resolveSync("jsonc-parser/package.json", new URL("../../cli", import.meta.url).pathname)), "lib", "esm", "main.js"),
    }));
  },
};

const result = await Bun.build({
  plugins: [jsoncEsm],
  entrypoints: [new URL("../../cli/src/lefine.ts", import.meta.url).pathname],
  outdir,
  target: "node",
  format: "esm",
  splitting: true,
  external: ["typescript"],
  naming: { entry: "cli.js", chunk: "cli/[name]-[hash].js" },
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}
chmodSync(join(outdir, "cli.js"), 0o755);
console.log(`${join(outdir, "cli.js")} and ${result.outputs.length - 1} chunk(s)`);
