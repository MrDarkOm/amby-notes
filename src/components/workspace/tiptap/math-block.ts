import type { Node as PMNode } from "@tiptap/pm/model"
import { NodeSelection, TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state"

import { isOneParagraph } from "./markdown-meaning"
import { getMarkdownParser } from "./markdown-parser"

// Display math made or changed in Live Preview. The block is its source text, `$$`,
// the TeX and `$$` on lines of their own, and the TeX is written character for
// character: it is never Markdown. What is written must still be read as one formula,
// so TeX the file could not hold as such a block is refused here, never repaired.

type Dispatch = ((tr: Transaction) => void) | undefined

export const MATH_EDIT_EVENT = "amby:math-edit"

const isMath = (node: PMNode | null | undefined): node is PMNode =>
  !!node && node.type.name === "opaqueMarkdownBlock" && node.attrs.kind === "math"

/** The TeX as the block holds it: `\n` between lines, no blank lines around it. */
export function normalizedTex(tex: string): string {
  return tex
    .replace(/\r\n?/gu, "\n")
    .replace(/^(?:[ \t]*\n)+/u, "")
    .replace(/\s+$/u, "")
}

/**
 * The source of a display-math block with this TeX, or null when that text would not be
 * read back as the same block: by the editor's parser, or as one paragraph by a plain
 * Markdown reader (a blank line, or a line that starts a list, a heading or a quote,
 * would end the formula there).
 */
export function mathBlockValue(tex: string): string | null {
  const body = normalizedTex(tex)
  if (!body) return null
  const value = `$$\n${body}\n$$`
  const doc = getMarkdownParser().parse(value)
  const block = doc.childCount === 1 ? doc.firstChild : null
  if (!isMath(block) || block.attrs.value !== value) return null
  return isOneParagraph(value) ? value : null
}

// A block made by a command opens for writing as soon as it is drawn; one that comes
// with a note, an undo or a paste does not.
const opensWhenDrawn = new WeakSet<PMNode>()

/** Whether this block was just made to be written in. Answers yes once. */
export function takeOpenRequest(node: PMNode): boolean {
  return opensWhenDrawn.delete(node)
}

function emptyMathBlock(state: EditorState): PMNode | null {
  const type = state.schema.nodes.opaqueMarkdownBlock
  if (!type) return null
  const node = type.create({ kind: "math", value: "" })
  opensWhenDrawn.add(node)
  return node
}

/**
 * Puts an empty formula at the top level of the note and opens it: in place of the
 * block at `pos` when that is an empty paragraph, right after the top-level block
 * around `pos` otherwise.
 */
export function insertMathBlock(state: EditorState, pos: number, dispatch?: Dispatch): boolean {
  const $pos = state.doc.resolve(Math.min(Math.max(pos, 0), state.doc.content.size))
  const index = $pos.index(0)
  if (index >= state.doc.childCount) return false
  const top = state.doc.child(index)
  const start = $pos.posAtIndex(index, 0)
  const math = emptyMathBlock(state)
  if (!math) return false
  const replaces = top.type.name === "paragraph" && top.childCount === 0
  const at = replaces ? start : start + top.nodeSize
  const tr = state.tr
  if (replaces) tr.replaceWith(start, start + top.nodeSize, math)
  else tr.insert(at, math)
  tr.setSelection(NodeSelection.create(tr.doc, at))
  dispatch?.(tr.scrollIntoView())
  return true
}

/** Enter after `$$` alone on a top-level line: the line becomes an empty formula. */
export function mathBlockOnEnter(state: EditorState, dispatch?: Dispatch): boolean {
  const { selection } = state
  const { $from } = selection
  if (!selection.empty || $from.depth !== 1 || $from.parent.type.name !== "paragraph") return false
  if ($from.parent.childCount !== 1 || !$from.parent.firstChild?.isText) return false
  if ($from.parent.textContent !== "$$" || $from.parentOffset !== 2) return false
  const math = emptyMathBlock(state)
  if (!math) return false
  const start = $from.before(1)
  const tr = state.tr.replaceWith(start, $from.after(1), math)
  tr.setSelection(NodeSelection.create(tr.doc, start))
  dispatch?.(tr.scrollIntoView())
  return true
}

/** The selected display-math block, or null. */
export function selectedMathBlock(state: EditorState): number | null {
  const { selection } = state
  return selection instanceof NodeSelection && isMath(selection.node) ? selection.from : null
}

/**
 * Writes new TeX into the block at `pos` as one step. False when there is no such
 * block or the TeX cannot be held as a formula; nothing is changed then.
 */
export function setMathBlockTex(
  state: EditorState,
  pos: number,
  tex: string,
  dispatch?: Dispatch,
): boolean {
  const node = state.doc.nodeAt(pos)
  if (!isMath(node)) return false
  const value = mathBlockValue(tex)
  if (value === null) return false
  if (value === node.attrs.value) return true
  const tr = state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, value })
  tr.setSelection(NodeSelection.create(tr.doc, pos))
  dispatch?.(tr)
  return true
}

/** Takes an empty formula away and leaves a line to write on in its place. */
export function removeEmptyMathBlock(
  state: EditorState,
  pos: number,
  dispatch?: Dispatch,
): boolean {
  const node = state.doc.nodeAt(pos)
  if (!isMath(node) || node.attrs.value !== "") return false
  const tr = state.tr.replaceWith(pos, pos + node.nodeSize, state.schema.nodes.paragraph.create())
  tr.setSelection(TextSelection.create(tr.doc, pos + 1))
  dispatch?.(tr)
  return true
}
