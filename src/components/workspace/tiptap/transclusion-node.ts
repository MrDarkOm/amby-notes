import { Node, mergeAttributes } from "@tiptap/core"
import { ReactNodeViewRenderer } from "@tiptap/react"

import { TransclusionView } from "./transclusion-view"

/**
 * Tiptap node for `![[Note Name]]` transclusion embeds.
 *
 * - On disk:  `![[Note Name]]` (Obsidian-compatible)
 * - In editor: renders as a read-only embed card showing the note's content
 * - atom: true — the block cannot be edited in place
 */
export const TransclusionNode = Node.create({
  name: "transclusion",
  group: "block",
  atom: true,

  addAttributes() {
    return {
      target: { default: "" },
      raw: { default: "" },
    }
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-type="transclusion"]',
        getAttrs: (element) => ({
          target: (element as HTMLElement).getAttribute("data-target") ?? "",
          raw: (element as HTMLElement).getAttribute("data-raw") ?? "",
        }),
      },
    ]
  },

  renderHTML({ node, HTMLAttributes }) {
    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "transclusion",
        "data-target": node.attrs.target as string,
        "data-raw": node.attrs.raw as string,
      }),
    ]
  },

  addNodeView() {
    return ReactNodeViewRenderer(TransclusionView)
  },
})
