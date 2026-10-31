"use client";
import { type Messages, setupI18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { type ReactNode, useState } from "react";

export function LinguiClientProvider({ locale, messages, children }: { locale: string; messages: Messages; children: ReactNode }) {
  const [i18n] = useState(() => setupI18n({ locale, messages: { [locale]: messages } }));
  return <I18nProvider i18n={i18n}>{children}</I18nProvider>;
}
