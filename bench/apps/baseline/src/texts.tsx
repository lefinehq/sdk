"use client";
import keys from "./keys.json";

/** The 200 keys as they are, no texts: the page and React without any i18n. */
export function Texts() {
  return <main>{keys.map((k) => <p key={k}>{k}</p>)}</main>;
}
