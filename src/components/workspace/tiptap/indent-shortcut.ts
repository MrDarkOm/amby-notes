import { Extension } from "@tiptap/core"
import { sinkListItem, liftListItem } from "@tiptap/pm/schema-list"

/**
 * Obsidian-style Tab / Shift+Tab indentation.
 *
 * Works at any cursor position within a list item (not just at line-start),
 * matching the behaviour users expect from Obsidian and Notion.
 * Priority 200 overrides StarterKit's default Tab handlers (priority 100).
 */
export const IndentShortcut = Extension.create({
  name: "indentShortcut",
  priority: 200,

  addKeyboardShortcuts() {
    return {
      Tab: ({ editor }) => {
        const { state, dispatch } = editor.view
        const { listItem, taskItem } = state.schema.nodes
        if (listItem && sinkListItem(listItem)(state, dispatch)) return true
        if (taskItem && sinkListItem(taskItem)(state, dispatch)) return true
        return false
      },
      "Shift-Tab": ({ editor }) => {
        const { state, dispatch } = editor.view
        const { listItem, taskItem } = state.schema.nodes
        if (listItem && liftListItem(listItem)(state, dispatch)) return true
        if (taskItem && liftListItem(taskItem)(state, dispatch)) return true
        return false
      },
    }
  },
})
