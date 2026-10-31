/**
 * `lefine/content/react`: rich text in a React app. `<RichText data={page.body} />` draws the same tags as lefine's
 * lexicalToHtml; the closed node set, sanitizing and required resolvers are in ./richtext.ts. React escapes the text.
 */
import { createElement, type ReactNode } from "react";
import { type RichTextOptions, renderRichText, richTextNodes } from "./richtext.js";

export { UnsupportedRichTextError, sanitizeUrl, type RichTextLink, type RichTextOptions, type RichTextUpload } from "./richtext.js";

/** React's attribute name for `class`. */
const reactProps = (props: Record<string, string | number> | null, key: number) => {
  if (!props) return { key };
  const { class: className, ...rest } = props;
  return { key, ...rest, ...(className !== undefined ? { className } : {}) };
};

/** A stored document as React nodes (the wrapper's children). Throws on anything outside v1. */
export function richTextToReact(data: unknown, options: RichTextOptions = {}): ReactNode[] {
  return renderRichText<ReactNode>(richTextNodes(data), (tag, props, children, key) => createElement(tag, reactProps(props, key), ...(children.length > 0 ? [children] : [])), options);
}

export interface RichTextProps extends RichTextOptions {
  /** The stored document (Lexical JSON), or null. */
  data: unknown;
  /** Class of the wrapper div. Default "richtext". */
  className?: string;
  /** No wrapper div. */
  disableContainer?: boolean;
}

/** A document outside v1 throws while rendering: an error boundary catches it, as any render error. */
export function RichText({ data, className = "richtext", disableContainer = false, internalDocToHref, uploadToSrc }: RichTextProps) {
  const nodes = richTextToReact(data, { ...(internalDocToHref ? { internalDocToHref } : {}), ...(uploadToSrc ? { uploadToSrc } : {}) });
  return disableContainer ? <>{nodes}</> : <div className={className}>{nodes}</div>;
}
