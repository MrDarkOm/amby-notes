import type { Node as PMNode } from "@tiptap/pm/model"
import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state"
import {
  TableMap,
  addColumn,
  addRow,
  isInTable,
  removeColumn,
  removeRow,
  selectedRect,
  type TableRect,
} from "@tiptap/pm/tables"

// Rows and columns of a Markdown table. A GFM table always has exactly one header row,
// the first one, and the alignment of its columns is written in the delimiter row. The
// commands keep both true: whatever is added or removed, the first row is the header
// and every remaining column keeps its alignment.

type Dispatch = ((tr: Transaction) => void) | undefined

export type TableEdit =
  | "rowBefore"
  | "rowAfter"
  | "columnBefore"
  | "columnAfter"
  | "deleteRow"
  | "deleteColumn"
  | "deleteTable"

type Alignment = ":---" | ":---:" | "---:" | "---"

/** The alignment of every column, read from the delimiter row the table was read with. */
function alignments(table: PMNode, columnCount: number): Alignment[] {
  const plain = Array.from({ length: columnCount }, (): Alignment => "---")
  const separator = table.attrs.markdownSeparator
  if (typeof separator !== "string") return plain
  const cells = separator
    .trim()
    .split("|")
    .map((cell) => cell.trim())
    .filter(Boolean)
  if (cells.length !== columnCount || !cells.every((cell) => /^:?-+:?$/u.test(cell))) return plain
  return cells.map((cell): Alignment => {
    const left = cell.startsWith(":")
    const right = cell.endsWith(":")
    return left && right ? ":---:" : left ? ":---" : right ? "---:" : "---"
  })
}

export type ColumnAlignment = "left" | "center" | "right" | "none"

const DELIMITER: Record<ColumnAlignment, Alignment> = {
  left: ":---",
  center: ":---:",
  right: "---:",
  none: "---",
}
const NAMED: Record<Alignment, ColumnAlignment> = {
  ":---": "left",
  ":---:": "center",
  "---:": "right",
  "---": "none",
}

/** How every column of a table is aligned: what its delimiter row says, nothing else. */
export function columnAlignments(table: PMNode): ColumnAlignment[] {
  return alignments(table, table.firstChild?.childCount ?? 0).map((mark) => NAMED[mark])
}

/**
 * After rows or columns changed: the first row is the header, the others are not, and
 * the delimiter row has one cell per column. The table's own source text no longer
 * describes it, so it is dropped.
 */
function settle(tr: Transaction, tablePos: number, aligned: Alignment[]) {
  const table = tr.doc.nodeAt(tablePos)
  if (!table || table.type.name !== "table") return
  const { tableHeader, tableCell } = table.type.schema.nodes
  table.forEach((row, rowOffset, rowIndex) => {
    const wanted = rowIndex === 0 ? tableHeader : tableCell
    row.forEach((cell, cellOffset) => {
      if (cell.type === wanted) return
      tr.setNodeMarkup(tablePos + 1 + rowOffset + 1 + cellOffset, wanted, cell.attrs)
    })
  })
  tr.setNodeMarkup(tablePos, undefined, {
    ...table.attrs,
    markdownSeparator: `| ${aligned.join(" | ")} |`,
    markdownSource: null,
    markdownSignature: null,
  })
}

function rectOf(table: PMNode, tablePos: number): TableRect {
  const map = TableMap.get(table)
  return {
    map,
    table,
    tableStart: tablePos + 1,
    left: 0,
    top: 0,
    right: map.width,
    bottom: map.height,
  }
}

function cursorInCell(tr: Transaction, tablePos: number, row: number, column: number) {
  const table = tr.doc.nodeAt(tablePos)
  if (!table || table.type.name !== "table") return
  const map = TableMap.get(table)
  const cell = map.positionAt(Math.min(row, map.height - 1), Math.min(column, map.width - 1), table)
  tr.setSelection(TextSelection.near(tr.doc.resolve(tablePos + 1 + cell + 1)))
}

/** Adds a row under the last one, or a column after the last one, of the table at a position. */
export function appendToTable(
  state: EditorState,
  tablePos: number,
  what: "row" | "column",
  dispatch?: Dispatch,
): boolean {
  const table = state.doc.nodeAt(tablePos)
  if (!table || table.type.name !== "table") return false
  const rect = rectOf(table, tablePos)
  const aligned = alignments(table, rect.map.width)
  const tr = state.tr
  if (what === "row") {
    addRow(tr, rect, rect.map.height)
    settle(tr, tablePos, aligned)
    cursorInCell(tr, tablePos, rect.map.height, 0)
  } else {
    addColumn(tr, rect, rect.map.width)
    settle(tr, tablePos, [...aligned, "---"])
    cursorInCell(tr, tablePos, 0, rect.map.width)
  }
  dispatch?.(tr.scrollIntoView())
  return true
}

/** Changes the rows or columns around the cell the cursor is in. */
export function editTable(edit: TableEdit) {
  return (state: EditorState, dispatch?: Dispatch): boolean => {
    if (!isInTable(state)) return false
    const rect = selectedRect(state)
    const tablePos = rect.tableStart - 1
    const { width, height } = rect.map
    const aligned = alignments(rect.table, width)
    const tr = state.tr
    const removeTable = () => {
      tr.delete(tablePos, tablePos + rect.table.nodeSize)
      // Something to write on is left where the table was.
      if (tr.doc.childCount === 0) tr.insert(0, state.schema.nodes.paragraph.create())
      tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(tablePos, tr.doc.content.size))))
    }

    switch (edit) {
      case "rowBefore":
      case "rowAfter": {
        const at = edit === "rowBefore" ? rect.top : rect.bottom
        addRow(tr, rect, at)
        settle(tr, tablePos, aligned)
        cursorInCell(tr, tablePos, at, rect.left)
        break
      }
      case "columnBefore":
      case "columnAfter": {
        const at = edit === "columnBefore" ? rect.left : rect.right
        addColumn(tr, rect, at)
        const next = aligned.slice()
        next.splice(at, 0, "---")
        settle(tr, tablePos, next)
        cursorInCell(tr, tablePos, rect.top, at)
        break
      }
      case "deleteRow": {
        const count = rect.bottom - rect.top
        if (count >= height) {
          removeTable()
          break
        }
        // From the bottom up, so that the rows still to go keep their numbers.
        for (let row = rect.bottom - 1; row >= rect.top; row--) {
          const table = tr.doc.nodeAt(tablePos)
          if (table) removeRow(tr, rectOf(table, tablePos), row)
        }
        settle(tr, tablePos, aligned)
        cursorInCell(tr, tablePos, rect.top, rect.left)
        break
      }
      case "deleteColumn": {
        const count = rect.right - rect.left
        if (count >= width) {
          removeTable()
          break
        }
        for (let column = rect.right - 1; column >= rect.left; column--) {
          const table = tr.doc.nodeAt(tablePos)
          if (table) removeColumn(tr, rectOf(table, tablePos), column)
        }
        const next = aligned.slice()
        next.splice(rect.left, count)
        settle(tr, tablePos, next)
        cursorInCell(tr, tablePos, rect.top, rect.left)
        break
      }
      case "deleteTable":
        removeTable()
        break
    }
    dispatch?.(tr.scrollIntoView())
    return true
  }
}

/**
 * Aligns the column of the current cell (every column of a selection of cells) by
 * rewriting the delimiter row. Like any change of the table, it drops the table's own
 * source text, so the new delimiter row is what is written.
 */
export function alignColumn(to: ColumnAlignment) {
  return (state: EditorState, dispatch?: Dispatch): boolean => {
    if (!isInTable(state)) return false
    const rect = selectedRect(state)
    const aligned = alignments(rect.table, rect.map.width)
    const next = aligned.map((mark, column) =>
      column >= rect.left && column < rect.right ? DELIMITER[to] : mark,
    )
    // Already so: the table is not touched and keeps the text it was read from.
    if (next.every((mark, column) => mark === aligned[column])) return true
    const tr = state.tr
    settle(tr, rect.tableStart - 1, next)
    dispatch?.(tr)
    return true
  }
}

/** The alignment of the column of the current cell; null outside a table or when the selected columns differ. */
export function alignmentAtSelection(state: EditorState): ColumnAlignment | null {
  if (!isInTable(state)) return null
  const rect = selectedRect(state)
  const selected = columnAlignments(rect.table).slice(rect.left, rect.right)
  return selected.length > 0 && selected.every((value) => value === selected[0])
    ? selected[0]
    : null
}

/** The position of the table the selection is in, or null. */
export function tableAtSelection(state: EditorState): number | null {
  const { $from } = state.selection
  for (let depth = $from.depth; depth > 0; depth--) {
    if ($from.node(depth).type.name === "table") return $from.before(depth)
  }
  return null
}
