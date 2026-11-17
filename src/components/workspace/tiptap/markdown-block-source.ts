import { Fragment, type Node as PMNode } from "@tiptap/pm/model"
import { blockSourceKey } from "./markdown-block-plugins"
import { markdownMeaning } from "./markdown-meaning"
import { getMarkdownParser } from "./markdown-parser"
import {
  bulletAfterList,
  createSerializerState,
  normalizedListItems,
  serializeFragment,
  transformForSerialization,
} from "./markdown-serializer"
import { editorSchema } from "./schema"

// Live Preview for a note the editor cannot write back byte for byte.
//
// A top-level block keeps the text it was read from. While the block is unchanged, that
// text is written; once it is edited, the editor's own form is written for that block
// only. "Unchanged" needs no tracking of edits: a block is unchanged while the editor
// would write for it exactly what it would have written right after reading it (its
// signature). This survives undo, a reload through JSON, a move and a duplicate.
//
// Kept text is never trusted blindly. What is about to be saved is read back, and when
// it is not the document the editor holds, the note is written in the editor's own form
// throughout — as it always was before blocks kept their text.

/** Attributes that say how a block was spelled, not what it is. */
const SPELLING_ATTRIBUTES = new Set([
  "markdownBlockSource",
  "markdownBlockSignature",
  "markdownBlockGap",
  "markdownBlockPrev",
  "markdownItemSource",
  "markdownItemSignature",
  "markdownItemGap",
  "markdownItemPrev",
  // A table keeps its own source and delimiter row; its alignment is compared by
  // markdown-meaning.ts when a note is admitted.
  "markdownSource",
  "markdownSignature",
  "markdownSeparator",
  "markdownMarkup",
  "markdownTitleMarkup",
  "markdownPadded",
])

function sameAttributes(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (!SPELLING_ATTRIBUTES.has(key) && a[key] !== b[key]) return false
  }
  return true
}

/** Whether two documents are the same apart from how their Markdown was spelled. */
export function sameDocument(a: PMNode, b: PMNode): boolean {
  if (a === b) return true
  if (a.type.name !== b.type.name || a.text !== b.text || a.childCount !== b.childCount)
    return false
  if (!sameAttributes(a.attrs, b.attrs) || a.marks.length !== b.marks.length) return false
  for (let index = 0; index < a.marks.length; index++) {
    const left = a.marks[index]
    const right = b.marks[index]
    if (left.type.name !== right.type.name || !sameAttributes(left.attrs, right.attrs)) return false
  }
  for (let index = 0; index < a.childCount; index++) {
    if (!sameDocument(a.child(index), b.child(index))) return false
  }
  return true
}

// Blocks keep their identity between editor states, so only an edited block is
// serialized again on the next save.
const normalizedBlocks = new WeakMap<PMNode, string>()

/** What the editor writes for one top-level block on its own. */
function normalizedBlock(block: PMNode): string {
  let text = normalizedBlocks.get(block)
  if (text === undefined) {
    text = serializeFragment(editorSchema.topNodeType.create(null, block))
    normalizedBlocks.set(block, text)
  }
  return text
}

// The editor's form of each top-level block is prepared once per block, not once per save.
const preparedBlocks = new WeakMap<PMNode, PMNode>()

function prepareForSerialization(doc: PMNode): PMNode {
  const children: PMNode[] = []
  doc.forEach((child) => {
    let prepared = preparedBlocks.get(child)
    if (prepared === undefined) {
      prepared = transformForSerialization(child)
      preparedBlocks.set(child, prepared)
    }
    children.push(prepared)
  })
  return doc.copy(Fragment.fromArray(children))
}

const isEmptyParagraph = (node: PMNode) => node.type.name === "paragraph" && node.childCount === 0
const isList = (node: PMNode) => node.type.name.endsWith("List")
const BLANK_LINES = /^[ \t\n]*$/u

/** The kept text of a block the editor would still write as it did when it read it. */
function keptSource(block: PMNode): string | null {
  const source = block.attrs.markdownBlockSource
  const signature = block.attrs.markdownBlockSignature
  if (typeof source !== "string" || typeof signature !== "string") return null
  return normalizedBlock(block) === signature ? source : null
}

const hasItemSources = (list: PMNode) =>
  isList(list) &&
  list.childCount > 0 &&
  typeof list.firstChild?.attrs.markdownItemSource === "string"

const BULLET_LISTS = new Set(["bulletList", "taskList"])
/** The bullet a bullet or task list is written with in its source text. */
const sourceBullet = (source: string) => /^[ \t]*([-*+])(?:[ \t]|$)/u.exec(source)?.[1] ?? null

/** Records, for every item of a list that has source text, what the editor writes for it. */
function withItemSignatures(list: PMNode, prepared: PMNode): Fragment {
  if (!hasItemSources(list)) return list.content
  const { items } = normalizedListItems(prepared)
  const children: PMNode[] = []
  list.forEach((item, _offset, index) => {
    children.push(
      typeof item.attrs.markdownItemSource === "string"
        ? item.type.create(
            { ...item.attrs, markdownItemSignature: items[index] ?? null },
            item.content,
            item.marks,
          )
        : item,
    )
  })
  return Fragment.fromArray(children)
}

/** Records, for every block that has source text, what the editor would write for it. */
export function attachBlockSignatures(doc: PMNode): PMNode {
  const prepared = transformForSerialization(doc)
  const children: PMNode[] = []
  doc.forEach((child, _offset, index) => {
    if (typeof child.attrs.markdownBlockSource !== "string") {
      children.push(child)
      return
    }
    const signature = normalizedBlock(prepared.child(index))
    children.push(
      child.type.create(
        { ...child.attrs, markdownBlockSignature: signature },
        withItemSignatures(child, prepared.child(index)),
        child.marks,
      ),
    )
  })
  return doc.copy(Fragment.fromArray(children))
}

// An edited list, item by item: an item the editor would still write as it did when it
// read it is written as its own lines, the others in the editor's form. The result is
// used only when it reads back as the same list, for the editor's parser and for the
// independent one; otherwise the whole list is written in the editor's form, as before.
const listsByItems = new WeakMap<PMNode, string | null>()

function composeListByItems(prepared: PMNode, list: PMNode): string | null {
  const cached = listsByItems.get(list)
  if (cached !== undefined) return cached
  let result: string | null = null
  let anySource = false
  list.forEach((item) => {
    if (typeof item.attrs.markdownItemSource === "string") anySource = true
  })
  if (anySource) {
    const normalized = normalizedListItems(prepared)
    let out = ""
    let keptAny = false
    let previousKept: string | null = null
    prepared.forEach((item, _offset, index) => {
      const source = item.attrs.markdownItemSource
      const kept =
        typeof source === "string" && item.attrs.markdownItemSignature === normalized.items[index]
          ? source
          : null
      const gap = item.attrs.markdownItemGap
      const joinsAsRead =
        kept !== null &&
        previousKept !== null &&
        typeof gap === "string" &&
        item.attrs.markdownItemPrev === blockSourceKey(previousKept)
      if (index > 0) out += joinsAsRead ? `\n${gap}` : "\n"
      out += kept ?? normalized.items[index]
      if (kept !== null) keptAny = true
      previousKept = kept
    })
    if (keptAny && out !== normalized.text) {
      const reread = getMarkdownParser().parse(out)
      if (
        reread.childCount === 1 &&
        sameDocument(reread.child(0), list) &&
        markdownMeaning(out).content === markdownMeaning(normalized.text).content
      ) {
        result = out
      }
    }
  }
  listsByItems.set(list, result)
  return result
}

/** Where each top-level block landed in the written text, and how it got there. */
interface WrittenLayout {
  starts: number[]
  ends: number[]
  /** The block is written right after the previous block, both as they were read. */
  joined: boolean[]
  /** An empty block that is part of the text between two such blocks. */
  inGap: boolean[]
}

function writeWithKeptSource(
  doc: PMNode,
  kept: Array<string | null>,
  byItems: Array<string | null>,
): { markdown: string; layout: WrittenLayout } {
  const state = createSerializerState()
  const layout: WrittenLayout = {
    starts: new Array<number>(doc.childCount).fill(0),
    ends: new Array<number>(doc.childCount).fill(0),
    joined: new Array<boolean>(doc.childCount).fill(false),
    inGap: new Array<boolean>(doc.childCount).fill(false),
  }
  let last: { index: number; end: number; kept: string | null } | null = null
  // A block starts where its text does, after the newlines the previous block left pending.
  const startOf = (before: number) => {
    let at = before
    while (state.out.charCodeAt(at) === 10) at++
    return at
  }
  doc.forEach((child, _offset, index) => {
    if (isEmptyParagraph(child)) {
      state.render(child, doc, index)
      return
    }
    const before = state.out.length
    const source = kept[index]
    const gap = child.attrs.markdownBlockGap
    if (
      source !== null &&
      last !== null &&
      last.kept !== null &&
      typeof gap === "string" &&
      BLANK_LINES.test(gap) &&
      child.attrs.markdownBlockPrev === blockSourceKey(last.kept) &&
      // An extra blank line is an empty block of its own: all of them must still be there.
      index - last.index - 1 === Math.max(0, gap.split("\n").length - 2)
    ) {
      // The same two blocks, both unchanged, with the same blank blocks between them:
      // the text between them is written exactly as it was.
      const head = state.out.length === last.end ? state.out : state.out.slice(0, last.end)
      state.out = `${head}\n${gap}${source}`
      state.closed = null
      layout.joined[index] = true
      layout.starts[index] = state.out.length - source.length
      for (let empty = last.index + 1; empty < index; empty++) layout.inGap[empty] = true
    } else if (
      BULLET_LISTS.has(child.type.name) &&
      state.closed &&
      BULLET_LISTS.has(state.closed.type.name) &&
      sourceBullet(source ?? byItems[index] ?? "") === (state.lastBullet ?? null)
    ) {
      // Right after a list with the same bullet its own lines would join that list: the
      // serializer writes it with another bullet instead.
      state.render(child, doc, index)
      layout.starts[index] = startOf(before)
      layout.ends[index] = state.out.length
      last = { index, end: state.out.length, kept: null }
      return
    } else if (source !== null) {
      // Two lists in a row are kept apart the way `renderList` does it.
      if (isList(child) && state.closed && state.closed.type === child.type) state.flushClose(3)
      else if (BULLET_LISTS.has(child.type.name))
        bulletAfterList(state, sourceBullet(source) ?? "-")
      state.write(source)
      if (BULLET_LISTS.has(child.type.name)) state.lastBullet = sourceBullet(source) ?? undefined
      layout.starts[index] = state.out.length - source.length
    } else if (byItems[index] !== null) {
      // An edited list whose untouched items keep their own lines.
      if (state.closed && state.closed.type === child.type) state.flushClose(3)
      state.write(byItems[index]!)
      if (BULLET_LISTS.has(child.type.name)) {
        state.lastBullet = sourceBullet(byItems[index]!) ?? undefined
      }
      layout.starts[index] = startOf(before)
      layout.ends[index] = state.out.length
      state.closeBlock(child)
      last = { index, end: state.out.length, kept: null }
      return
    } else {
      state.render(child, doc, index)
      layout.starts[index] = startOf(before)
      layout.ends[index] = state.out.length
      last = { index, end: state.out.length, kept: null }
      return
    }
    layout.ends[index] = state.out.length
    state.closeBlock(child)
    last = { index, end: state.out.length, kept: source }
  })
  return { markdown: state.out, layout }
}

export interface ComposedMarkdown {
  markdown: string
  /**
   * The note holds text the editor would spell differently, so this save may be the one
   * that rewrites some of it. The previous file must be recoverable from history.
   */
  mayRewriteSource: boolean
}

// What a save may rely on instead of reading the whole text back. A block that is written
// right after its original neighbour, with the text between them as it was read, and whose
// neighbours on each side are in the same state, is read again exactly as it was when the
// note was opened: the note was admitted as a whole, and nothing around the block moved.
// Only the blocks around an edit are read back, with one such block of context on each
// side. Whatever cannot be shown this way is read back whole, as before.
const CONTEXT_BLOCKS = 2

/**
 * Whether the written text reads as the document, judged from the blocks around the edits
 * only. `false` means "not shown", never "different": the caller then reads the whole text.
 */
function readsBackLocally(
  doc: PMNode,
  kept: Array<string | null>,
  text: string,
  layout: WrittenLayout,
): boolean {
  const count = doc.childCount
  if (count === 0 || isEmptyParagraph(doc.child(0)) || isEmptyParagraph(doc.child(count - 1))) {
    return false
  }
  // A footnote can be defined far from where it is used.
  if (text.includes("[^")) return false
  const blocks: number[] = []
  doc.forEach((child, _offset, index) => {
    if (!isEmptyParagraph(child)) blocks.push(index)
  })
  const linked = (position: number) =>
    position === 0
      ? doc.child(blocks[0]).attrs.markdownBlockPrev === null
      : layout.joined[blocks[position]]
  const clean = (position: number) => {
    if (kept[blocks[position]] === null) return false
    for (let near = -CONTEXT_BLOCKS + 1; near <= CONTEXT_BLOCKS; near++) {
      const at = position + near
      if (at >= 0 && at < blocks.length && !linked(at)) return false
    }
    return true
  }
  const dirty = blocks.map((_block, position) => !clean(position))
  const parser = getMarkdownParser()
  let position = 0
  while (position < blocks.length) {
    if (!dirty[position]) {
      position++
      continue
    }
    let end = position
    while (end + 1 < blocks.length && dirty[end + 1]) end++
    const first = Math.max(0, position - 1)
    const last = Math.min(blocks.length - 1, end + 1)
    position = end + 1
    if (first === 0 && last === blocks.length - 1) return false
    const from = blocks[first]
    const to = blocks[last]
    const env: { references?: Record<string, unknown> } = {}
    const readBack = parser.parse(text.slice(layout.starts[from], layout.ends[to]), env)
    if (Object.keys(env.references ?? {}).length > 0) return false
    if (readBack.childCount !== to - from + 1) return false
    for (let index = 0; index < readBack.childCount; index++) {
      if (!sameDocument(readBack.child(index), doc.child(from + index))) return false
    }
  }
  return true
}

/** The document as Markdown: kept source for unchanged blocks, the editor's form otherwise. */
export function composeMarkdown(
  doc: PMNode,
  options: { forceFullReadBack?: boolean } = {},
): ComposedMarkdown {
  const prepared = prepareForSerialization(doc)
  const kept: Array<string | null> = []
  const byItems: Array<string | null> = []
  let anyKept = false
  let mayRewriteSource = false
  prepared.forEach((child, _offset, index) => {
    const source = isEmptyParagraph(child) ? null : keptSource(child)
    kept.push(source)
    const itemwise =
      source === null && isList(child) ? composeListByItems(child, doc.child(index)) : null
    byItems.push(itemwise)
    if (source !== null || itemwise !== null) anyKept = true
    const original = child.attrs.markdownBlockSource
    if (typeof original === "string") {
      const gap = child.attrs.markdownBlockGap
      if (original !== child.attrs.markdownBlockSignature) mayRewriteSource = true
      if (typeof gap === "string" && child.attrs.markdownBlockPrev !== null && gap !== "\n") {
        mayRewriteSource = true
      }
    }
  })
  if (!anyKept) return { markdown: serializeFragment(prepared), mayRewriteSource }

  const { markdown: composed, layout } = writeWithKeptSource(prepared, kept, byItems)
  if (!options.forceFullReadBack && readsBackLocally(doc, kept, composed, layout)) {
    return { markdown: composed, mayRewriteSource }
  }
  const normalized = serializeFragment(prepared)
  if (composed === normalized) return { markdown: normalized, mayRewriteSource }
  // Kept text in a new place can read differently (an indented paragraph moved under a
  // list, an unclosed fence before a new block). Read the result back before using it.
  const parser = getMarkdownParser()
  const env: { references?: Record<string, unknown> } = {}
  const readBack = parser.parse(composed, env)
  const sound =
    Object.keys(env.references ?? {}).length === 0 &&
    (sameDocument(readBack, doc) || sameDocument(readBack, parser.parse(normalized)))
  return { markdown: sound ? composed : normalized, mayRewriteSource }
}

/**
 * Whether writing this block in the editor's own form would change more than how it is
 * spelled. The block is judged on its own: its source and the editor's form of it must
 * read as the same block, for the editor's parser and for an independent one.
 */
function rewriteChangesMeaning(block: PMNode, source: string, signature: string): boolean {
  if (source === signature) return false
  const reread = getMarkdownParser().parse(signature)
  if (reread.childCount !== 1 || !sameDocument(reread.child(0), block)) return true
  return markdownMeaning(signature).content !== markdownMeaning(source).content
}

/**
 * A block the editor cannot rewrite without changing it is shown as its own source text
 * and written back exactly: the rest of the note stays editable in Live Preview. To
 * change such a block the user edits it in Source.
 */
function isolateUnsafeBlocks(doc: PMNode): PMNode {
  const opaque = editorSchema.nodes.opaqueMarkdownBlock
  let changed = false
  let afterFootnote = false
  const children: PMNode[] = []
  doc.forEach((child) => {
    const source = child.attrs.markdownBlockSource
    const signature = child.attrs.markdownBlockSignature
    // An indented block right under a footnote definition is the rest of that footnote
    // for a reader that knows footnotes; as a fenced code block it would not be.
    const continuesFootnote =
      afterFootnote && child.type.name === "codeBlock" && /^(?: {4}|\t)/u.test(String(source))
    if (!isEmptyParagraph(child)) {
      afterFootnote = child.type.name === "footnoteDefinition" || continuesFootnote
    }
    if (
      child.type === opaque ||
      typeof source !== "string" ||
      typeof signature !== "string" ||
      (!continuesFootnote && !rewriteChangesMeaning(child, source, signature))
    ) {
      children.push(child)
      return
    }
    changed = true
    children.push(
      opaque.create({
        kind: "source",
        value: source,
        markdownBlockSource: source,
        markdownBlockSignature: source,
        markdownBlockGap: child.attrs.markdownBlockGap,
        markdownBlockPrev: child.attrs.markdownBlockPrev,
      }),
    )
  })
  return changed ? doc.copy(Fragment.fromArray(children)) : doc
}

/** Reads Markdown into a document whose blocks keep their source text. */
export function parseMarkdown(markdown: string, env: object = {}): PMNode {
  return isolateUnsafeBlocks(attachBlockSignatures(getMarkdownParser().parse(markdown ?? "", env)))
}
