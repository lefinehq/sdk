import { StringsProvider } from "lefine/react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { defaultLocale, locales, strings } from "./lefine";

const root = createRoot(document.getElementById("root")!);
const rtl = (locale: string) => /^(ar|ckb|dv|fa|he|ps|sd|ug|ur|yi)(-|$)/i.test(locale);

/** Loads one language's "example" texts from the CDN, then renders with them. */
async function show(locale: string) {
  const props = await strings.load(locale, ["example"]);
  document.documentElement.lang = locale;
  document.documentElement.dir = rtl(locale) ? "rtl" : "ltr";
  root.render(
    <StringsProvider {...props}>
      <App locale={locale} onLocale={show} />
    </StringsProvider>,
  );
}

const wanted = navigator.language.split("-")[0]!;
void show(locales.includes(wanted) ? wanted : defaultLocale);
