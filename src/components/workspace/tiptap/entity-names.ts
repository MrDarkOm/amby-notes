import type { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { Plugin, PluginKey } from "@tiptap/pm/state"
import { Decoration, DecorationSet } from "@tiptap/pm/view"
import { findNameRanges } from "../creative/dossier/mention-model"

export const entityNamesKey = new PluginKey<DecorationSet>("entityNames")

/** The names of a workshop's world pages, shown on a page of a story's text. */
export interface EntityNames {
  entries: readonly { name: string; noteId: string }[]
  /** A name is pointed at (`element` is its mark on screen) or left (`null`). */
  onHover: (noteId: string | null, element: HTMLElement | null) => void
  /** Cmd/Ctrl-click on a name. */
  onOpen: (noteId: string) => void
}

function decorate(doc: ProseMirrorNode, entries: EntityNames["entries"]): DecorationSet {
  if (entries.length === 0) return DecorationSet.empty
  const decorations: Decoration[] = []
  doc.descendants((node, position) => {
    if (node.type.spec.code) return false
    if (!node.isTextblock) return true
    // Names are found within one block: its text with every inline node as one character,
    // so an offset in the string is an offset in the document.
    const text = node.textBetween(0, node.content.size, undefined, "￼")
    for (const range of findNameRanges(text, entries)) {
      decorations.push(
        Decoration.inline(position + 1 + range.from, position + 1 + range.to, {
          class: "amby-entity-name",
          "data-entity-id": range.noteId,
        }),
      )
    }
    return false
  })
  return DecorationSet.create(doc, decorations)
}

function entityOf(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element
    ? (target.closest("[data-entity-id]") as HTMLElement | null)
    : null
}

/**
 * Marks the names of the world on a page of the text, as view decorations only: the document,
 * and so the file, never changes. Pointing at a name tells the frame (which shows a card);
 * Cmd/Ctrl-click opens its page.
 */
export function entityNamesPlugin(names: EntityNames) {
  return new Plugin<DecorationSet>({
    key: entityNamesKey,
    state: {
      init: (_, state) => decorate(state.doc, names.entries),
      apply: (transaction, previous) =>
        transaction.docChanged ? decorate(transaction.doc, names.entries) : previous,
    },
    props: {
      decorations: (state) => entityNamesKey.getState(state),
      handleDOMEvents: {
        mouseover: (_view, event) => {
          const element = entityOf(event.target)
          if (element) names.onHover(element.getAttribute("data-entity-id"), element)
          return false
        },
        mouseout: (_view, event) => {
          const from = entityOf(event.target)
          if (from && !from.contains(event.relatedTarget as Node | null)) {
            names.onHover(null, null)
          }
          return false
        },
        click: (_view, event) => {
          if (!(event.metaKey || event.ctrlKey)) return false
          const id = entityOf(event.target)?.getAttribute("data-entity-id")
          if (!id) return false
          event.preventDefault()
          names.onOpen(id)
          return true
        },
      },
    },
  })
}
