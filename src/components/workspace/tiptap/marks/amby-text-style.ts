import { Mark, mergeAttributes } from "@tiptap/core"

import { HEX_RE, parseSafeStyle, styleAttrsToCss } from "../constants"

export interface AmbyTextStyleAttrs {
  color: string | null
  backgroundColor: string | null
}

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    ambyTextStyle: {
      setAmbyTextStyle: (attrs: Partial<AmbyTextStyleAttrs>) => ReturnType
      unsetAmbyTextStyle: () => ReturnType
    }
  }
}

function normalizeHex(value: unknown): string | null {
  return typeof value === "string" && HEX_RE.test(value) ? value : null
}

// Inline mark holding hex color / background-color. In-editor it renders as a
// styled <span>; on disk it is serialized by the markdown layer (see markdown.ts).
export const AmbyTextStyle = Mark.create({
  name: "ambyTextStyle",
  priority: 80,

  addAttributes() {
    return {
      color: {
        default: null,
        parseHTML: (el) => normalizeHex(el.style.color || el.getAttribute("data-color")),
        renderHTML: () => ({}),
      },
      backgroundColor: {
        default: null,
        parseHTML: (el) => normalizeHex(el.style.backgroundColor),
        renderHTML: () => ({}),
      },
    }
  },

  parseHTML() {
    return [
      {
        tag: "span[style]",
        getAttrs: (node) => {
          if (!(node instanceof HTMLElement)) return false
          const attrs = parseSafeStyle(node.getAttribute("style") ?? "")
          return attrs.color || attrs.backgroundColor
            ? { color: attrs.color ?? null, backgroundColor: attrs.backgroundColor ?? null }
            : false
        },
      },
    ]
  },

  renderHTML({ mark, HTMLAttributes }) {
    const attrs = mark.attrs as AmbyTextStyleAttrs
    const style = styleAttrsToCss(attrs)
    return [
      "span",
      mergeAttributes(
        HTMLAttributes,
        style ? { style } : {},
        attrs.color ? { "data-amby-color": attrs.color } : {},
        attrs.backgroundColor ? { "data-amby-highlight": attrs.backgroundColor } : {},
      ),
      0,
    ]
  },

  addCommands() {
    return {
      setAmbyTextStyle:
        (attrs) =>
        ({ chain, editor }) => {
          const current = editor.getAttributes(this.name) as Partial<AmbyTextStyleAttrs>
          const next: AmbyTextStyleAttrs = {
            color: normalizeHex(attrs.color !== undefined ? attrs.color : current.color),
            backgroundColor: normalizeHex(
              attrs.backgroundColor !== undefined ? attrs.backgroundColor : current.backgroundColor,
            ),
          }
          if (!next.color && !next.backgroundColor) {
            return chain().unsetMark(this.name).run()
          }
          return chain().setMark(this.name, next).run()
        },
      unsetAmbyTextStyle:
        () =>
        ({ chain }) =>
          chain().unsetMark(this.name).run(),
    }
  },
})
