import { Extension } from "@tiptap/core"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"

import { INLINE_TOKEN_RE, getWikiLinkParts } from "./constants"

export interface TagsWikilinksCallbacks {
  onTagClick?: (tag: string) => void
  onWikiLinkClick?: (target: string) => void
  /** Human-readable resolved file path for the link hover tooltip. */
  resolveWikiLinkTarget?: (target: string) => string | null
}

export interface TagsWikilinksOptions {
  // A ref-like holder so callbacks stay fresh without re-instantiating the editor.
  callbacks: { current: TagsWikilinksCallbacks }
}

export const WIKILINK_CONTEXT_EVENT = "amby:wikilink-contextmenu"

export interface WikiLinkContextDetail {
  clientX: number
  clientY: number
  from: number
  to: number
  raw: string
  target: string
  label: string
  hasAlias: boolean
}

function createWikiLinkButton(
  raw: string,
  from: number,
  to: number,
  callbacks: { current: TagsWikilinksCallbacks },
): HTMLElement {
  const { target, label } = getWikiLinkParts(raw)
  const button = document.createElement("button")
  const resolvedTarget = callbacks.current.resolveWikiLinkTarget?.(target) ?? target
  button.type = "button"
  button.className = "amby-live-wikilink-button"
  button.textContent = label
  button.title = resolvedTarget
  button.setAttribute("contenteditable", "false")
  button.setAttribute("aria-label", `Open note ${resolvedTarget}`)
  button.draggable = false

  button.addEventListener("mousedown", (event) => {
    event.preventDefault()
    event.stopPropagation()
  })
  button.addEventListener("click", (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (target) callbacks.current.onWikiLinkClick?.(raw)
  })
  button.addEventListener("contextmenu", (event) => {
    event.preventDefault()
    event.stopPropagation()
    window.dispatchEvent(
      new CustomEvent<WikiLinkContextDetail>(WIKILINK_CONTEXT_EVENT, {
        detail: {
          clientX: event.clientX,
          clientY: event.clientY,
          from,
          to,
          raw,
          target,
          label,
          hasAlias: raw.includes("|"),
        },
      }),
    )
  })
  return button
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
                const from = pos + match.index
                const to = from + match[0].length
                if (match[1]) {
                  decorations.push(Decoration.inline(from, to, { class: "amby-live-tag" }))
                  continue
                }
                const raw = match[2] ?? ""

                // Keep the Markdown token in the document, but render an atom
                // widget over it in Live mode. This gives links button-like
                // behaviour: click navigates, caret cannot land inside it, and
                // Source mode remains the explicit place for raw Markdown edits.
                decorations.push(
                  Decoration.inline(from, to, { class: "amby-live-wikilink-source" }),
                  Decoration.widget(from, () => createWikiLinkButton(raw, from, to, callbacks), {
                    side: -1,
                    key: `wikilink:${from}:${to}:${raw}`,
                  }),
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
                // Pass the full raw inner content so the handler can extract
                // the anchor (#heading / ^block-id) for scroll-on-open.
                if (target) cb.onWikiLinkClick?.(match[2])
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
