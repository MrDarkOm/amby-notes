import { Node, mergeAttributes } from "@tiptap/core"

// A block-level raw HTML token. It is intentionally an atom: Live Preview may
// show and move it, but does not parse, execute, or rewrite user HTML. Keeping
// the original source as one attribute lets the Markdown serializer put back
// precisely the bytes markdown-it recognized as the HTML block.
export const OpaqueHtmlBlock = Node.create({
  name: "opaqueHtmlBlock",
  group: "block",
  atom: true,
  selectable: true,

  addAttributes() {
    return {
      value: { default: "" },
    }
  },

  parseHTML() {
    return [
      {
        tag: "pre[data-amby-opaque-html]",
        getAttrs: (node) =>
          node instanceof HTMLElement ? { value: node.textContent ?? "" } : false,
      },
    ]
  },

  renderHTML({ HTMLAttributes, node }) {
    // The string content is rendered as text, not injected HTML. This avoids
    // executing a script/iframe merely because a user opened a Markdown note.
    return [
      "pre",
      mergeAttributes(HTMLAttributes, {
        "data-amby-opaque-html": "true",
        class: "amby-opaque-html",
      }),
      node.attrs.value,
    ]
  },
})
