import { Node, mergeAttributes } from "@tiptap/core"

export function columnTemplate(widths: unknown): string | null {
  if (typeof widths !== "string") return null
  const values = widths
    .split(",")
    .map(Number)
    .filter((value) => Number.isFinite(value) && value > 0)
  if (values.length < 2) return null
  return values.map((value) => `minmax(0, ${value}fr)`).join(" ")
}

export const Column = Node.create({
  name: "column",
  content: "block+",
  isolating: true,

  parseHTML() {
    return [{ tag: "div[data-type=amby-column]", contentElement: ".amby-column-content" }]
  },

  renderHTML({ HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "amby-column",
        class: "amby-column",
      }),
      ["div", { class: "amby-column-content" }, 0],
    ]
  },
})

export const ColumnSet = Node.create({
  name: "columnSet",
  group: "block",
  content: "column{2,}",
  defining: true,
  isolating: true,

  addAttributes() {
    return {
      widths: {
        default: null as string | null,
        parseHTML: (element) => element.getAttribute("data-widths"),
        renderHTML: () => ({}),
      },
    }
  },

  parseHTML() {
    return [{ tag: "div[data-type=amby-columns]" }]
  },

  renderHTML({ HTMLAttributes, node }) {
    const template = columnTemplate(node.attrs.widths)
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "amby-columns",
        ...(node.attrs.widths ? { "data-widths": node.attrs.widths } : {}),
        ...(template ? { style: `grid-template-columns: ${template}` } : {}),
        class: "amby-column-set",
      }),
      0,
    ]
  },
})
