import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { lefine } from "../../lefine";

/** Languages written right to left get dir="rtl". */
const rtl = (locale: string) => /^(ar|ckb|dv|fa|he|ps|sd|ug|ur|yi)(-|$)/i.test(locale);

export const generateStaticParams = () => lefine.locales.map((locale) => ({ locale }));

export default async function LocaleLayout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  if (!lefine.locales.includes(locale)) notFound();
  return (
    <html lang={locale} dir={rtl(locale) ? "rtl" : "ltr"}>
      {/* The client components below read the "example" namespace: the Provider sends only that one. */}
      <body style={{ fontFamily: "system-ui", padding: 32 }}>
        <lefine.Provider locale={locale} namespaces={["example"]}>{children}</lefine.Provider>
      </body>
    </html>
  );
}
