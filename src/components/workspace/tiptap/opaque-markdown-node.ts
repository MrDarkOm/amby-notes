import { Node, mergeAttributes } from "@tiptap/core"

import { displayMathSource, renderMath } from "./rendered-source"

// Portable Markdown blocks the editor does not rebuild stay atomic in the visual
// document: their raw source is the block. Display math (`$$ … $$`) is drawn as a
// formula over that source; the source itself shows when the block is selected and is
// changed in Source mode, like every block of this kind.
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

  addNodeView() {
    return ({ node }) => {
      let current = node
      const source = document.createElement("pre")
      source.className = "amby-opaque-markdown"

      // Anything but math is its source text, as `renderHTML` writes it.
      if (node.attrs.kind !== "math") {
        source.setAttribute("data-amby-opaque-markdown", String(node.attrs.kind))
        source.textContent = String(node.attrs.value ?? "")
        return {
          dom: source,
          update(next) {
            if (next.type !== current.type || next.attrs.kind === "math") return false
            current = next
            source.setAttribute("data-amby-opaque-markdown", String(next.attrs.kind))
            source.textContent = String(next.attrs.value ?? "")
            return true
          },
          ignoreMutation: () => true,
        }
      }

      const dom = document.createElement("div")
      dom.className = "amby-math-block"
      dom.setAttribute("data-amby-opaque-markdown", "math")
      const formula = document.createElement("div")
      formula.className = "amby-math-render"
      dom.append(formula, source)

      const draw = () => {
        const value = String(current.attrs.value ?? "")
        source.textContent = value
        dom.classList.remove("is-drawn")
        void renderMath(displayMathSource(value), formula, true).then((drawn) => {
          // The block may have changed while the library was loading.
          if (drawn && String(current.attrs.value ?? "") === value) dom.classList.add("is-drawn")
        })
      }
      draw()

      return {
        dom,
        update(next) {
          if (next.type !== current.type || next.attrs.kind !== "math") return false
          const changed = next.attrs.value !== current.attrs.value
          current = next
          if (changed) draw()
          return true
        },
        selectNode: () => dom.classList.add("is-selected"),
        deselectNode: () => dom.classList.remove("is-selected"),
        ignoreMutation: () => true,
      }
    }
  },
})
