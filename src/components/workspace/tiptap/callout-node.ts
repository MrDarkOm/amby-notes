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
      bgColor: { default: null as string | null },
      headerSuffix: { default: "" },
      headerPrefix: { default: "" },
      headerContentInBody: { default: false },
      headerBodyTight: { default: false },
      hasRawHeader: { default: false },
    }
  },

  parseHTML() {
    return [
      {
        tag: "div[data-type=callout]",
        getAttrs: (el) => {
          const div = el as HTMLElement
          return {
            calloutType: div.getAttribute("data-callout-type") ?? "NOTE",
            emoji: div.getAttribute("data-emoji") ?? "💡",
            bgColor: div.getAttribute("data-bg"),
            headerSuffix: div.getAttribute("data-header-suffix") ?? "",
            headerPrefix: div.getAttribute("data-header-prefix") ?? "",
            headerContentInBody: div.getAttribute("data-header-content-in-body") === "true",
            headerBodyTight: div.getAttribute("data-header-body-tight") === "true",
            hasRawHeader: div.getAttribute("data-has-raw-header") === "true",
          }
        },
      },
    ]
  },

  renderHTML({ HTMLAttributes, node }) {
    const extras: Record<string, string> = {
      "data-type": "callout",
      "data-callout-type": node.attrs.calloutType,
      "data-emoji": node.attrs.emoji,
    }
    if (node.attrs.bgColor) extras["data-bg"] = node.attrs.bgColor
    if (node.attrs.hasRawHeader) {
      extras["data-header-suffix"] = node.attrs.headerSuffix
      extras["data-header-prefix"] = node.attrs.headerPrefix
      if (node.attrs.headerContentInBody) extras["data-header-content-in-body"] = "true"
      if (node.attrs.headerBodyTight) extras["data-header-body-tight"] = "true"
      extras["data-has-raw-header"] = "true"
    }
    return ["div", mergeAttributes(HTMLAttributes, extras), 0]
  },

  addNodeView() {
    return ReactNodeViewRenderer(CalloutView)
  },
})
