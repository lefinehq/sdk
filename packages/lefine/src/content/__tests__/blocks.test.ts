// @vitest-environment jsdom
// The render contract: every block of a section list is drawn by its own renderer, in each language,
// and a block nobody draws or a block its schema refuses is an error, never a page that silently loses a section.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, expectTypeOf, it } from "vitest";
import { InvalidBlockError, renderBlocks, UnknownBlockError } from "../index.js";
import { RichText } from "../react.js";
import golden from "./fixtures/richtext-golden.json";

type Hero = { blockType: "hero"; heading: string; cta?: { label: string; href: string } };
type Body = { blockType: "body"; text: unknown };
type Block = Hero | Body;

const hrefs = { internalDocToHref: (l: { fields: { doc?: { value: string } | null } }) => `/pages/${l.fields.doc?.value}`, uploadToSrc: (n: { value: string }) => `/media/${n.value}.png` };
const renderers = {
  hero: (b: Hero, at: { index: number }) => createElement("section", { key: at.index, className: "hero" }, createElement("h1", null, b.heading), b.cta ? createElement("a", { href: b.cta.href }, b.cta.label) : null),
  body: (b: Body, at: { index: number }) => createElement(RichText, { key: at.index, data: b.text, ...hrefs }),
};
const html = (blocks: Block[]) => renderToStaticMarkup(createElement("main", null, renderBlocks<Block, ReturnType<typeof createElement>>(blocks, renderers)));
const dom = (markup: string) => new DOMParser().parseFromString(markup, "text/html").body;

/** One page in two languages, one of them right-to-left: every block type of the model appears in each. */
const PAGES: Record<"en" | "ar", Block[]> = {
  en: [{ blockType: "hero", heading: "Ship in every language", cta: { label: "Start", href: "/start" } }, { blockType: "body", text: golden.en.doc }],
  ar: [{ blockType: "hero", heading: "انشر بكل اللغات", cta: { label: "ابدأ", href: "/ar/start" } }, { blockType: "body", text: golden.ar.doc }],
};

describe("renderBlocks", () => {
  it("every block type of the model has a page in both languages (a block without a fixture fails here)", () => {
    for (const locale of ["en", "ar"] as const) expect(new Set(PAGES[locale].map((b) => b.blockType))).toEqual(new Set(Object.keys(renderers)));
  });

  for (const locale of ["en", "ar"] as const) {
    it(`draws each block in order (${locale}), rich text as lefine's lexicalToHtml does`, () => {
      const body = dom(html(PAGES[locale]));
      const main = body.querySelector("main")!;
      expect([...main.children].map((c) => c.tagName.toLowerCase())).toEqual(["section", "div"]);
      expect(main.querySelector("section.hero h1")?.textContent).toBe(PAGES[locale][0]!.blockType === "hero" ? (PAGES[locale][0] as Hero).heading : "");
      expect(main.querySelector("div.richtext")!.outerHTML).toBe(dom(golden[locale].html).firstElementChild!.outerHTML);
    });
  }

  it("right-to-left text comes through as written; the page's dir is the site's to set", () => {
    const body = dom(html(PAGES.ar));
    expect(body.querySelector("h2")?.textContent).toBe("مرحبا بكم");
    expect(body.querySelector("[dir]")).toBeNull();
  });

  it("an unknown block throws, with its type and row; no section is dropped silently", () => {
    const page = [...PAGES.en, { blockType: "pricing" } as unknown as Block];
    expect(() => html(page)).toThrow(UnknownBlockError);
    expect(() => html(page)).toThrow('No renderer for block "pricing" (row 2)');
    expect(() => html([{ heading: "no type" } as unknown as Block])).toThrow(UnknownBlockError);
    // An inherited name is not a renderer.
    expect(() => renderBlocks([{ blockType: "toString" } as never], renderers as never)).toThrow(UnknownBlockError);
  });

  it("a block its schema refuses throws InvalidBlockError; the parsed value is what the renderer gets", () => {
    const heroSchema = {
      parse(v: unknown) {
        const b = v as Hero;
        if (typeof b.heading !== "string" || b.heading === "") throw new Error("heading is required");
        return { ...b, heading: b.heading.trim() };
      },
    };
    const seen: string[] = [];
    renderBlocks<Block, null>([{ blockType: "hero", heading: "  Hi  " }], { hero: (b) => { seen.push(b.heading); return null; }, body: () => null }, { schemas: { hero: heroSchema } });
    expect(seen).toEqual(["Hi"]);
    expect(() => renderBlocks<Block, null>([{ blockType: "hero", heading: "" }], { hero: () => null, body: () => null }, { schemas: { hero: heroSchema } })).toThrow(new InvalidBlockError("hero", 0, new Error("heading is required")).message);
  });

  it("no blocks is no output; renderers are typed by the block's slug", () => {
    expect(renderBlocks<Block, string>(null, { hero: () => "h", body: () => "b" })).toEqual([]);
    expect(renderBlocks<Block, string>(undefined, { hero: () => "h", body: () => "b" })).toEqual([]);
    renderBlocks<Block, string>([], {
      hero: (b) => {
        expectTypeOf(b).toEqualTypeOf<Hero>();
        return b.heading;
      },
      body: () => "",
    });
  });
});
