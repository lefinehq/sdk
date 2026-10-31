import type { ReactNode } from "react";
import { i18nFor } from "@/i18n";
import { LinguiClientProvider } from "@/provider";

export default async function Layout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  const i18n = i18nFor(locale);
  return (
    <html lang={locale}>
      <body>
        <LinguiClientProvider locale={locale} messages={i18n.messages}>{children}</LinguiClientProvider>
      </body>
    </html>
  );
}
