import { connection } from "next/server";
import { setRequestLocale } from "next-intl/server";
import { Texts } from "@/texts";

// Rendered on every request (no cache), so "server render" measures the library, not a cached page.
export default async function Page({ params }: { params: Promise<{ locale: string }> }) {
  await connection();
  const { locale } = await params;
  setRequestLocale(locale);
  return <Texts />;
}
