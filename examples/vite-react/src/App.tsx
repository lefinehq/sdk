import { useStrings } from "lefine/react";
import { useState } from "react";
import { locales } from "./lefine";

export function App({ locale, onLocale }: { locale: string; onLocale: (locale: string) => void }) {
  const t = useStrings("example");
  const [count, setCount] = useState(0);
  return (
    <main style={{ fontFamily: "system-ui", padding: 32 }}>
      <h1>{t("title")}</h1>
      <p>{t("intro")}</p>
      <p>
        <button type="button" onClick={() => setCount((n) => n + 1)}>
          {t("button")}
        </button>{" "}
        {t("clicks", { count })}
      </p>
      <nav style={{ display: "flex", gap: 12 }}>
        {locales.map((l) => (
          <button key={l} type="button" disabled={l === locale} onClick={() => onLocale(l)}>
            {l}
          </button>
        ))}
      </nav>
    </main>
  );
}
