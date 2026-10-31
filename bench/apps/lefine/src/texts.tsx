"use client";
import { useStrings } from "lefine/react";
import keys from "./keys.json";
import { VALUES } from "./values";

export function Texts() {
  const t = useStrings("page");
  return <main>{keys.map((k) => <p key={k}>{t(k as never, VALUES as never)}</p>)}</main>;
}
