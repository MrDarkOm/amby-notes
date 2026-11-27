import type { Editor } from "@tiptap/core"

// A Live editor writes Markdown only after a change the person made (TiptapEditor's save gate): a
// remount or a plugin must not persist a transient document. Keys, input, paste, cut and drop inside the
// editor mark that intent. Controls that live outside the editor's DOM — the block grip and its menus,
// portaled to the body — say so here, or their changes are shown but never saved (EDIT-02).

const marks = new WeakMap<Editor, () => void>()

/** Called by the editor that owns the save gate; returns the unregister function. */
export function registerEditorUserIntent(editor: Editor, mark: () => void): () => void {
  marks.set(editor, mark)
  return () => {
    if (marks.get(editor) === mark) marks.delete(editor)
  }
}

/** The person is acting on this editor through a control outside its DOM. */
export function markEditorUserIntent(editor: Editor | null | undefined): void {
  if (editor) marks.get(editor)?.()
}
