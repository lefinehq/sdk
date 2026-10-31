"use client";
// In the browser: the same texts through the Provider in layout.tsx, with an ICU plural.
import { useStrings } from "lefine/react";
import { useState } from "react";

export function Clicks() {
  const t = useStrings("example");
  const [count, setCount] = useState(0);
  return (
    <p>
      <button type="button" onClick={() => setCount((n) => n + 1)}>
        {t("button")}
      </button>{" "}
      {t("clicks", { count })}
    </p>
  );
}
