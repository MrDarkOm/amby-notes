import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"

import { INLINE_TOKEN_RE, getWikiLinkParts } from "./constants"

export interface TagsWikilinksCallbacks {
  onTagClick?: (tag: string) => void
  onWikiLinkClick?: (target: string) => void
}

export interface TagsWikilinksOptions {
  // A ref-like holder so callbacks stay fresh without re-instantiating the editor.
  callbacks: { current: TagsWikilinksCallbacks }
}

// Decorates #tags and [[wikilinks]] in text nodes and makes them clickable.
// Active in both editable and read-only editors.
export const TagsWikilinks = Extension.create<TagsWikilinksOptions>({
  name: "tagsWikilinks",

  addOptions() {
    return {
      callbacks: { current: {} },
    }
  },

  addProseMirrorPlugins() {
    const { callbacks } = this.options

    return [
      new Plugin({
        key: new PluginKey("amby-tags-wikilinks"),
        props: {
          decorations(state) {
            const decorations: Decoration[] = []
            state.doc.descendants((node, pos) => {
              if (!node.isText || !node.text) return
              INLINE_TOKEN_RE.lastIndex = 0
              let match: RegExpExecArray | null
              while ((match = INLINE_TOKEN_RE.exec(node.text)) !== null) {
                decorations.push(
                  Decoration.inline(pos + match.index, pos + match.index + match[0].length, {
                    class: match[1] ? "amby-live-tag" : "amby-live-wikilink",
                  })
                )
              }
            })
            return DecorationSet.create(state.doc, decorations)
          },
          handleClickOn(_view, pos, node, nodePos) {
            if (!node.isText || !node.text) return false
            const offset = pos - nodePos
            INLINE_TOKEN_RE.lastIndex = 0
            let match: RegExpExecArray | null
            while ((match = INLINE_TOKEN_RE.exec(node.text)) !== null) {
              const start = match.index
              const end = match.index + match[0].length
              if (offset < start || offset > end) continue
              const cb = callbacks.current
              if (match[1]) {
                cb.onTagClick?.(match[1])
              } else if (match[2]) {
                const { target } = getWikiLinkParts(match[2])
                if (target) cb.onWikiLinkClick?.(target)
              }
              return true
            }
            return false
          },
        },
      }),
    ]
  },
})
