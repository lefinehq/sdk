import type { ReactNode } from "react";

// No i18n library: the same page shape, so each library's cost is its total minus this.
export default async function Layout({ children, params }: { children: ReactNode; params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  return (
    <html lang={locale}>
      <body>{children}</body>
    </html>
  );
}
