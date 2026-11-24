import { Plugin, PluginKey } from "@tiptap/pm/state"
import { notePageContains, notePagesKey } from "./note-pages"
import { Decoration, DecorationSet } from "@tiptap/pm/view"

export const headingHintsKey = new PluginKey("headingHints")

/** The hint is a view decoration after the heading, outside the editable document. */
export function headingHintsPlugin(hints: ReadonlyMap<string, string>) {
  return new Plugin({
    key: headingHintsKey,
    props: {
      decorations: (state) => {
        const { doc } = state
        const pages = notePagesKey.getState(state)
        const decorations: Decoration[] = []
        let empty: { position: number; text: string } | undefined
        const finish = () => {
          if (!empty) return
          const { position, text } = empty
          decorations.push(
            Decoration.widget(
              position,
              () => {
                const hint = document.createElement("div")
                hint.className = "amby-heading-hint"
                hint.textContent = text
                return hint
              },
              { side: -1, key: text },
            ),
          )
        }
        doc.forEach((node, offset) => {
          if (node.type.name === "heading") {
            finish()
            const text = hints.get(node.textContent.trim())
            empty =
              text && notePageContains(pages, offset)
                ? { position: offset + node.nodeSize, text }
                : undefined
          } else if (node.type.name !== "paragraph" || node.content.size > 0) {
            empty = undefined
          }
        })
        finish()
        return DecorationSet.create(doc, decorations)
      },
    },
  })
}
