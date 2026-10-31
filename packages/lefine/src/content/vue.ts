/**
 * `lefine/content/vue`: rich text in a Vue 3 app. `<RichText :data="page.body" />` draws the same tags as
 * Lefine's own rich text HTML; the closed node set, sanitizing and required resolvers are in ./richtext.ts. Vue escapes the text.
 */
import { type PropType, type VNode, type VNodeChild, defineComponent, h } from "vue";
import { type RichTextLink, type RichTextOptions, type RichTextUpload, renderRichText, richTextNodes } from "./richtext.js";

export { UnsupportedRichTextError, sanitizeUrl, type RichTextLink, type RichTextOptions, type RichTextUpload } from "./richtext.js";

/** A stored document as Vue nodes (the wrapper's children). Throws on anything outside v1. */
export function richTextToVNodes(data: unknown, options: RichTextOptions = {}): VNodeChild[] {
  return renderRichText<VNode>(richTextNodes(data), (tag, props, children) => h(tag, props, children), options);
}

/**
 * The wrapper is `<div class="richtext">` (`class-name` changes it, `disable-container` drops it). A document outside v1 throws
 * while rendering; catch it with onErrorCaptured, as any render error.
 */
export const RichText = defineComponent({
  name: "LefineRichText",
  props: {
    /** The stored document (Lexical JSON), or null. */
    data: { type: Object as PropType<object | null>, default: null },
    className: { type: String, default: "richtext" },
    disableContainer: { type: Boolean, default: false },
    internalDocToHref: { type: Function as PropType<(link: RichTextLink) => string>, default: undefined },
    uploadToSrc: { type: Function as PropType<(node: RichTextUpload) => string>, default: undefined },
  },
  setup(props) {
    return (): VNode | VNodeChild[] => {
      const options: RichTextOptions = {};
      if (props.internalDocToHref) options.internalDocToHref = props.internalDocToHref;
      if (props.uploadToSrc) options.uploadToSrc = props.uploadToSrc;
      const nodes = richTextToVNodes(props.data, options);
      return props.disableContainer ? nodes : h("div", { class: props.className }, nodes);
    };
  },
});
