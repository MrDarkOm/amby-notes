import { Extension } from "@tiptap/core"
import type { EditorState } from "@tiptap/pm/state"

// Markdown has no line break inside an ATX heading, and a GFM table cell is one line of inline text.
// A break typed there was written in a form that reads back as something else: `# Title\` and a
// separate paragraph, or a cell whose lines merge (EDIT-01). These keys do nothing there instead.

function insideAny(state: EditorState, names: readonly string[]): boolean {
  const { $from } = state.selection
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if (names.includes($from.node(depth).type.name)) return true
  }
  return false
}

const CELLS = ["tableCell", "tableHeader"] as const
const NO_LINE_BREAK = ["heading", ...CELLS] as const

export const MarkdownLineBreaks = Extension.create({
  name: "markdownLineBreaks",
  // Before HardBreak (Shift-Enter, Mod-Enter) and the paragraph split (Enter).
  priority: 200,

  addKeyboardShortcuts() {
    const swallowIn =
      (names: readonly string[]) =>
      ({ editor }: { editor: { isEditable: boolean; state: EditorState } }) =>
        editor.isEditable && insideAny(editor.state, names)
    return {
      "Shift-Enter": swallowIn(NO_LINE_BREAK),
      "Mod-Enter": swallowIn(NO_LINE_BREAK),
      Enter: swallowIn(CELLS),
    }
  },
})
