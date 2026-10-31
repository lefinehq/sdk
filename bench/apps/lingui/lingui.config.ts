import { defineConfig } from "@lingui/cli";

export default defineConfig({ locales: ["en", "de", "tr"], sourceLocale: "en", catalogs: [{ path: "src/locales/{locale}", include: ["src/"] }] });
