import { connection } from "next/server";
import type { Locale } from "@/paraglide/runtime";
import { Texts } from "@/texts";

// Rendered on every request (no cache), so "server render" measures the library, not a cached page.
export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  await connection();
  const { locale } = await params;
  return <Texts locale={locale as Locale} />;
}
