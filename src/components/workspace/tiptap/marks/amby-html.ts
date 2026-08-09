import { Node, mergeAttributes } from "@tiptap/core"

// Inline atom node preserving arbitrary inline HTML that is not one of the
// recognized styled spans / underlines. Keeps unknown HTML round-tripping
// instead of silently dropping it.
export const AmbyHtml = Node.create({
  name: "ambyHtml",
  group: "inline",
  inline: true,
  atom: true,
  selectable: false,

  addAttributes() {
    return {
      value: { default: "" },
    }
  },

  parseHTML() {
    return [
      {
        tag: "span[data-amby-html]",
        getAttrs: (node) =>
          node instanceof HTMLElement
            ? { value: node.getAttribute("data-amby-html") ?? "" }
            : false,
      },
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "span",
      mergeAttributes(HTMLAttributes, { "data-amby-html": node.attrs.value }),
      node.attrs.value,
    ]
  },
})
