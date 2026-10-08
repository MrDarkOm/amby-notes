import { Extension } from "@tiptap/core"
import type { Node as PMNode } from "@tiptap/pm/model"
import { Plugin, PluginKey, type Transaction } from "@tiptap/pm/state"
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view"
import { animate } from "motion/react"

import { motionTransition, motionTransitions } from "@/lib/motion-config"
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
  /** Reveal the real `[[wikilink]]` text while its caret is active in Linear Live. */
  isSourceSyntaxVisible: () => boolean
  /** Linear Live uses click-to-edit and modifier-click-to-open, like Obsidian. */
  isSourceSyntaxEditingAvailable: () => boolean
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

interface TokenRange {
  from: number
  to: number
}

// A token's place in the note changes as text is typed above it, while its decoration is
// kept and only moved. Positions are therefore never written into the DOM: they are
// asked for at the moment they are needed.
const widgetRanges = new WeakMap<HTMLElement, () => TokenRange | null>()

/** Where a decorated `#tag` or `[[wikilink]]` element stands in the note right now. */
export function inlineTokenRange(view: EditorView, token: HTMLElement): TokenRange | null {
  const ofWidget = widgetRanges.get(token)
  if (ofWidget) return ofWidget()
  const length = Number(token.dataset.ambyLength)
  if (!Number.isInteger(length) || length <= 0) return null
  try {
    const from = view.posAtDOM(token, 0)
    return { from, to: from + length }
  } catch {
    return null
  }
}

function createWikiLinkButton(
  raw: string,
  range: () => TokenRange | null,
  callbacks: { current: TagsWikilinksCallbacks },
  editSource?: (range: TokenRange) => void,
): HTMLElement {
  const { target, label } = getWikiLinkParts(raw)
  const button = document.createElement("button")
  const resolvedTarget = callbacks.current.resolveWikiLinkTarget?.(target) ?? target
  const targetName = target.replace(/\\/gu, "/").split("/").pop() ?? target
  const visibleLabel = raw.includes("|") && label !== target ? label : targetName
  button.type = "button"
  button.className = "amby-live-wikilink-button"
  button.textContent = visibleLabel
  button.title = resolvedTarget
  button.dataset.ambyInlineUnlink = "true"
  button.dataset.ambyReplacement = label
  button.dataset.ambySource = `[[${raw}]]`
  widgetRanges.set(button, range)
  button.setAttribute("contenteditable", "false")
  button.setAttribute("aria-label", `Open note ${resolvedTarget}`)
  button.draggable = false

  button.addEventListener("pointerenter", () => {
    animate(
      button,
      {
        y: -1,
        backgroundColor: "color-mix(in srgb, var(--wikilink-bg) 65%, var(--wikilink-fg))",
        borderColor: "var(--wikilink-fg)",
        color: "var(--link-hover-color)",
      },
      motionTransition(motionTransitions.default),
    )
  })
  button.addEventListener("pointerleave", () => {
    animate(
      button,
      {
        y: 0,
        backgroundColor: "var(--wikilink-bg)",
        borderColor: "var(--wikilink-underline)",
        color: "var(--wikilink-fg)",
      },
      motionTransition(motionTransitions.default),
    )
  })

  button.addEventListener("mousedown", (event) => {
    event.preventDefault()
    event.stopPropagation()
    const at = range()
    if (editSource && at && !event.metaKey && !event.ctrlKey) editSource(at)
  })
  button.addEventListener("click", (event) => {
    event.preventDefault()
    event.stopPropagation()
    if (editSource && !event.metaKey && !event.ctrlKey) return
    if (target) callbacks.current.onWikiLinkClick?.(raw)
  })
  button.addEventListener("contextmenu", (event) => {
    event.preventDefault()
    event.stopPropagation()
    const at = range()
    if (!at) return
    const { from, to } = at
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

export const tagsWikilinksKey = new PluginKey<DecorationSet>("amby-tags-wikilinks")

/**
 * The text blocks an edit touched, in the new document. Tokens are found per text node
 * and an edit can change where the text nodes of its block begin and end, so the whole
 * block is looked at again; every other block keeps the decorations it had.
 */
export function changedTextRanges(tr: Transaction): TokenRange[] {
  const touched: TokenRange[] = []
  tr.steps.forEach((step, index) => {
    const rest = tr.mapping.slice(index + 1)
    let mapped = false
    tr.mapping.maps[index].forEach((_oldStart, _oldEnd, newStart, newEnd) => {
      mapped = true
      touched.push({ from: rest.map(newStart, -1), to: rest.map(newEnd, 1) })
    })
    // Adding or removing a mark moves no text but splits and joins text nodes.
    const { from, to } = step as { from?: unknown; to?: unknown }
    if (!mapped && typeof from === "number" && typeof to === "number") {
      touched.push({ from: rest.map(from, -1), to: rest.map(to, 1) })
    }
  })
  const size = tr.doc.content.size
  const ranges = touched
    .map((range) => {
      const from = Math.max(0, Math.min(range.from, size))
      const to = Math.max(from, Math.min(range.to, size))
      const $from = tr.doc.resolve(from)
      const $to = tr.doc.resolve(to)
      return {
        from: $from.parent.isTextblock ? $from.start() : from,
        to: $to.parent.isTextblock ? $to.end() : to,
      }
    })
    .sort((a, b) => a.from - b.from)
  const merged: TokenRange[] = []
  for (const range of ranges) {
    const last = merged[merged.length - 1]
    if (last && range.from <= last.to) last.to = Math.max(last.to, range.to)
    else merged.push(range)
  }
  return merged
}

// Decorates #tags and [[wikilinks]] in text nodes and makes them clickable.
// Active in both editable and read-only editors.
export const TagsWikilinks = Extension.create<TagsWikilinksOptions>({
  name: "tagsWikilinks",

  addOptions() {
    return {
      callbacks: { current: {} },
      isSourceSyntaxVisible: () => false,
      isSourceSyntaxEditingAvailable: () => false,
    }
  },

  addProseMirrorPlugins() {
    const { callbacks, isSourceSyntaxVisible, isSourceSyntaxEditingAvailable } = this.options
    const editor = this.editor

    /** Decorations for the tokens of every text node between two positions. */
    const decorate = (doc: PMNode, from: number, to: number, caret: number): Decoration[] => {
      const decorations: Decoration[] = []
      doc.nodesBetween(from, to, (node, pos) => {
        if (!node.isText || !node.text) return
        INLINE_TOKEN_RE.lastIndex = 0
        let match: RegExpExecArray | null
        while ((match = INLINE_TOKEN_RE.exec(node.text)) !== null) {
          const start = pos + match.index
          const end = start + match[0].length
          if (match[1]) {
            decorations.push(
              Decoration.inline(start, end, {
                class: "amby-live-tag",
                "data-amby-inline-unlink": "true",
                "data-amby-length": String(match[0].length),
                "data-amby-source": match[0],
                "data-amby-replacement": match[1],
              }),
            )
            continue
          }
          const raw = match[2] ?? ""
          if (isSourceSyntaxVisible() && caret >= start && caret <= end) {
            decorations.push(Decoration.inline(start, end, { class: "amby-live-wikilink-editing" }))
            continue
          }

          // Keep the Markdown token in the document, but render an atom
          // widget over it in Live mode. This gives links button-like
          // behaviour: click navigates, caret cannot land inside it, and
          // Source mode remains the explicit place for raw Markdown edits.
          const length = match[0].length
          decorations.push(
            Decoration.inline(start, end, { class: "amby-live-wikilink-source" }),
            Decoration.widget(
              start,
              (_view, getPos) =>
                createWikiLinkButton(
                  raw,
                  () => {
                    const at = getPos()
                    return typeof at === "number" ? { from: at, to: at + length } : null
                  },
                  callbacks,
                  isSourceSyntaxEditingAvailable()
                    ? (at) => {
                        editor
                          .chain()
                          .focus()
                          .setTextSelection(Math.min(at.from + 2, at.to))
                          .run()
                      }
                    : undefined,
                ),
              // The same link drawn again (its paragraph was edited) keeps its button.
              { side: -1, key: `wikilink:${raw}` },
            ),
          )
        }
      })
      return decorations
    }

    return [
      new Plugin<DecorationSet>({
        key: tagsWikilinksKey,
        state: {
          init: (_config, state) =>
            DecorationSet.create(
              state.doc,
              decorate(state.doc, 0, state.doc.content.size, state.selection.from),
            ),
          apply(tr, decorations, _oldState, newState) {
            // Showing the source of the link under the caret depends on the selection.
            if (isSourceSyntaxVisible()) {
              return DecorationSet.create(
                newState.doc,
                decorate(newState.doc, 0, newState.doc.content.size, newState.selection.from),
              )
            }
            // A cursor move changes nothing, and an edit only the text blocks it touched.
            if (!tr.docChanged) return decorations
            let next = decorations.map(tr.mapping, tr.doc)
            for (const range of changedTextRanges(tr)) {
              const stale = next.find(range.from, range.to)
              if (stale.length > 0) next = next.remove(stale)
              const fresh = decorate(tr.doc, range.from, range.to, newState.selection.from)
              if (fresh.length > 0) next = next.add(tr.doc, fresh)
            }
            return next
          },
        },
        props: {
          decorations(state) {
            return tagsWikilinksKey.getState(state)
          },
          handleClickOn(_view, pos, node, nodePos, event) {
            if (!node.isText || !node.text) return false
            const offset = pos - nodePos
            INLINE_TOKEN_RE.lastIndex = 0
            let match: RegExpExecArray | null
            while ((match = INLINE_TOKEN_RE.exec(node.text)) !== null) {
              const start = match.index
              const end = match.index + match[0].length
              if (offset < start || offset > end) continue
              if (
                match[2] &&
                isSourceSyntaxEditingAvailable() &&
                !event.metaKey &&
                !event.ctrlKey
              ) {
                return false
              }
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
