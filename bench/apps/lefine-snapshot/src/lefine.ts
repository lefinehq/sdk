import { createLefine } from "lefine/next";
import snapshot from "./lefine-snapshot.json";

// Same as bench/apps/lefine, plus the texts as they were at build time: the first request after a deploy is served
// from them while the edge is asked in the background.
export const lefine = createLefine({
  project: "app_bench0000000000000000000000000001",
  locales: ["en", "de", "tr"],
  defaultLocale: "en",
  cdn: process.env.LEFINE_BENCH_CDN ?? "http://localhost:8898",
  snapshot,
});
