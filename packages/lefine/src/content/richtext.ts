/**
 * Rich text as Lefine stores it (Lexical JSON), drawn with any `h(tag, props, children)`: lefine/content/react and
 * lefine/content/vue are two such adapters. The node switch ports Payload's lexicalToHtml converters (MIT, Copyright (c)
 * 2018-2026 Payload CMS, LLC), and the output matches the HTML Lefine itself renders (fixtures/richtext-golden.json):
 *  - the node set is closed: a node, mark or attribute outside v1 throws UnsupportedRichTextError, never a silent drop;
 *  - text is a text child (the framework escapes it); there is no raw-HTML node and no pass-through attribute;
 *  - every href and src goes through sanitizeUrl; an internal link needs internalDocToHref, an image needs uploadToSrc.
 */

export const RICH_TEXT_SCHEMA_VERSION = 1;
export const V1_NODE_TYPES = ["paragraph", "heading", "quote", "list", "listitem", "link", "text", "linebreak", "tab", "horizontalrule", "upload"] as const;
const HEADING_TAGS = ["h2", "h3", "h4"];
/** bold | italic | strikethrough | underline | code */
const V1_TEXT_FORMAT_MASK = 1 | 2 | 4 | 8 | 16;

export class UnsupportedRichTextError extends Error {
  readonly path: string;
  constructor(message: string, path: string) {
    super(`${message} (at ${path})`);
    this.name = "UnsupportedRichTextError";
    this.path = path;
  }
}

/** An internal link as stored: `fields.doc` names the page it points to. */
export interface RichTextLink {
  type: "link";
  fields: { linkType: "custom" | "internal"; url?: string; newTab?: boolean; doc?: { relationTo: string; value: string } | null };
  children: unknown[];
}
/** An image from the media library: `value` is the media id. */
export interface RichTextUpload {
  type: "upload";
  relationTo: string;
  value: string;
  fields: { alt?: string; [k: string]: unknown } | null;
}

export interface RichTextOptions {
  /** Where an internal link goes. Required to draw one: without it, rendering throws. */
  internalDocToHref?: (link: RichTextLink) => string;
  /** The URL of a library image. Required to draw an image: without it, rendering throws. */
  uploadToSrc?: (node: RichTextUpload) => string;
}

/** What an adapter gives: make an element, or pass a string through. Children are elements or strings. */
export type Hyperscript<N> = (tag: string, props: Record<string, string | number> | null, children: Array<N | string>, key: number) => N;

type AnyNode = Record<string, unknown> & { type: string; children?: AnyNode[] };
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const known = new Set<string>(V1_NODE_TYPES);

/** Sanitizes a URL: web, mail, tel, relative and fragment addresses pass; any other scheme (javascript:, data:) becomes "#". */
export function sanitizeUrl(url: string): string {
  if (!url) return "";
  // eslint-disable-next-line no-control-regex
  const cleaned = url.trim().replace(/[\x00-\x1f\x7f]/g, "");
  if (cleaned.startsWith("#") || cleaned.startsWith("/") || cleaned.startsWith("./") || cleaned.startsWith("../")) return cleaned;
  const protocol = cleaned.match(/^([a-z][a-z0-9+\-.]*):/i)?.[1]?.toLowerCase();
  if (protocol && protocol !== "http" && protocol !== "https" && protocol !== "mailto" && protocol !== "tel") return "#";
  return cleaned;
}

function check(node: unknown, path: string): void {
  if (!isObject(node) || typeof node.type !== "string") throw new UnsupportedRichTextError("not a node", path);
  const type = node.type;
  if (!known.has(type)) throw new UnsupportedRichTextError(`unknown node type "${type}"`, path);
  if (type === "text" || type === "tab") {
    if (typeof node.text !== "string") throw new UnsupportedRichTextError("text node without text", path);
    const format = typeof node.format === "number" ? node.format : 0;
    if (format & ~V1_TEXT_FORMAT_MASK) throw new UnsupportedRichTextError(`text format ${format} uses a mark outside v1 (subscript, superscript, highlight)`, path);
    if (typeof node.style === "string" && node.style !== "") throw new UnsupportedRichTextError(`text style "${node.style}" (text colour is not in v1)`, path);
    return;
  }
  if (type === "linebreak" || type === "horizontalrule") return;
  if (type === "upload") {
    if (typeof node.relationTo !== "string" || typeof node.value !== "string") throw new UnsupportedRichTextError("upload node without relationTo and value", path);
    return;
  }
  if (typeof node.format === "string" && node.format !== "") throw new UnsupportedRichTextError(`alignment "${node.format}" is not in v1`, path);
  if (typeof node.indent === "number" && node.indent !== 0 && type !== "listitem") throw new UnsupportedRichTextError("indent is not in v1", path);
  if (type === "heading" && !HEADING_TAGS.includes(node.tag as string)) throw new UnsupportedRichTextError(`heading tag "${String(node.tag)}" (v1 has h2 to h4)`, path);
  if (type === "list" && node.listType !== "bullet" && node.listType !== "number") throw new UnsupportedRichTextError(`list type "${String(node.listType)}" (v1 has bulleted and numbered)`, path);
  if (type === "link" && (!isObject(node.fields) || (node.fields.linkType !== "custom" && node.fields.linkType !== "internal"))) throw new UnsupportedRichTextError("link without a valid linkType", path);
  if (!Array.isArray(node.children)) throw new UnsupportedRichTextError(`${type} node without children`, path);
  node.children.forEach((child, i) => check(child, `${path}.children[${i}]`));
}

/** The document's top nodes, checked against v1 (throws at the first node outside it). Null, undefined or an empty document: []. */
export function richTextNodes(value: unknown): AnyNode[] {
  if (value === null || value === undefined) return [];
  if (!isObject(value) || !isObject(value.root) || value.root.type !== "root" || !Array.isArray(value.root.children)) throw new UnsupportedRichTextError("not a rich text document", "$");
  if (value.schemaVersion !== undefined && value.schemaVersion !== RICH_TEXT_SCHEMA_VERSION) {
    throw new UnsupportedRichTextError(`schemaVersion ${String(value.schemaVersion)} is newer than this version of lefine (${RICH_TEXT_SCHEMA_VERSION}); update lefine`, "$.schemaVersion");
  }
  const children = value.root.children as AnyNode[];
  children.forEach((child, i) => check(child, `$.root.children[${i}]`));
  // One empty paragraph is an empty document (Lexical's empty editor).
  const only = children[0];
  if (children.length === 0 || (children.length === 1 && only?.type === "paragraph" && (!only.children?.length || (only.children.length === 1 && only.children[0]?.type === "text" && !only.children[0].text)))) return [];
  return children;
}

const MARKS: Array<[number, string]> = [[1, "strong"], [2, "em"], [4, "s"], [8, "u"], [16, "code"]];

/** Draws checked nodes (from richTextNodes) with `h`. Mark nesting, tags and attributes match lefine's lexicalToHtml. */
export function renderRichText<N>(nodes: readonly AnyNode[], h: Hyperscript<N>, options: RichTextOptions = {}, path = "$.root.children"): Array<N | string> {
  return nodes.map((node, i) => drawNode(node, h, options, `${path}[${i}]`, i));
}

function drawNode<N>(node: AnyNode, h: Hyperscript<N>, options: RichTextOptions, path: string, key: number): N | string {
  const children = () => renderRichText(node.children ?? [], h, options, `${path}.children`);
  switch (node.type) {
    case "text": {
      const format = typeof node.format === "number" ? node.format : 0;
      const marks = MARKS.filter(([bit]) => format & bit).map(([, tag]) => tag);
      // Bold innermost, code outermost; the outermost element carries the key.
      return marks.reduce<N | string>((out, tag, i) => h(tag, null, [out], i === marks.length - 1 ? key : 0), node.text as string);
    }
    case "tab":
      return "\t";
    case "linebreak":
      return h("br", null, [], key);
    case "paragraph": {
      const inner = children();
      return h("p", null, inner.length === 0 ? [h("br", null, [], 0)] : inner, key);
    }
    case "heading":
      return h(node.tag as string, null, children(), key);
    case "quote":
      return h("blockquote", null, children(), key);
    case "list": {
      const tag = node.listType === "number" ? "ol" : "ul";
      const start = node.start as number;
      return h(tag, tag === "ol" && Number.isInteger(start) && start > 1 ? { start } : null, children(), key);
    }
    case "listitem": {
      // Lexical nests a sub-list as its own listitem holding only the list (Payload's `nestedListItem`).
      const nested = (node.children ?? []).length > 0 && (node.children ?? []).every((c) => c.type === "list");
      return h("li", nested ? { class: "nested" } : null, children(), key);
    }
    case "horizontalrule":
      return h("hr", null, [], key);
    case "link": {
      const link = node as unknown as RichTextLink;
      let href: string;
      if (link.fields.linkType === "internal") {
        if (!options.internalDocToHref) throw new UnsupportedRichTextError("internal link but no internalDocToHref was given", path);
        href = options.internalDocToHref(link);
      } else {
        href = link.fields.url ?? "";
      }
      return h("a", { href: sanitizeUrl(href), ...(link.fields.newTab ? { rel: "noopener noreferrer", target: "_blank" } : {}) }, children(), key);
    }
    case "upload": {
      const upload = node as unknown as RichTextUpload;
      if (!options.uploadToSrc) throw new UnsupportedRichTextError("image node but no uploadToSrc was given", path);
      return h("img", { src: sanitizeUrl(options.uploadToSrc(upload)), alt: typeof upload.fields?.alt === "string" ? upload.fields.alt : "" }, [], key);
    }
    default:
      throw new UnsupportedRichTextError(`unknown node type "${node.type}"`, path);
  }
}
