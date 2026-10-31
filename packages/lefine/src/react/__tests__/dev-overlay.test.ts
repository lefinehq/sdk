// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileMessages } from "../../strings/compile.js";
import { StringsProvider, useStrings } from "../index.js";

const routing = { locales: ["en"], defaultLocale: "en", prefix: "always" as const };
const messages = compileMessages({ nav: { home: "Home", hi: "Hi {name}" } });

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("dev overlay (development only)", () => {
  it("a missing key and a missing value get a badge with the reason; a good text gets none", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => (cb(0), 0));
    // jsdom has no layout: give every text a box so the overlay places badges.
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => ({ x: 10, y: 20, left: 10, top: 20, right: 60, bottom: 30, width: 50, height: 10, toJSON() {} }),
    });

    function Nav() {
      const t = useStrings("nav");
      return h("nav", null, h("p", null, t("home")), h("p", null, t("gone" as never)), h("p", null, t("hi")));
    }
    const container = document.createElement("div");
    document.body.appendChild(container);
    await act(async () => createRoot(container).render(h(StringsProvider, { locale: "en", messages, routing, timeZone: "UTC" }, h(Nav))));
    await act(async () => {});

    const badges = [...document.querySelectorAll("[data-lefine-dev] span")].map((b) => (b as HTMLElement).title);
    expect(badges).toEqual(['No text for "nav.gone" in this locale', '"name" was not passed']);
    // The text itself reads as before; only invisible marks surround it.
    expect(container.textContent?.replace(/⁣/g, "")).toBe("Homenav.goneHi {name}");
  });
});
