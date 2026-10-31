"use client";
// lefine/next/link: next/link that keeps the visitor's locale, or switches it with `locale`.

import NextLink from "next/link";
import { usePathname } from "next/navigation";
import type { ComponentProps } from "react";
import { useLefine } from "../react/context.js";
import { localize, split } from "./routing.js";

type LinkProps = Omit<ComponentProps<typeof NextLink>, "href" | "locale"> & {
  /** An app path (`/pricing`); the current page when left out. */
  href?: string;
  /** Another locale: the same page in it (a language switcher). */
  locale?: string;
};

export function Link({ href, locale, onClick, ...props }: LinkProps) {
  const { locale: current, routing } = useLefine();
  if (!routing) throw new Error("lefine: Link needs <lefine.Provider> from lefine/next (it knows the locale prefixes).");
  const pathname = usePathname();
  const target = locale ?? current;
  return (
    <NextLink
      {...props}
      href={localize(routing, href ?? split(routing, pathname).rest, target)}
      hrefLang={locale}
      onClick={(event) => {
        // The proxy reads the cookie for unprefixed URLs; Next's router may not ask the proxy at all.
        if (locale && locale !== current) document.cookie = `NEXT_LOCALE=${encodeURIComponent(locale)}; path=/; max-age=34560000; samesite=lax`;
        onClick?.(event);
      }}
    />
  );
}
