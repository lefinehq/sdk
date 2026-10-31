// Preloaded by `bun test` (bunfig.toml): a CLI run inside a test prints its links and never opens a browser.
// openInBrowser also refuses under NODE_ENV=test, in CI and without a terminal; this makes it explicit.
process.env.LEFINE_NO_BROWSER = "1";
process.env.CI = "1";
