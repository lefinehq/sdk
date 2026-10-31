"use client";
import { useLingui } from "@lingui/react";
import keys from "./keys.json";
import { VALUES } from "./values";

export function Texts() {
  const { i18n } = useLingui();
  return <main>{keys.map((k) => <p key={k}>{i18n._(k, VALUES)}</p>)}</main>;
}
