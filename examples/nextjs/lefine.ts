// What `npx lefine init` writes, with the app id and languages from the environment so the example runs as cloned.
// In your own app, init writes the id itself: project: "app_...".
import { createLefine } from "lefine/next";

const project = process.env.LEFINE_APP;
if (!project) throw new Error("Set LEFINE_APP to your app's id (app_...): see README.md. `npx lefine apps` lists them.");

export const lefine = createLefine({
  project,
  locales: (process.env.LEFINE_LOCALES ?? "en,de").split(","),
  defaultLocale: "en",
  // Only for another edge (the local dev stack); unset means https://cdn.lefine.ai.
  ...(process.env.LEFINE_CDN ? { cdn: process.env.LEFINE_CDN } : {}),
});
