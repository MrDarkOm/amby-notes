import type { Node as PMNode } from "@tiptap/pm/model"

export interface MarkdownSelection {
  from: number
  to: number
}

function clamp(value: number, upper: number) {
  return Math.max(0, Math.min(value, upper))
}

export function normalizeMarkdownSelection(
  selection: MarkdownSelection | null | undefined,
  markdown: string,
): MarkdownSelection | null {
  if (!selection) return null
  const from = clamp(Math.min(selection.from, selection.to), markdown.length)
  const to = clamp(Math.max(selection.from, selection.to), markdown.length)
  return { from, to }
}

// Prefer a short word immediately before the cursor: markdown delimiters do
// not affect it, so it can be located in both the source and ProseMirror text.
function precedingWord(value: string, offset: number) {
  return value.slice(0, offset).match(/[\p{L}\p{N}_-]{2,}$/u)?.[0] ?? ""
}

function followingWord(value: string, offset: number) {
  return value.slice(offset).match(/^[\p{L}\p{N}_-]{2,}/u)?.[0] ?? ""
}

function findTextPosition(doc: PMNode, needle: string, preferEnd = false): number | null {
  if (!needle) return null
  let result: number | null = null
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return result === null
    const index = preferEnd ? node.text.lastIndexOf(needle) : node.text.indexOf(needle)
    if (index < 0) return result === null
    result = pos + index + (preferEnd ? needle.length : 0)
    return false
  })
  return result
}

function findMarkdownOffset(markdown: string, needle: string, preferEnd = false): number | null {
  if (!needle) return null
  const index = preferEnd ? markdown.lastIndexOf(needle) : markdown.indexOf(needle)
  return index < 0 ? null : index + (preferEnd ? needle.length : 0)
}

function sourceOffsetToDocPosition(doc: PMNode, markdown: string, offset: number) {
  const safeOffset = clamp(offset, markdown.length)
  const before = precedingWord(markdown, safeOffset)
  const after = followingWord(markdown, safeOffset)
  const contextual = before && after ? `${before}${after}` : ""

  if (contextual) {
    const start = findTextPosition(doc, contextual)
    if (start !== null) return start + before.length
  }
  const fromBefore = findTextPosition(doc, before, true)
  if (fromBefore !== null) return fromBefore
  const fromAfter = findTextPosition(doc, after)
  if (fromAfter !== null) return fromAfter

  return clamp(
    Math.round((safeOffset / Math.max(markdown.length, 1)) * doc.content.size),
    doc.content.size,
  )
}

export function markdownSelectionToDocSelection(
  doc: PMNode,
  markdown: string,
  selection: MarkdownSelection | null | undefined,
): MarkdownSelection | null {
  const normalized = normalizeMarkdownSelection(selection, markdown)
  if (!normalized) return null
  return {
    from: sourceOffsetToDocPosition(doc, markdown, normalized.from),
    to: sourceOffsetToDocPosition(doc, markdown, normalized.to),
  }
}

function docPositionToSourceOffset(doc: PMNode, markdown: string, position: number) {
  const safePosition = clamp(position, doc.content.size)
  const before = precedingWord(doc.textBetween(0, safePosition, "\n"), Number.MAX_SAFE_INTEGER)
  const after = followingWord(doc.textBetween(safePosition, doc.content.size, "\n"), 0)
  const contextual = before && after ? `${before}${after}` : ""

  if (contextual) {
    const start = findMarkdownOffset(markdown, contextual)
    if (start !== null) return start + before.length
  }
  const fromBefore = findMarkdownOffset(markdown, before, true)
  if (fromBefore !== null) return fromBefore
  const fromAfter = findMarkdownOffset(markdown, after)
  if (fromAfter !== null) return fromAfter

  return clamp(
    Math.round((safePosition / Math.max(doc.content.size, 1)) * markdown.length),
    markdown.length,
  )
}

export function docSelectionToMarkdownSelection(
  doc: PMNode,
  markdown: string,
  selection: MarkdownSelection,
): MarkdownSelection {
  return normalizeMarkdownSelection(
    {
      from: docPositionToSourceOffset(doc, markdown, selection.from),
      to: docPositionToSourceOffset(doc, markdown, selection.to),
    },
    markdown,
  )!
}
