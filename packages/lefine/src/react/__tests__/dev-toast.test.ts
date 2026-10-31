// @vitest-environment jsdom
import { act, createElement as h } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { compileMessages } from "../../strings/compile.js";
import { StringsProvider } from "../index.js";

const BASE = "https://cdn.test/app_web1";
afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the 'strings updated' toast (development only, #88)", () => {
  it("a newer revision on the edge shows how many strings of this language the release changed, with Reload", async () => {
    vi.useFakeTimers();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    let revision = 4;
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      asked.push(url.replace(BASE, ""));
      if (url.endsWith("/manifest.json")) return Response.json({ revision, version: "mh5abc12-ffff0000" });
      return Response.json({ locales: { de: { added: 2, changed: 9, removed: 1 }, en: { added: 2, changed: 0, removed: 0 } } });
    });
    const container = document.body.appendChild(document.createElement("div"));
    await act(async () => createRoot(container).render(h(StringsProvider, { locale: "de", messages: compileMessages({}), timeZone: "UTC", live: { base: BASE, revision: 4 } })));

    await act(async () => void (await vi.advanceTimersByTimeAsync(5_000)));
    expect(document.querySelector("[data-lefine-toast]")).toBeNull(); // same revision: nothing
    revision = 5;
    await act(async () => void (await vi.advanceTimersByTimeAsync(5_000)));
    const toast = document.querySelector("[data-lefine-toast]");
    expect(toast?.textContent).toContain("12 strings updated in Lefine");
    expect([...toast!.querySelectorAll("button")].map((b) => b.textContent)).toEqual(["Reload", "×"]);
    expect(asked).toContain("/v/mh5abc12-ffff0000/changes.json");
    // Once per revision.
    await act(async () => void (await vi.advanceTimersByTimeAsync(5_000)));
    expect(asked.filter((u) => u.endsWith("changes.json"))).toHaveLength(1);
  });

  it("without live (production props, or a caller that does not pass it) nothing is asked", async () => {
    vi.useFakeTimers();
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const container = document.body.appendChild(document.createElement("div"));
    await act(async () => createRoot(container).render(h(StringsProvider, { locale: "de", messages: compileMessages({}), timeZone: "UTC" })));
    await act(async () => void (await vi.advanceTimersByTimeAsync(20_000)));
    expect(fetch).not.toHaveBeenCalled();
  });
});
