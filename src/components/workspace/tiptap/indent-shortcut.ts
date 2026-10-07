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

const TAB = "\t"

function insideAny(state: EditorState, names: readonly string[]): boolean {
  const { $from, $to } = state.selection
  for (const $pos of [$from, $to]) {
    for (let depth = $pos.depth; depth > 0; depth--) {
      if (names.includes($pos.node(depth).type.name)) return true
    }
  }
  return false
}

/** Start positions of the lines a selection touches: each textblock, and each line of a code block. */
function lineStarts(state: EditorState): number[] {
  const { from, to } = state.selection
  const starts: number[] = []
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!node.isTextblock) return true
    starts.push(pos + 1)
    if (node.type.spec.code) {
      const text = node.textContent
      for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) {
        const start = pos + 1 + at + 1
        if (start >= from && start <= to) starts.push(start)
      }
    }
    return false
  })
  return starts.filter((start, index) => starts.indexOf(start) === index)
}

/**
 * Tab in text that is not a list or a table: with a caret, type a tab character at it;
 * with a selection, put one at the start of every line it touches. A tab at the start of
 * a line is written as `&#9;` (see the serializer), so it survives a round trip.
 */
export function indentText(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  if (insideAny(state, ["table"])) return false
  // A list item that cannot be sunk any further still keeps the key: Tab must not move focus.
  if (insideAny(state, ["listItem", "taskItem"])) return true
  const { selection } = state
  if (!selection.$from.parent.isTextblock || !selection.$to.parent.isTextblock) return false
  if (dispatch) {
    const tr = state.tr
    if (selection.empty) {
      tr.insertText(TAB)
    } else {
      for (const start of lineStarts(state).sort((a, b) => b - a)) tr.insertText(TAB, start)
    }
    dispatch(tr.scrollIntoView())
  }
  return true
}

/** Shift+Tab: remove a tab before the caret, or the leading tab of every line a selection touches. */
export function outdentText(state: EditorState, dispatch?: (tr: Transaction) => void): boolean {
  if (insideAny(state, ["table", "listItem", "taskItem"])) return false
  const { selection } = state
  const removals: number[] = []
  if (selection.empty) {
    const before = state.doc.textBetween(Math.max(0, selection.from - 1), selection.from)
    if (before === TAB) removals.push(selection.from - 1)
    else {
      const [start] = lineStarts(state)
      if (start !== undefined && state.doc.textBetween(start, start + 1) === TAB)
        removals.push(start)
    }
  } else {
    for (const start of lineStarts(state)) {
      if (state.doc.textBetween(start, Math.min(start + 1, state.doc.content.size)) === TAB) {
        removals.push(start)
      }
    }
  }
  if (removals.length === 0) return false
  if (dispatch) {
    const tr = state.tr
    for (const at of removals.sort((a, b) => b - a)) tr.delete(at, at + 1)
    dispatch(tr.scrollIntoView())
  }
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
        return indentText(state, dispatch)
      },
      "Shift-Tab": ({ editor }) => {
        const { state, dispatch } = editor.view
        const { listItem, taskItem } = state.schema.nodes
        if (listItem && liftListItem(listItem)(state, dispatch)) {
          mergeAdjacentOrderedLists(editor.view.state, editor.view.dispatch)
          return true
        }
        if (taskItem && liftListItem(taskItem)(state, dispatch)) return true
        return outdentText(state, dispatch)
      },
    }
  },
})
