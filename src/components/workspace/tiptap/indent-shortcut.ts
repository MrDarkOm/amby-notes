import { Extension } from "@tiptap/core"
import { sinkListItem, liftListItem } from "@tiptap/pm/schema-list"
import { Plugin, type EditorState, type Transaction } from "@tiptap/pm/state"
import { canJoin } from "@tiptap/pm/transform"

/**
 * Lifting an ordered sub-list can leave two ordered-list nodes adjacent. They
 * represent one continuous list, but their second node defaults to `start: 1`.
 * Join them after the explicit outdent so numbering keeps following the list.
 */
function adjacentOrderedListTransaction(state: EditorState): Transaction | null {
  const boundaries: number[] = []

  function collect(parent: typeof state.doc, parentPos: number) {
    let offset = 0
    let previousType: string | null = null
    parent.forEach((child) => {
      const pos = parentPos + 1 + offset
      if (previousType === "orderedList" && child.type.name === "orderedList") {
        boundaries.push(pos)
      }
      if (child.childCount > 0) collect(child, pos)
      previousType = child.type.name
      offset += child.nodeSize
    })
  }

  collect(state.doc, -1)
  if (boundaries.length === 0) return null

  let tr = state.tr
  for (const boundary of boundaries.sort((a, b) => b - a)) {
    if (canJoin(tr.doc, boundary)) tr = tr.join(boundary)
  }
  return tr.docChanged ? tr : null
}

export function mergeAdjacentOrderedLists(
  state: EditorState,
  dispatch: (tr: typeof state.tr) => void,
) {
  const tr = adjacentOrderedListTransaction(state)
  if (!tr) return false
  dispatch(tr)
  return true
}

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

  addProseMirrorPlugins() {
    return [
      new Plugin({
        appendTransaction(transactions, _oldState, newState) {
          if (!transactions.some((transaction) => transaction.docChanged)) return null
          return adjacentOrderedListTransaction(newState)
        },
      }),
    ]
  },

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
        if (listItem && liftListItem(listItem)(state, dispatch)) {
          mergeAdjacentOrderedLists(editor.view.state, editor.view.dispatch)
          return true
        }
        if (taskItem && liftListItem(taskItem)(state, dispatch)) return true
        return false
      },
    }
  },
})
