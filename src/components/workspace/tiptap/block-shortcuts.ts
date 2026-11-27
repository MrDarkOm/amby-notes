import { Extension, InputRule, wrappingInputRule } from "@tiptap/core"
import { Fragment, type Node as PMNode } from "@tiptap/pm/model"
import {
  NodeSelection,
  TextSelection,
  type EditorState,
  type Selection,
  type Transaction,
} from "@tiptap/pm/state"
import type { EditorView } from "@tiptap/pm/view"

// Typing and keyboard habits carried over from other Markdown editors: `- [ ] ` makes
// a task, `1) ` a numbered list, Backspace at the start of a heading removes an empty line
// above it (or else makes the heading a paragraph), Mod-Backspace deletes back to the start
// of the current line, Mod-D duplicates the block, Mod-Shift-Up/Down moves it, Mod-K opens
// the link panel.

type Dispatch = ((tr: Transaction) => void) | undefined

export const OPEN_LINK_PANEL_EVENT = "amby:open-link-panel"

interface BlockPosition {
  pos: number
  node: PMNode
  parent: PMNode
  index: number
}

/** The block the selection is in: a top-level block, or a block inside a column. */
export function currentBlock(state: EditorState): BlockPosition | null {
  const { selection } = state
  const { $from } = selection
  const inColumn = $from.depth >= 2 && $from.node(1).type.name === "columnSet"
  const depth = inColumn ? 3 : 1
  if ($from.depth >= depth) {
    return {
      pos: $from.before(depth),
      node: $from.node(depth),
      parent: $from.node(depth - 1),
      index: $from.index(depth - 1),
    }
  }
  // A selected block without text (a database, a rule) sits one level up.
  if (selection instanceof NodeSelection && $from.depth === depth - 1) {
    return { pos: $from.pos, node: selection.node, parent: $from.parent, index: $from.index() }
  }
  return null
}

function shiftedSelection(tr: Transaction, selection: Selection, by: number): Selection {
  if (selection instanceof NodeSelection) {
    return NodeSelection.create(tr.doc, selection.from + by)
  }
  return TextSelection.create(tr.doc, selection.anchor + by, selection.head + by)
}

/** Puts a copy of the current block under it and moves the cursor into the copy. */
export function duplicateBlock(state: EditorState, dispatch?: Dispatch): boolean {
  const block = currentBlock(state)
  if (!block) return false
  const size = block.node.nodeSize
  // The copy is the same block, so it keeps the text the original was read from.
  const tr = state.tr.insert(block.pos + size, block.node)
  tr.setSelection(shiftedSelection(tr, state.selection, size))
  dispatch?.(tr.scrollIntoView())
  return true
}

/** Swaps the current block with its neighbour above or below. */
export function moveBlock(direction: "up" | "down") {
  return (state: EditorState, dispatch?: Dispatch): boolean => {
    const block = currentBlock(state)
    if (!block) return false
    const neighbourIndex = direction === "up" ? block.index - 1 : block.index + 1
    // At the edge there is nowhere to go; the key still belongs to this command.
    if (neighbourIndex < 0 || neighbourIndex >= block.parent.childCount) return true
    const neighbour = block.parent.child(neighbourIndex)
    const by = direction === "up" ? -neighbour.nodeSize : neighbour.nodeSize
    const tr = state.tr.delete(block.pos, block.pos + block.node.nodeSize)
    tr.insert(block.pos + by, block.node)
    tr.setSelection(shiftedSelection(tr, state.selection, by))
    dispatch?.(tr.scrollIntoView())
    return true
  }
}

/**
 * Backspace at the very start of a heading. An empty line above goes away and the heading stays a
 * heading, the caret at its start. Anything else above it (text, or nothing at all) turns the
 * heading into a paragraph first; the next Backspace is the ordinary one and joins it to the text
 * above.
 */
export function backspaceAtHeadingStart(state: EditorState, dispatch?: Dispatch): boolean {
  const { selection, schema } = state
  const { $from } = selection
  if (!selection.empty || $from.parentOffset !== 0) return false
  if ($from.parent.type !== schema.nodes.heading) return false
  const index = $from.index($from.depth - 1)
  const above = index > 0 ? $from.node($from.depth - 1).child(index - 1) : null
  if (above && above.type === schema.nodes.paragraph && above.content.size === 0) {
    const headingStart = $from.before()
    dispatch?.(state.tr.delete(headingStart - above.nodeSize, headingStart).scrollIntoView())
    return true
  }
  dispatch?.(
    state.tr.setBlockType($from.before(), $from.after(), schema.nodes.paragraph).scrollIntoView(),
  )
  return true
}

/**
 * Deletes from the caret back to the start of the current line (or block start).
 * Prevents WebKit's native Cmd+Backspace DOM mutation from being mistaken by
 * prosemirror-view's `looksLikeBackspace` heuristic for a single-character Backspace.
 */
export function deleteToLineStart(
  state: EditorState,
  dispatch?: Dispatch,
  view?: EditorView,
): boolean {
  const { selection } = state
  if (!selection.empty) return false
  const { $from } = selection
  if (!$from.parent.isTextblock) return false
  if ($from.parentOffset === 0) {
    return backspaceAtHeadingStart(state, dispatch)
  }

  const blockStart = $from.start()
  let lineStart = blockStart
  const scanEnd = Math.max(0, $from.parentOffset - 1)

  $from.parent.nodesBetween(0, scanEnd, (node, pos) => {
    if (node.type.name === "hardBreak") {
      lineStart = Math.max(lineStart, blockStart + pos + node.nodeSize)
    } else if (node.isText && node.text) {
      const sliceLen = Math.max(0, scanEnd - pos)
      const lastNewline = node.text.slice(0, sliceLen).lastIndexOf("\n")
      if (lastNewline !== -1) {
        lineStart = Math.max(lineStart, blockStart + pos + lastNewline + 1)
      }
    }
  })

  if (view) {
    try {
      const caretCoords = view.coordsAtPos($from.pos)
      const domAtStart = view.domAtPos(blockStart).node
      const blockEl = domAtStart instanceof HTMLElement ? domAtStart : domAtStart.parentElement
      if (blockEl && caretCoords.bottom > caretCoords.top) {
        const rect = blockEl.getBoundingClientRect()
        if (rect.width > 0) {
          const hit = view.posAtCoords({
            left: rect.left + 2,
            top: (caretCoords.top + caretCoords.bottom) / 2,
          })
          if (hit && hit.pos >= lineStart && hit.pos < $from.pos) {
            lineStart = hit.pos
          }
        }
      }
    } catch {
      // Fallback to logical lineStart when layout measurements are unavailable
    }
  }

  if (lineStart >= $from.pos) return false
  dispatch?.(state.tr.delete(lineStart, $from.pos).scrollIntoView())
  return true
}

const KEPT_SOURCE = {
  markdownBlockSource: null,
  markdownBlockSignature: null,
  markdownBlockGap: null,
  markdownBlockPrev: null,
}

/**
 * `[ ] ` typed at the start of a bullet item: the item becomes a task. The list is cut
 * around it, since a bullet list and a task list are different blocks. `range` is the
 * typed `[ ]` in the item's first paragraph.
 */
export function bulletItemToTask(
  tr: Transaction,
  range: { from: number; to: number },
  checked: boolean,
): boolean {
  const { bulletList, listItem, taskList, taskItem, paragraph } = tr.doc.type.schema.nodes
  if (!taskList || !taskItem) return false
  const $from = tr.doc.resolve(range.from)
  const depth = $from.depth
  if (depth < 2 || $from.parent.type !== paragraph) return false
  const item = $from.node(depth - 1)
  const list = $from.node(depth - 2)
  if (item.type !== listItem || list.type !== bulletList || $from.index(depth - 1) !== 0)
    return false

  const text = $from.parent.content.cut(range.to - $from.start())
  const task = taskItem.create(
    { checked },
    Fragment.from(paragraph.create(null, text)).append(item.content.cut($from.parent.nodeSize)),
  )
  const itemIndex = $from.index(depth - 2)
  const before: PMNode[] = []
  const after: PMNode[] = []
  list.forEach((child, _offset, index) => {
    if (index < itemIndex) before.push(child)
    if (index > itemIndex) after.push(child)
  })
  const pieces: PMNode[] = []
  if (before.length > 0) pieces.push(list.copy(Fragment.fromArray(before)))
  pieces.push(taskList.create(null, task))
  if (after.length > 0) {
    pieces.push(bulletList.create({ ...list.attrs, ...KEPT_SOURCE }, Fragment.fromArray(after)))
  }

  const outer = $from.node(depth - 3)
  const listIndex = $from.index(depth - 3)
  const replacement = Fragment.fromArray(pieces)
  if (!outer.canReplace(listIndex, listIndex + 1, replacement)) return false

  const listPos = $from.before(depth - 2)
  tr.replaceWith(listPos, listPos + list.nodeSize, replacement)
  // Into the task's paragraph: past the cut-off part, the task list, the item, the paragraph.
  const cursor = listPos + (before.length > 0 ? pieces[0].nodeSize : 0) + 3
  tr.setSelection(TextSelection.create(tr.doc, cursor))
  return true
}

export const BlockShortcuts = Extension.create({
  name: "blockShortcuts",
  // Before the default Backspace, which would join the heading to the block above.
  priority: 150,

  addInputRules() {
    const rules = [
      new InputRule({
        find: /^\s*\[([ xX]?)\]\s$/u,
        handler: ({ state, range, match }) => {
          if (!bulletItemToTask(state.tr, range, match[1].toLowerCase() === "x")) return null
        },
      }),
    ]
    const orderedList = this.editor.schema.nodes.orderedList
    if (orderedList) {
      rules.push(
        // `1) ` as well as the `1. ` the list itself understands.
        wrappingInputRule({
          find: /^(\d+)\)\s$/u,
          type: orderedList,
          getAttributes: (match) => ({ start: Number(match[1]) }),
          joinPredicate: (match, node) => node.childCount + node.attrs.start === Number(match[1]),
        }),
      )
    }
    return rules
  },

  addKeyboardShortcuts() {
    const run =
      (command: (state: EditorState, dispatch?: Dispatch, view?: EditorView) => boolean) =>
      ({ editor }: { editor: { isEditable: boolean; view: EditorView } }) => {
        if (!editor.isEditable) return false
        return command(editor.view.state, editor.view.dispatch, editor.view)
      }
    return {
      Backspace: run(backspaceAtHeadingStart),
      "Mod-Backspace": run(deleteToLineStart),
      "Mod-d": run(duplicateBlock),
      "Mod-Shift-ArrowUp": run(moveBlock("up")),
      "Mod-Shift-ArrowDown": run(moveBlock("down")),
      "Mod-k": ({ editor }) => {
        if (!editor.isEditable) return false
        editor.view.dom.dispatchEvent(new CustomEvent(OPEN_LINK_PANEL_EVENT, { bubbles: true }))
        return true
      },
    }
  },
})
