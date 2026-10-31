import { Link } from "lefine/next/link";
import { lefine } from "../../lefine";
import { Clicks } from "./clicks";

export default async function Home({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  // On the server: the texts of one namespace, as a typed translator once `npx lefine strings types` ran.
  const t = await lefine.getStrings(locale, "example");
  return (
    <main>
      <h1>{t("title")}</h1>
      <p>{t("intro")}</p>
      <Clicks />
      <nav style={{ display: "flex", gap: 12, marginTop: 24 }}>
        {lefine.locales.map((l) => (
          <Link key={l} href="/" locale={l}>
            {l}
          </Link>
        ))}
      </nav>
    </main>
  );
}
