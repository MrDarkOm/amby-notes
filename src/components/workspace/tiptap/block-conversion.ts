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
