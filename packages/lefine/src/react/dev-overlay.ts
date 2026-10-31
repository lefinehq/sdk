// Development only: a small badge next to each text that has a problem (missing key, value or format). Every
// caller checks process.env.NODE_ENV, so a production build drops this file (react/__tests__/size.test.ts).
//
// How: useStrings wraps a text that had a problem in two invisible U+2063 marks. The overlay finds those text nodes
// and draws a badge over each with plain DOM, outside React's tree, so it never changes what React rendered.

import type { FormatError } from "../strings/format.js";
import type { Translator } from "../strings/translator.js";

const MARK = "⁣";
const problems = new Map<string, string>();

const explain = (e: FormatError) =>
  e.code === "MISSING_MESSAGE" ? `No text for "${e.name}" in this locale` : e.code === "MISSING_VALUE" ? `"${e.name}" was not passed` : `${e.code} "${e.name}"`;

/** A translator whose texts with problems come back marked, for the overlay. `sink` gets each call's errors. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function devMarked<T extends Translator<any, any>>(t: T, sink: FormatError[]): T {
  const mark = <V>(out: V): V | Array<unknown> | string => {
    if (sink.length === 0) return out;
    const why = sink.map(explain).join("; ");
    if (typeof out === "string") {
      const marked = `${MARK}${out}${MARK}`;
      problems.set(out, why);
      return marked;
    }
    problems.set(String(out), why);
    return [MARK, ...(Array.isArray(out) ? out : [out]), MARK];
  };
  const wrapped = ((key: string, ...values: unknown[]) => {
    sink.length = 0;
    return mark((t as unknown as (k: string, ...v: unknown[]) => string)(key, ...values));
  }) as unknown as T;
  wrapped.rich = ((key: string, ...values: unknown[]) => {
    sink.length = 0;
    return mark((t.rich as (k: string, ...v: unknown[]) => unknown)(key, ...values));
  }) as T["rich"];
  wrapped.has = t.has;
  return wrapped;
}

let started = false;

/** Draws the badges and keeps them in place while the page changes, scrolls or resizes. */
export function startDevOverlay(): void {
  if (started || typeof document === "undefined") return;
  started = true;
  const layer = document.createElement("div");
  layer.setAttribute("data-lefine-dev", "");
  layer.style.cssText = "position:fixed;inset:0;pointer-events:none;z-index:2147483647";
  document.body.appendChild(layer);
  let queued = false;
  const draw = () => {
    queued = false;
    layer.replaceChildren();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.nodeValue ?? "";
      if (!text.includes(MARK) || layer.contains(node)) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      const box = range.getBoundingClientRect();
      if (box.width === 0 && box.height === 0) continue;
      const badge = document.createElement("span");
      badge.textContent = "!";
      badge.title = problems.get(text.split(MARK)[1] ?? "") ?? "lefine: this text has a problem";
      badge.style.cssText = `position:fixed;left:${box.right}px;top:${box.top - 6}px;width:12px;height:12px;border-radius:6px;background:#e5484d;color:#fff;font:bold 9px/12px system-ui;text-align:center;pointer-events:auto;cursor:help`;
      layer.appendChild(badge);
    }
  };
  const later = () => {
    if (!queued) {
      queued = true;
      requestAnimationFrame(draw);
    }
  };
  // The badges are DOM changes too: only changes outside the layer redraw.
  new MutationObserver((records) => {
    if (records.some((r) => !layer.contains(r.target))) later();
  }).observe(document.body, { subtree: true, childList: true, characterData: true });
  addEventListener("scroll", later, true);
  addEventListener("resize", later);
  later();
}
