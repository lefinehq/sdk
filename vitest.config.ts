import { defineConfig } from "vitest/config";

// `bun run test` = this (every vitest package) + `test:bun` (cli and expo, written for bun:test).
// `bun test` alone would run these vitest files under bun's runner, and the copies in dist/.
export default defineConfig({
  test: {
    pool: "forks",
    // No test may open a real browser: a CLI run inside a test prints its links only.
    env: { LEFINE_NO_BROWSER: "1", CI: "1" },
    testTimeout: 15000,
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "packages/cli/**",         // bun:test
      "packages/expo/**",        // bun:test
      "packages/content/**",     // its own project below (jsdom)
      "tests/expo-native/**",    // React Native
      "apps/**",
    ],
    include: [
      "packages/**/__tests__/**/*.test.ts",
      "packages/**/*.test.ts",
      // The GitHub Action (github-action/): plain .mjs run by a composite action.
      "github-action/**/*.test.ts",
      // Repo-wide policy tests: they assert things about the repo itself
      // (deploy scripts, entrypoints), so they belong to no single package.
      "tests/repo-policy/**/*.test.ts",
    ],
    projects: [
      { extends: true, test: { name: "packages" } },
      // packages/content/vitest.config.ts: every test there needs a browser-like window.
      "packages/content",
    ],
  },
});
