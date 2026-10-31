import "server-only";
import { type I18n, type Messages, setupI18n } from "@lingui/core";

const locales = ["en", "de", "tr"] as const;
const all: Record<string, Messages> = Object.fromEntries(await Promise.all(locales.map(async (l) => [l, (await import(`./locales/${l}.po`)).messages] as const)));
const instances: Record<string, I18n> = Object.fromEntries(locales.map((l) => [l, setupI18n({ locale: l, messages: { [l]: all[l]! } })]));

export const i18nFor = (locale: string): I18n => instances[locale] ?? instances.en!;
