import { createElement as h } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { compileMessages } from "../../strings/compile.js";
import { StringsProvider } from "../context.js";
import { useStrings } from "../index.js";

const routing = { locales: ["en"], defaultLocale: "en", prefix: "always" as const };

describe("StringsProvider + useStrings", () => {
  const messages = compileMessages({ common: { hello: "Hello <b>{name}</b>", items: "{n, plural, one {# item} other {# items}}" } });

  function Greeting() {
    const t = useStrings("common");
    // No JSX: the repo's vitest include takes *.test.ts only.
    return h("p", { lang: "en" }, t.rich("hello", { name: "Ada", b: (chunks) => h("b", null, chunks) }), " · ", t("items", { n: 1 }));
  }

  it("renders compiled messages with elements from tag handlers", () => {
    const warn = vi.spyOn(console, "error").mockImplementation(() => {});
    const html = renderToStaticMarkup(h(StringsProvider, { locale: "en", messages, routing }, h(Greeting)));
    expect(html).toBe('<p lang="en">Hello <b>Ada</b> · 1 item</p>');
    // Elements from tag handlers carry keys: no "unique key" warning.
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("says what is missing without a provider", () => {
    expect(() => renderToStaticMarkup(h(Greeting))).toThrow("put <StringsProvider> (or <lefine.Provider> in Next) above this component");
  });
});
