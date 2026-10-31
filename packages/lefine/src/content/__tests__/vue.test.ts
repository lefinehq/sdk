// @vitest-environment jsdom
// lefine/content/vue against Lefine's own rich text HTML (fixtures/richtext-golden.json, en and ar): the same DOM,
// the same sanitizing, the same closed set. The React adapter's test (richtext.test.ts) has the same cases.
import { describe, expect, it } from "vitest";
import { createApp, createSSRApp, h } from "vue";
import { renderToString } from "vue/server-renderer";
import { RichText, UnsupportedRichTextError, richTextToVNodes } from "../vue.js";
import golden from "./fixtures/richtext-golden.json";

const hrefs = { internalDocToHref: (l: { fields: { doc?: { value: string } | null } }) => `/pages/${l.fields.doc?.value}`, uploadToSrc: (n: { value: string }) => `/media/${n.value}.png` };
const ssr = (props: Record<string, unknown>) => renderToString(createSSRApp({ render: () => h(RichText, props) }));
const dom = (markup: string) => new DOMParser().parseFromString(markup, "text/html").body;
const same = (markup: string) => dom(markup).innerHTML;
const text = (value: string, format = 0) => ({ type: "text", text: value, format, detail: 0, mode: "normal", style: "", version: 1 });
const paragraph = (...children: unknown[]) => ({ type: "paragraph", direction: "ltr", format: "", indent: 0, version: 1, children });
const doc = (...children: unknown[]) => ({ schemaVersion: 1, root: { type: "root", direction: "ltr", format: "", indent: 0, version: 1, children } });
const link = (url: string) => paragraph({ type: "link", direction: "ltr", format: "", indent: 0, fields: { linkType: "custom", newTab: false, url }, children: [text("x")] });

describe("RichText (Vue)", () => {
  for (const locale of ["en", "ar"] as const) {
    it(`server render draws the same DOM as lexicalToHtml (${locale})`, async () => {
      expect(same(await ssr({ data: golden[locale].doc, ...hrefs }))).toBe(same(golden[locale].html));
    });
  }

  it("client render draws the same DOM too", () => {
    const el = document.createElement("div");
    const app = createApp({ render: () => h(RichText, { data: golden.en.doc, ...hrefs }) });
    app.mount(el);
    expect(same(el.innerHTML)).toBe(same(golden.en.html));
    app.unmount();
  });

  it("empty is the empty wrapper; the class and the container follow the props", async () => {
    expect(await ssr({ data: null })).toBe('<div class="richtext"></div>');
    expect(richTextToVNodes(doc(paragraph()))).toEqual([]);
    expect(await ssr({ data: doc(paragraph(text("a"))), className: "prose" })).toBe('<div class="prose"><p>a</p></div>');
  });

  it("text is escaped; link addresses keep only safe schemes", async () => {
    const body = dom(await ssr({ data: doc(paragraph(text('<script>alert(1)</script>', 1))) }));
    expect(body.querySelector("script")).toBeNull();
    for (const bad of ["javascript:alert(1)", "javascript:", " JaVaScRiPt:alert(1)", "data:text/html,<script>"]) {
      expect(dom(await ssr({ data: doc(link(bad)) })).querySelector("a")?.getAttribute("href")).toBe("#");
    }
    expect(dom(await ssr({ data: doc(link('/p"onmouseover="x')) })).querySelector("a")?.getAttributeNames()).toEqual(["href"]);
  });

  it("outside v1 throws, and the component does not swallow it", async () => {
    const withNode = (node: unknown) => ({ root: { type: "root", children: [node], direction: null, format: "", indent: 0 } });
    expect(() => richTextToVNodes(withNode({ type: "table", children: [] }))).toThrow(UnsupportedRichTextError);
    expect(() => richTextToVNodes(golden.en.doc)).toThrow(/internalDocToHref/);
    await expect(ssr({ data: withNode({ type: "table", children: [] }) })).rejects.toThrow(UnsupportedRichTextError);
  });
});
