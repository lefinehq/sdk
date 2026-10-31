import type { ReactNode } from "react";
import { lefine } from "@/lefine";

export default async function Layout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  return (
    <html lang={locale}>
      <body>
        <lefine.Provider locale={locale} namespaces={["page"]}>{children}</lefine.Provider>
      </body>
    </html>
  );
}
