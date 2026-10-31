import { describe, expect, it } from "bun:test";
import { migrateSource } from "../migrate.js";

describe("lefine migrate", () => {
  it("client: useTranslations from next-intl or @better-i18n/use-intl becomes useStrings from lefine/react", () => {
    for (const from of ["next-intl", "@better-i18n/use-intl"]) {
      const { text, todo } = migrateSource(`"use client";\nimport { useTranslations } from "${from}";\nexport function A() {\n  const t = useTranslations("nav");\n  return t("home");\n}\n`);
      expect(text).toBe(`"use client";\nimport { useStrings } from "lefine/react";\nexport function A() {\n  const t = useStrings("nav");\n  return t("home");\n}\n`);
      expect(todo).toEqual([]);
    }
  });

  it("server: getTranslations becomes lefine.getStrings with the locale", () => {
    const { text, todo } = migrateSource(
      `import { getTranslations } from "next-intl/server";\nconst a = await getTranslations({ locale, namespace: "home" });\nconst b = await getTranslations({ locale: params.locale, namespace: "meta" });\nconst c = await getTranslations("nav");\n`,
      "@/lib/lefine",
    );
    expect(text).toBe(
      `import { lefine } from "@/lib/lefine";\nconst a = await lefine.getStrings(locale, "home");\nconst b = await lefine.getStrings(params.locale, "meta");\nconst c = await lefine.getStrings(locale, "nav");\n`,
    );
    expect(todo).toEqual(["getTranslations() without a locale became lefine.getStrings(locale, ...): make sure `locale` is the [locale] param there."]);
  });

  it("what is not one to one is kept and listed, never guessed", () => {
    const { text, todo } = migrateSource(
      `import { useTranslations, useLocale } from "next-intl";\nimport { NextIntlClientProvider } from "next-intl";\nconst x = t.raw("html");\n`,
    );
    expect(text).toContain('import { useStrings } from "lefine/react";\nimport { useLocale } from "next-intl"; // TODO lefine');
    expect(text).toContain('import { NextIntlClientProvider } from "next-intl";');
    expect(todo.join("\n")).toContain("useLocale from next-intl has no lefine equivalent");
    expect(todo.join("\n")).toContain("NextIntlClientProvider: replace with <lefine.Provider");
    expect(todo.join("\n")).toContain("t.raw is not supported");
  });

  it("a file without next-intl is unchanged", () => {
    const src = `import { useState } from "react";\n`;
    expect(migrateSource(src)).toEqual({ text: src, todo: [] });
  });
});
