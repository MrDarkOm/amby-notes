import type { Editor } from "@tiptap/core"
import { NodeSelection } from "@tiptap/pm/state"

/** What can be changed on a picture node. */
export interface ImagePatch {
  src?: string
  title?: string | null
  alt?: string | null
  align?: "left" | "center" | "right" | null
  width?: number | null
  height?: number | null
}

/**
 * Changes the picture at `pos`, if it is still the picture whose address is `expectedSrc`
 * (the note may have changed while a dialog was open). The picture stays selected.
 */
export function updateImageNode(
  editor: Editor,
  pos: number,
  expectedSrc: string,
  patch: ImagePatch,
  /** Select the picture afterwards (its toolbar follows); a menu changing it leaves it be. */
  select = true,
): boolean {
  if (editor.isDestroyed) return false
  const { doc } = editor.state
  const node = pos >= 0 && pos < doc.content.size ? doc.nodeAt(pos) : null
  if (!node || node.type.name !== "image" || node.attrs.src !== expectedSrc) return false
  const tr = editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...patch })
  if (select) tr.setSelection(NodeSelection.create(tr.doc, pos))
  editor.view.dispatch(tr)
  return true
}

/**
 * Gives the focus back to the editor with the picture at `pos` still selected. The webview
 * turns the selection into a caret when the focus returns from a field, so the picture is
 * selected again once it has settled.
 */
export function refocusPicture(editor: Editor, pos: number): void {
  editor.commands.focus()
  window.setTimeout(() => {
    if (editor.isDestroyed) return
    const { selection, doc } = editor.state
    if (selection instanceof NodeSelection && selection.from === pos) return
    if (doc.nodeAt(pos)?.type.name !== "image") return
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(doc, pos)))
  }, 60)
}
