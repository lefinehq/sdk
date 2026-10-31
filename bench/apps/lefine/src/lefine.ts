import { createLefine } from "lefine/next";

// The bench edge (bench/edge.mjs) serves what a publish writes: manifest, versioned files and the compiled IR.
export const lefine = createLefine({
  project: "app_bench0000000000000000000000000001",
  locales: ["en", "de", "tr"],
  defaultLocale: "en",
  cdn: process.env.LEFINE_BENCH_CDN ?? "http://localhost:8898",
});
