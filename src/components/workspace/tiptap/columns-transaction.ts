import type { ResolvedPos } from "@tiptap/pm/model"
import type { EditorState, Transaction } from "@tiptap/pm/state"

export type ColumnDropSide = "left" | "right"

function findAncestor($pos: ResolvedPos, typeName: string) {
  for (let depth = $pos.depth; depth > 0; depth--) {
    if ($pos.node(depth).type.name === typeName) {
      return { node: $pos.node(depth), pos: $pos.before(depth), depth }
    }
  }
  return null
}

function reorderedWidths(widths: unknown, from: number, to: number): string | null {
  if (typeof widths !== "string") return null
  const values = widths.split(",")
  if (values.length <= Math.max(from, to)) return null
  const [moved] = values.splice(from, 1)
  values.splice(to, 0, moved)
  return values.join(",")
}

function widthsWithoutColumn(widths: unknown, removedIndex: number, count: number): string | null {
  if (typeof widths !== "string") return null
  const values = widths.split(",").map(Number)
  if (values.length !== count || values.some((value) => !Number.isFinite(value) || value <= 0)) {
    return null
  }
  values.splice(removedIndex, 1)
  const total = values.reduce((sum, value) => sum + value, 0)
  return values.map((value) => (value / total).toFixed(4)).join(",")
}

function removeColumnAtResolvedPosition(
  state: EditorState,
  $inside: ResolvedPos,
): Transaction | null {
  const column = findAncestor($inside, "column")
  const set = findAncestor($inside, "columnSet")
  if (!column || !set || column.node.childCount !== 1) return null

  const removedIndex = $inside.index(set.depth)
  if (set.node.childCount === 2) {
    const remaining = set.node.child(removedIndex === 0 ? 1 : 0)
    return state.tr.replaceWith(set.pos, set.pos + set.node.nodeSize, remaining.content)
  }

  const columns = Array.from({ length: set.node.childCount }, (_, index) => set.node.child(index))
  columns.splice(removedIndex, 1)
  const widths = widthsWithoutColumn(set.node.attrs.widths, removedIndex, set.node.childCount)
  const attrs = { ...set.node.attrs, widths }
  const replacement = set.node.type.create(attrs, columns)
  return state.tr.replaceWith(set.pos, set.pos + set.node.nodeSize, replacement)
}

/** Remove a column whose only block is being explicitly deleted. */
export function removeSoleBlockColumn(state: EditorState, blockPos: number): Transaction | null {
  const node = state.doc.nodeAt(blockPos)
  if (!node) return null
  const inside = Math.min(blockPos + 1, state.doc.content.size)
  return removeColumnAtResolvedPosition(state, state.doc.resolve(inside))
}

/** Backspace/Delete on the sole empty paragraph removes its visual column. */
export function removeEmptyColumnAtSelection(state: EditorState): Transaction | null {
  if (!state.selection.empty) return null
  const { $from } = state.selection
  if ($from.parent.type.name !== "paragraph" || $from.parent.content.size !== 0) return null
  return removeColumnAtResolvedPosition(state, $from)
}

/** Build the document transaction used by the block gutter's side-drop zone. */
export function createColumnsFromDrop(
  state: EditorState,
  srcPos: number,
  targetPos: number,
  side: ColumnDropSide,
): Transaction | null {
  const { doc, schema } = state
  const source = doc.nodeAt(srcPos)
  const target = doc.nodeAt(targetPos)
  const columnType = schema.nodes.column
  const columnSetType = schema.nodes.columnSet
  if (!source || !target || !columnType || !columnSetType || srcPos === targetPos) return null

  const $source = doc.resolve(srcPos)
  const $targetInside = doc.resolve(Math.min(targetPos + 1, doc.content.size))
  const targetColumn = findAncestor($targetInside, "column")
  const $sourceInside = doc.resolve(Math.min(srcPos + 1, doc.content.size))
  const sourceColumn = findAncestor($sourceInside, "column")

  // A side-drop between existing columns moves the whole source column. This
  // is only unambiguous when the source column contains one block; otherwise
  // dragging a row must move that row rather than unexpectedly moving all of
  // its column siblings.
  if (targetColumn && sourceColumn) {
    if (sourceColumn.node.childCount !== 1) return null
    const targetSet = findAncestor($targetInside, "columnSet")
    const sourceSet = findAncestor($sourceInside, "columnSet")
    if (!targetSet || !sourceSet || targetSet.pos !== sourceSet.pos) return null
    if (targetColumn.pos === sourceColumn.pos) return null
    const columns = Array.from({ length: sourceSet.node.childCount }, (_, index) =>
      sourceSet.node.child(index),
    )
    const sourceIndex = $sourceInside.index(sourceSet.depth)
    const targetIndex = $targetInside.index(targetSet.depth)
    const [moved] = columns.splice(sourceIndex, 1)
    const adjustedTarget = targetIndex - (sourceIndex < targetIndex ? 1 : 0)
    const insertIndex = side === "left" ? adjustedTarget : adjustedTarget + 1
    columns.splice(insertIndex, 0, moved)
    const widths = reorderedWidths(sourceSet.node.attrs.widths, sourceIndex, insertIndex)
    const attrs = { ...sourceSet.node.attrs, ...(widths ? { widths } : {}) }
    const replacement = sourceSet.node.type.create(attrs, columns)
    return state.tr.replaceWith(sourceSet.pos, sourceSet.pos + sourceSet.node.nodeSize, replacement)
  }

  // Adding a third (or later) column: a top-level source dropped against any
  // block inside an existing column set becomes its adjacent sibling column.
  if (targetColumn) {
    if ($source.depth !== 0 || sourceColumn) return null
    const tr = state.tr.delete(srcPos, srcPos + source.nodeSize)
    const mappedColumnPos = tr.mapping.map(targetColumn.pos, -1)
    const mappedColumn = tr.doc.nodeAt(mappedColumnPos)
    if (!mappedColumn) return null
    const insertPos = side === "left" ? mappedColumnPos : mappedColumnPos + mappedColumn.nodeSize
    try {
      tr.insert(insertPos, columnType.create(null, [source]))
      return tr.docChanged ? tr : null
    } catch {
      return null
    }
  }

  // Initial two-column layout is intentionally limited to top-level blocks;
  // list items and nested blocks have structural parents that must stay valid.
  if ($source.depth !== 0 || doc.resolve(targetPos).depth !== 0) return null

  const sourceColumnNode = columnType.create(null, [source])
  const targetColumnNode = columnType.create(null, [target])
  const columns =
    side === "left" ? [sourceColumnNode, targetColumnNode] : [targetColumnNode, sourceColumnNode]
  const columnSet = columnSetType.create(null, columns)
  const tr = state.tr.delete(srcPos, srcPos + source.nodeSize)
  const mappedTargetPos = tr.mapping.map(targetPos, -1)
  try {
    tr.replaceWith(mappedTargetPos, mappedTargetPos + target.nodeSize, columnSet)
    return tr.docChanged ? tr : null
  } catch {
    return null
  }
}

/** Move an ordinary block vertically between independent column containers. */
export function moveBlockAcrossColumns(
  state: EditorState,
  srcPos: number,
  targetPos: number,
  before: boolean,
): Transaction | null {
  const { doc, schema } = state
  const source = doc.nodeAt(srcPos)
  const target = doc.nodeAt(targetPos)
  if (!source || !target || srcPos === targetPos) return null
  const $source = doc.resolve(srcPos)
  const $target = doc.resolve(targetPos)
  const sourceIsColumn = $source.parent.type.name === "column"
  const targetIsColumn = $target.parent.type.name === "column"
  if (!sourceIsColumn && !targetIsColumn) return null
  if ($source.parent === $target.parent) return null

  const rawInsert = before ? targetPos : targetPos + target.nodeSize
  let tr = state.tr
  if (sourceIsColumn && $source.parent.childCount === 1) {
    const paragraph = schema.nodes.paragraph
    if (!paragraph) return null
    tr = tr.replaceWith(srcPos, srcPos + source.nodeSize, paragraph.create())
  } else {
    tr = tr.delete(srcPos, srcPos + source.nodeSize)
  }
  const insertPos = tr.mapping.map(rawInsert, -1)
  try {
    tr.insert(insertPos, source)
    return tr.docChanged ? tr : null
  } catch {
    return null
  }
}
