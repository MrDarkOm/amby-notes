import { Fragment, type Node as PMNode } from "@tiptap/pm/model"
import { blockSourceKey } from "./markdown-block-plugins"
import { markdownMeaning } from "./markdown-meaning"
import { getMarkdownParser } from "./markdown-parser"
import {
  createSerializerState,
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
        child.content,
        child.marks,
      ),
    )
  })
  return doc.copy(Fragment.fromArray(children))
}

function writeWithKeptSource(doc: PMNode, kept: Array<string | null>): string {
  const state = createSerializerState()
  let last: { index: number; end: number; kept: string | null } | null = null
  doc.forEach((child, _offset, index) => {
    if (isEmptyParagraph(child)) {
      state.render(child, doc, index)
      return
    }
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
      state.out = `${state.out.slice(0, last.end)}\n${gap}${source}`
      state.closed = null
    } else if (source !== null) {
      // Two lists in a row are kept apart the way `renderList` does it.
      if (isList(child) && state.closed && state.closed.type === child.type) state.flushClose(3)
      state.write(source)
    } else {
      state.render(child, doc, index)
      last = { index, end: state.out.length, kept: null }
      return
    }
    state.closeBlock(child)
    last = { index, end: state.out.length, kept: source }
  })
  return state.out
}

export interface ComposedMarkdown {
  markdown: string
  /**
   * The note holds text the editor would spell differently, so this save may be the one
   * that rewrites some of it. The previous file must be recoverable from history.
   */
  mayRewriteSource: boolean
}

/** The document as Markdown: kept source for unchanged blocks, the editor's form otherwise. */
export function composeMarkdown(doc: PMNode): ComposedMarkdown {
  const prepared = transformForSerialization(doc)
  const normalized = serializeFragment(prepared)
  const kept: Array<string | null> = []
  let anyKept = false
  let mayRewriteSource = false
  prepared.forEach((child) => {
    const source = isEmptyParagraph(child) ? null : keptSource(child)
    kept.push(source)
    if (source !== null) anyKept = true
    const original = child.attrs.markdownBlockSource
    if (typeof original === "string") {
      const gap = child.attrs.markdownBlockGap
      if (original !== child.attrs.markdownBlockSignature) mayRewriteSource = true
      if (typeof gap === "string" && child.attrs.markdownBlockPrev !== null && gap !== "\n") {
        mayRewriteSource = true
      }
    }
  })
  if (!anyKept) return { markdown: normalized, mayRewriteSource }

  const composed = writeWithKeptSource(prepared, kept)
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
