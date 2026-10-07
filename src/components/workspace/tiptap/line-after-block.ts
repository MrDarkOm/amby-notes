import { Extension } from "@tiptap/core"
import { Selection, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state"

/**
 * Empty lines next to a block without text (a database) or columns. The note does
 * not force an empty line after such a block, so Backspace can remove the last
 * one, and `selectEndOfNote` serves the click below the note.
 */

const isTextlessBlock = (node: { type: { name: string }; isBlock: boolean; isAtom: boolean }) =>
  (node.isBlock && node.isAtom) || node.type.name === "columnSet"

/**
 * Backspace on an empty line right behind such a block. The default one deletes
 * the line but selects the block; the cursor goes to the next text instead (the
 * block stays selected only when nothing follows).
 */
export function removeEmptyLineAfterAtom(state: EditorState): Transaction | null {
  const { selection, doc } = state
  const { $from } = selection
  if (!selection.empty || $from.depth !== 1) return null
  const line = $from.parent
  if (line.type.name !== "paragraph" || line.content.size > 0) return null
  const index = $from.index(0)
  if (index === 0 || !isTextlessBlock(doc.child(index - 1))) return null
  const tr = state.tr.delete($from.before(1), $from.after(1))
  return tr.setSelection(Selection.near(tr.doc.resolve($from.before(1)), 1)).scrollIntoView()
}

/**
 * A click below everything: the cursor goes to an empty last line. The note's last
 * line is reused when it is already empty; otherwise a new one is added below
 * (whatever the note ends with: text, a database, columns), so there is always a
 * free line to write on.
 */
export function selectEndOfNote(state: EditorState): Transaction {
  const { doc, schema } = state
  const last = doc.lastChild
  if (last && last.type.name === "paragraph" && last.content.size === 0) {
    return state.tr.setSelection(TextSelection.create(doc, doc.content.size - 1)).scrollIntoView()
  }
  const tr = state.tr.insert(doc.content.size, schema.nodes.paragraph.create())
  return tr.setSelection(TextSelection.near(tr.doc.resolve(doc.content.size + 1))).scrollIntoView()
}

export const LineAfterBlock = Extension.create({
  name: "lineAfterBlock",
  priority: 200,

  addKeyboardShortcuts() {
    const handle = () => {
      const { state, dispatch } = this.editor.view
      const tr = removeEmptyLineAfterAtom(state)
      if (!tr) return false
      dispatch(tr)
      return true
    }
    return { Backspace: handle, "Mod-Backspace": handle }
  },
})
