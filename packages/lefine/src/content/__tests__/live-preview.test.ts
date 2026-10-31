// @vitest-environment jsdom
// The page side of live preview: ready goes to the editor's origin only, a save from the editor calls
// back, a message from any other origin or of another type does nothing.
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_EDITOR_ORIGIN, LIVE_PREVIEW_READY, LIVE_PREVIEW_SAVED, isDocumentSaved, onDocumentSaved, ready } from "../live-preview.js";
import { RefreshOnSave } from "../refresh-on-save.js";

const saved = { type: LIVE_PREVIEW_SAVED, collection: "posts", entryId: "ent_1", versionNo: 4, locale: "en", global: false };
const send = (data: unknown, origin = DEFAULT_EDITOR_ORIGIN) => window.dispatchEvent(new MessageEvent("message", { data, origin }));

/** The page as if framed: window.parent is another window whose postMessage we watch. */
function framed() {
  const post = vi.fn();
  const parent = { postMessage: post } as unknown as Window;
  const spy = vi.spyOn(window, "parent", "get").mockReturnValue(parent);
  return { post, restore: () => spy.mockRestore() };
}

afterEach(() => vi.restoreAllMocks());

describe("live preview, page side", () => {
  it("ready posts to the editor's origin, never to *", () => {
    const { post, restore } = framed();
    ready();
    expect(post).toHaveBeenCalledWith({ type: LIVE_PREVIEW_READY, ready: true }, "https://dash.lefine.ai");
    ready("http://localhost:3001");
    expect(post).toHaveBeenLastCalledWith({ type: LIVE_PREVIEW_READY, ready: true }, "http://localhost:3001");
    restore();
  });

  it("not in a frame: ready does nothing", () => {
    expect(() => ready()).not.toThrow();
  });

  it("onDocumentSaved calls back for the editor's saves only, and stops after unsubscribe", () => {
    const { post, restore } = framed();
    const seen: unknown[] = [];
    const stop = onDocumentSaved((e) => seen.push(e.entryId));
    expect(post).toHaveBeenCalledTimes(1); // it said ready
    send(saved);
    send(saved, "https://evil.example");
    send({ ...saved, type: "payload-document-event" });
    send("not an object");
    expect(seen).toEqual(["ent_1"]);
    stop();
    send(saved);
    expect(seen).toEqual(["ent_1"]);
    restore();
  });

  it("isDocumentSaved checks origin, type and id", () => {
    expect(isDocumentSaved({ origin: DEFAULT_EDITOR_ORIGIN, data: saved })).toBe(true);
    expect(isDocumentSaved({ origin: DEFAULT_EDITOR_ORIGIN, data: { type: LIVE_PREVIEW_SAVED } })).toBe(false);
    expect(isDocumentSaved({ origin: "https://dash.lefine.ai.evil.com", data: saved })).toBe(false);
  });

  it("<RefreshOnSave> refreshes after each save from the editor, and stops when unmounted", async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const refresh = vi.fn();
    const el = document.createElement("div");
    const root = createRoot(el);
    await act(async () => root.render(createElement(RefreshOnSave, { refresh, editorOrigin: "http://localhost:3001" })));
    send(saved, "http://localhost:3001");
    send(saved); // the default origin is not this editor's
    expect(refresh).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
    send(saved, "http://localhost:3001");
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});
