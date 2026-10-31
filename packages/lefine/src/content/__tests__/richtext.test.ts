// @vitest-environment jsdom
// lefine/content/react against Lefine's own rich text HTML (fixtures/richtext-golden.json, en and ar): the same DOM, the same
// sanitizing, and the same closed set.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RichText, UnsupportedRichTextError, richTextToReact, sanitizeUrl } from "../react.js";
import golden from "./fixtures/richtext-golden.json";

const hrefs = { internalDocToHref: (l: { fields: { doc?: { value: string } | null } }) => `/pages/${l.fields.doc?.value}`, uploadToSrc: (n: { value: string }) => `/media/${n.value}.png` };
const render = (props: Parameters<typeof RichText>[0]) => renderToStaticMarkup(createElement(RichText, props));
const dom = (markup: string) => new DOMParser().parseFromString(markup, "text/html").body;
const same = (markup: string) => dom(markup).innerHTML;
const text = (value: string, format = 0) => ({ type: "text", text: value, format, detail: 0, mode: "normal", style: "", version: 1 });
const paragraph = (...children: unknown[]) => ({ type: "paragraph", direction: "ltr", format: "", indent: 0, version: 1, children });
const doc = (...children: unknown[]) => ({ schemaVersion: 1, root: { type: "root", direction: "ltr", format: "", indent: 0, version: 1, children } });
const link = (url: string) => paragraph({ type: "link", direction: "ltr", format: "", indent: 0, fields: { linkType: "custom", newTab: false, url }, children: [text("x")] });

describe("RichText (React)", () => {
  for (const locale of ["en", "ar"] as const) {
    it(`draws the same DOM as lexicalToHtml (${locale})`, () => {
      expect(same(render({ data: golden[locale].doc, ...hrefs }))).toBe(same(golden[locale].html));
    });
  }

  it("empty is the empty wrapper; the class and the container follow the props", () => {
    expect(render({ data: null })).toBe('<div class="richtext"></div>');
    expect(render({ data: doc(paragraph()), disableContainer: true })).toBe("");
    expect(render({ data: doc(paragraph(text("a"))), className: "prose" })).toBe('<div class="prose"><p>a</p></div>');
  });

  it("text is escaped, never markup", () => {
    const body = dom(render({ data: doc(paragraph(text('<script>alert(1)</script><img src=x onerror="x">', 1))) }));
    expect(body.querySelector("script, img")).toBeNull();
    expect(body.querySelector("strong")?.textContent).toBe('<script>alert(1)</script><img src=x onerror="x">');
  });

  it("link and image addresses keep only web, mail, tel, relative and fragment schemes", () => {
    for (const bad of ["javascript:alert(1)", "javascript:", " JAVASCRIPT:", " JaVaScRiPt:alert(1)", "java\nscript:alert(1)", "data:text/html,<script>", "vbscript:x"]) {
      expect(dom(render({ data: doc(link(bad)) })).querySelector("a")?.getAttribute("href")).toBe("#");
    }
    expect(dom(render({ data: doc(link("https://a.b/c?d=1&e=2")) })).querySelector("a")?.getAttribute("href")).toBe("https://a.b/c?d=1&e=2");
    expect(dom(render({ data: doc(link('/p"onmouseover="x')) })).querySelector("a")?.getAttributeNames()).toEqual(["href"]);
    const img = doc({ type: "upload", relationTo: "media", value: "m1", fields: { alt: "a" } });
    expect(dom(render({ data: img, uploadToSrc: () => "javascript:alert(1)" })).querySelector("img")?.getAttribute("src")).toBe("#");
    expect(sanitizeUrl("tel:+1")).toBe("tel:+1");
  });

  describe("closed set: unknown is a failure, never a silent drop", () => {
    const withNode = (node: unknown) => ({ root: { type: "root", children: [node], direction: null, format: "", indent: 0 } });
    it("unknown nodes, marks and attributes outside v1 throw", () => {
      expect(() => richTextToReact(withNode({ type: "table", children: [] }))).toThrow(UnsupportedRichTextError);
      expect(() => richTextToReact(withNode(paragraph({ type: "mention", children: [] })))).toThrow(/mention/);
      expect(() => richTextToReact(doc(paragraph(text("x", 32))))).toThrow(/subscript/);
      expect(() => richTextToReact(doc(paragraph({ ...text("x"), style: "color: red;" })))).toThrow(/colour/);
      expect(() => richTextToReact(withNode({ ...paragraph(), format: "center" }))).toThrow(/alignment/);
      expect(() => richTextToReact(withNode({ type: "heading", tag: "h1", children: [], format: "", indent: 0 }))).toThrow(/h1/);
      expect(() => richTextToReact(withNode({ type: "list", listType: "check", children: [], format: "", indent: 0 }))).toThrow(/list type/);
    });
    it("an internal link or an image without its resolver throws; a newer schemaVersion is refused", () => {
      expect(() => richTextToReact(golden.en.doc)).toThrow(/internalDocToHref/);
      expect(() => richTextToReact(withNode({ type: "upload", relationTo: "media", value: "m1", fields: null }))).toThrow(/uploadToSrc/);
      expect(() => richTextToReact({ ...golden.en.doc, schemaVersion: 2 })).toThrow(/newer/);
    });
    it("the component does not swallow the error", () => {
      expect(() => render({ data: withNode({ type: "table", children: [] }) })).toThrow(UnsupportedRichTextError);
    });
  });
});
