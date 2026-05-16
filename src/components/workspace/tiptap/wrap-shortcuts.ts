import { Extension } from "@tiptap/core"

function slugifyTag(s: string): string {
  return s.replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_\-/]/gu, "")
}

/**
 * When text is selected:
 *   [ → wraps selection as [[selected text]]
 *   # → wraps selection as #slugified-text
 * When no selection, falls through to default editor behaviour.
 */
export const WrapShortcuts = Extension.create({
  name: "wrapShortcuts",

  addKeyboardShortcuts() {
    return {
      "[": ({ editor }) => {
        const { from, to } = editor.state.selection
        if (from === to) return false
        const text = editor.state.doc.textBetween(from, to, " ").trim()
        if (!text) return false
        editor.chain().focus().insertContentAt({ from, to }, `[[${text}]]`).run()
        return true
      },
      "#": ({ editor }) => {
        const { from, to } = editor.state.selection
        if (from === to) return false
        const text = editor.state.doc.textBetween(from, to, " ").trim()
        if (!text) return false
        const slug = slugifyTag(text)
        editor.chain().focus().insertContentAt({ from, to }, `#${slug} `).run()
        return true
      },
    }
  },
})
