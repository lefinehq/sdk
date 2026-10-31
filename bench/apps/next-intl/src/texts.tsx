"use client";
import { useTranslations } from "next-intl";
import keys from "./keys.json";
import { VALUES } from "./values";

export function Texts() {
  const t = useTranslations("page");
  return <main>{keys.map((k) => <p key={k}>{t(k, VALUES)}</p>)}</main>;
}
