// Hermes (React Native's engine) has no Intl.PluralRules: add the polyfill and the rules of each language the app
// ships, before anything formats a plural. Without it lefine still shows "one" for 1 and "other" for the rest.
import "@formatjs/intl-pluralrules/polyfill-force.js";
import "@formatjs/intl-pluralrules/locale-data/en.js";
import "@formatjs/intl-pluralrules/locale-data/de.js";
import { registerRootComponent } from "expo";
import App from "./App";

registerRootComponent(App);
