import { Node, mergeAttributes } from "@tiptap/core"

// Portable Markdown blocks that need a dedicated renderer later (currently
// display math) stay atomic in the visual document. This preserves their raw
// source without treating TeX commands as ordinary Markdown escapes.
export const OpaqueMarkdownBlock = Node.create({
  name: "opaqueMarkdownBlock",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      kind: { default: "source" },
      value: { default: "" },
    }
  },

  parseHTML() {
    return [
      {
        tag: "pre[data-amby-opaque-markdown]",
        getAttrs: (node) =>
          node instanceof HTMLElement
            ? {
                kind: node.getAttribute("data-amby-opaque-markdown") ?? "source",
                value: node.textContent ?? "",
              }
            : false,
      },
    ]
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      "pre",
      mergeAttributes(HTMLAttributes, {
        "data-amby-opaque-markdown": node.attrs.kind,
        class: "amby-opaque-markdown",
      }),
      node.attrs.value,
    ]
  },
})
