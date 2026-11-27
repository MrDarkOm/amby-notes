import { Extension } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { Plugin, PluginKey, Selection, TextSelection } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"

/** Obsidian-compatible block IDs stay in Markdown, but are not visible note text. */
export function blockAnchorSuffix(node: PMNode): { id: string; offset: number } | null {
  if (!node.isTextblock || node.type.spec.code || !node.lastChild?.isText) return null
  const match = /(?:^|\s)\^([A-Za-z0-9-]+)[ \t]*$/u.exec(node.textContent)
  return match ? { id: match[1], offset: node.content.size - match[0].length } : null
}

function anchorDecorations(doc: PMNode): DecorationSet {
  const decorations: Decoration[] = []
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    const anchor = blockAnchorSuffix(node)
    if (anchor) {
      decorations.push(
        Decoration.node(pos, pos + node.nodeSize, { "data-block-id": anchor.id }),
        Decoration.inline(pos + 1 + anchor.offset, pos + 1 + node.content.size, {
          class: "amby-block-anchor-marker",
        }),
      )
    }
    return false
  })
  return DecorationSet.create(doc, decorations)
}

const blockAnchorsKey = new PluginKey<DecorationSet>("blockAnchors")

export const BlockAnchors = Extension.create({
  name: "blockAnchors",
  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: blockAnchorsKey,
        state: {
          init: (_config, state) => anchorDecorations(state.doc),
          apply: (tr, previous) => (tr.docChanged ? anchorDecorations(tr.doc) : previous),
        },
        // End/click must leave typing before the invisible ID, so the next word
        // cannot turn the marker into visible text or break the copied link.
        appendTransaction(_transactions, _previous, state) {
          if (!state.selection.empty) return null
          const { $from } = state.selection
          const anchor = blockAnchorSuffix($from.parent)
          if (!anchor || $from.parentOffset <= anchor.offset) return null
          return state.tr
            .setSelection(TextSelection.create(state.doc, $from.start() + anchor.offset))
            .setMeta("addToHistory", false)
        },
        props: {
          decorations: (state) => blockAnchorsKey.getState(state),
          handleKeyDown(view, event) {
            if (
              event.key !== "ArrowRight" ||
              event.shiftKey ||
              event.metaKey ||
              event.ctrlKey ||
              event.altKey ||
              !view.state.selection.empty
            )
              return false
            const { $from } = view.state.selection
            const anchor = blockAnchorSuffix($from.parent)
            if (!anchor || $from.parentOffset !== anchor.offset) return false
            const next = Selection.findFrom(view.state.doc.resolve($from.after()), 1, true)
            if (next) view.dispatch(view.state.tr.setSelection(next).scrollIntoView())
            return true
          },
        },
      }),
    ]
  },
})
