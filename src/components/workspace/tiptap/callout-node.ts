import { Node, mergeAttributes } from "@tiptap/core"
import { ReactNodeViewRenderer } from "@tiptap/react"

import { CalloutView } from "./CalloutView"

export const CALLOUT_DEFAULTS: Record<string, string> = {
  NOTE: "💡",
  WARNING: "⚠️",
  INFO: "ℹ️",
  TIP: "✅",
  DANGER: "🔥",
}

/**
 * First-class callout / admonition node.
 *
 * On disk the format is:  `> [!NOTE] 💡\n> content`
 * (handled by the detectCallouts markdown-it rule in markdown.ts)
 *
 * Attributes:
 *   calloutType — NOTE | WARNING | INFO | TIP | DANGER
 *   emoji       — any single emoji (user-editable via the picker in CalloutView)
 */
export const CalloutNode = Node.create({
  name: "callout",
  group: "block",
  content: "block+",
  defining: true,

  addAttributes() {
    return {
      calloutType: { default: "NOTE" },
      emoji: { default: "💡" },
    }
  },

  parseHTML() {
    return [
      {
        tag: "div[data-type=callout]",
        getAttrs: el => {
          const div = el as HTMLElement
          return {
            calloutType: div.getAttribute("data-callout-type") ?? "NOTE",
            emoji: div.getAttribute("data-emoji") ?? "💡",
          }
        },
      },
    ]
  },

  renderHTML({ HTMLAttributes, node }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "callout",
        "data-callout-type": node.attrs.calloutType,
        "data-emoji": node.attrs.emoji,
      }),
      0,
    ]
  },

  addNodeView() {
    return ReactNodeViewRenderer(CalloutView)
  },
})
