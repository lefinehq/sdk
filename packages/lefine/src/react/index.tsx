"use client";
// lefine/react: useStrings and StringsProvider, for any React app. In Next, lefine.Provider renders the provider.

import { useMemo } from "react";
import { devOnError } from "../strings/dev.js";
import { createTranslator } from "../strings/translator.js";
// Types through lefine/strings, so its declaration file is in every app that uses this entry: the app's
// `declare module "lefine/strings"` (lefine strings types) then applies to getStrings and useStrings too.
import type { KeyOf, Namespace, Translator } from "../strings/index.js";
import type { FormatError } from "../strings/format.js";
import { useLefine } from "./context.js";
import { devMarked } from "./dev-overlay.js";
import { keyed } from "./keyed.js";

export { StringsProvider } from "./context.js";

/** `t` for one namespace; only the namespaces the provider got are here. */
export function useStrings<N extends Namespace | undefined = undefined>(namespace?: N): Translator<KeyOf<N>, N> {
  const { locale, messages, timeZone, formats } = useLefine();
  return useMemo(() => {
    // Same timeZone and formats as the server (they come with the messages), so hydration matches.
    if (process.env.NODE_ENV !== "production") {
      // Development: each problem is logged once and its text gets a badge (dev-overlay.ts). A production build drops this block.
      const sink: FormatError[] = [];
      const log = devOnError(locale);
      const onError = (e: FormatError) => {
        sink.push(e);
        log?.(e);
      };
      const t = keyed(createTranslator<N>({ locale, messages, namespace, timeZone, formats, onError }));
      // React Native has no DOM to draw badges on: there the problems are only logged, and texts stay unmarked.
      return typeof navigator !== "undefined" && navigator.product === "ReactNative" ? t : devMarked(t, sink);
    }
    return keyed(createTranslator<N>({ locale, messages, namespace, timeZone, formats }));
  }, [locale, messages, namespace, timeZone, formats]);
}
