// What `npx lefine init` writes, with the app id from the environment so the example runs as cloned.
// In your own app, init writes the id itself: createStrings({ project: "app_..." }).
import { createStrings } from "lefine/server"; // "server" = runs anywhere: no Node or React inside

const project = import.meta.env.VITE_LEFINE_APP;
if (!project) throw new Error("Set VITE_LEFINE_APP to your app's id (app_...): see README.md. `npx lefine apps` lists them.");

export const locales = ((import.meta.env.VITE_LEFINE_LOCALES as string | undefined) ?? "en,de").split(",");
export const defaultLocale = "en";

// One per app: the manifest is kept 60 s, each version compiled once. The CDN answers browsers (CORS *).
export const strings = createStrings({
  project,
  // Only for another edge (the local dev stack); unset means https://cdn.lefine.ai.
  ...(import.meta.env.VITE_LEFINE_CDN ? { cdn: import.meta.env.VITE_LEFINE_CDN as string } : {}),
});
