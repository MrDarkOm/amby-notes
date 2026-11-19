import { Fragment, type Node as PMNode } from "@tiptap/pm/model"
import { TextSelection, type EditorState, type Transaction } from "@tiptap/pm/state"

type WrapperType = "blockquote" | "callout"

/** Wrap or re-wrap one block without discarding its text, marks, or child blocks. */
export function convertBlockWrapper(
  state: EditorState,
  nodePos: number,
  targetType: WrapperType,
): Transaction | null {
  if (nodePos < 0 || nodePos > state.doc.content.size) return null
  const source = state.doc.nodeAt(nodePos)
  const target = state.schema.nodes[targetType]
  if (!source || !target || source.type === target) return null

  const content =
    source.type.name === "callout" || source.type.name === "blockquote"
      ? source.content
      : Fragment.from(source)
  const attrs = targetType === "callout" ? { calloutType: "NOTE", emoji: "💡" } : null

  let replacement
  try {
    replacement = target.createChecked(attrs, content)
  } catch {
    return null
  }
  const transaction = state.tr.replaceWith(nodePos, nodePos + source.nodeSize, replacement)
  const cursorPos = Math.min(nodePos + 2, transaction.doc.content.size)
  return transaction
    .setSelection(TextSelection.near(transaction.doc.resolve(cursorPos)))
    .scrollIntoView()
}

/** Replace a Callout wrapper with a quote while preserving every inner block. */
export function calloutToBlockquote(state: EditorState, nodePos: number): Transaction | null {
  const source = state.doc.nodeAt(nodePos)
  if (source?.type.name !== "callout") return null
  return convertBlockWrapper(state, nodePos, "blockquote")
}

/** Turn a visual block into ordinary paragraph content without losing its text. */
export function convertBlockToParagraph(state: EditorState, nodePos: number): Transaction | null {
  if (nodePos < 0 || nodePos > state.doc.content.size) return null
  const source = state.doc.nodeAt(nodePos)
  const paragraph = state.schema.nodes.paragraph
  if (!source || !paragraph || source.type === paragraph) return null

  let replacement: Fragment
  if (source.type.name === "callout" || source.type.name === "blockquote") {
    const blocks: PMNode[] = []
    source.forEach((child) => {
      blocks.push(
        child.isTextblock && child.type !== paragraph
          ? paragraph.createChecked(null, child.content, child.marks)
          : child,
      )
    })
    replacement = Fragment.fromArray(blocks)
  } else if (source.isTextblock) {
    replacement = Fragment.from(paragraph.createChecked(null, source.content, source.marks))
  } else {
    replacement = Fragment.from(
      paragraph.create(
        null,
        source.textContent ? state.schema.text(source.textContent) : undefined,
      ),
    )
  }

  const transaction = state.tr.replaceWith(nodePos, nodePos + source.nodeSize, replacement)
  const cursorPos = Math.min(nodePos + 1, transaction.doc.content.size)
  return transaction
    .setSelection(TextSelection.near(transaction.doc.resolve(cursorPos)))
    .scrollIntoView()
}

/**
 * Turns the visual lines in one paragraph into sibling paragraph blocks while
 * preserving inline marks and inline nodes. This is deliberately a separate
 * action from "Turn into": a paragraph stays a paragraph.
 */
export function splitParagraphIntoBlocks(state: EditorState, nodePos: number): Transaction | null {
  const paragraph = state.doc.nodeAt(nodePos)
  if (!paragraph || paragraph.type.name !== "paragraph") return null

  const lines: PMNode[][] = [[]]
  const nextLine = () => lines.push([])
  const appendToCurrentLine = (child: PMNode) => {
    lines[lines.length - 1]?.push(child)
  }

  paragraph.forEach((child) => {
    if (child.type.name === "hardBreak") {
      nextLine()
      return
    }

    if (!child.isText || !child.text?.includes("\n")) {
      appendToCurrentLine(child)
      return
    }

    const parts = child.text.split(/\r?\n/u)
    parts.forEach((part, index) => {
      if (part) appendToCurrentLine(paragraph.type.schema.text(part, child.marks))
      if (index < parts.length - 1) nextLine()
    })
  })

  if (lines.length < 2) return null

  const paragraphs = lines.map((line) =>
    paragraph.type.create(paragraph.attrs, Fragment.fromArray(line)),
  )
  return state.tr
    .replaceWith(nodePos, nodePos + paragraph.nodeSize, Fragment.fromArray(paragraphs))
    .scrollIntoView()
}

export type ListKind = "bullet" | "ordered" | "task"

export type ListParent = {
  type: "bulletList" | "orderedList" | "taskList"
  pos: number
  node: PMNode
}

/** The list around a position, or `null` when it is not inside one. */
export function findListParent(state: EditorState, pos: number): ListParent | null {
  const doc = state.doc
  const inside = Math.min(pos + 1, doc.content.size - 1)
  if (inside < 0) return null
  const $pos = doc.resolve(inside)
  for (let d = $pos.depth; d >= 0; d--) {
    const n = $pos.node(d)
    const name = n.type.name
    if (name === "bulletList" || name === "orderedList" || name === "taskList") {
      return { type: name, pos: $pos.before(d), node: n }
    }
  }
  return null
}

const LIST_NODE: Record<ListKind, ListParent["type"]> = {
  bullet: "bulletList",
  ordered: "orderedList",
  task: "taskList",
}

/** Rewrites the list around a position as another kind, keeping the content of every item. */
export function convertList(
  state: EditorState,
  nodePos: number,
  target: ListKind,
): Transaction | null {
  const parent = findListParent(state, nodePos)
  if (!parent || parent.type === LIST_NODE[target]) return null

  const listType = state.schema.nodes[LIST_NODE[target]]
  const itemType = state.schema.nodes[target === "task" ? "taskItem" : "listItem"]
  if (!listType || !itemType) return null

  const items: PMNode[] = []
  parent.node.forEach((item) => {
    items.push(
      itemType.create(target === "task" ? { checked: false } : null, item.content, item.marks),
    )
  })
  const replacement = listType.create(
    target === "ordered" ? { start: 1 } : null,
    Fragment.fromArray(items),
  )
  return state.tr
    .replaceWith(parent.pos, parent.pos + parent.node.nodeSize, replacement)
    .scrollIntoView()
}
