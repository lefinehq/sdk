#!/usr/bin/env bash
# lefine's tests and types against Next 16 (the workspace pins Next 15 for the legacy @better-i18n/next).
# Copies src/ into a temp folder with its own Next 16 install, so the workspace lockfile is not touched.
# Used by CI (.github/workflows/ci.yml, "lefine on Next 16"); runs locally too.
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
cp -R "$here/src" "$here/tsconfig.json" "$dir/"
cat > "$dir/package.json" <<'JSON'
{ "name": "lefine-next16-check", "private": true, "type": "module",
  "devDependencies": { "next": "^16.4.3", "react": "^19.3.0", "react-dom": "^19.3.0", "@types/react": "^19.3.0", "@types/node": "^20.19.43",
    "vitest": "^3.2.7", "intl-messageformat": "^11.2.0", "@formatjs/icu-messageformat-parser": "^3.5.3", "typescript": "~5.9.3", "jsdom": "^27.4.0" } }
JSON
cd "$dir"
bun install
echo "next $(node -p 'require("next/package.json").version')"
bunx tsc -p tsconfig.json --noEmit
bunx vitest run src/next src/react src/strings
