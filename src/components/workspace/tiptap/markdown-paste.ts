import { Extension } from "@tiptap/core"
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model"
import {
  Plugin,
  PluginKey,
  TextSelection,
  type EditorState,
  type Transaction,
} from "@tiptap/pm/state"
import type { Schema } from "@tiptap/pm/model"
import { imagesOnly, insertImageBlock } from "./image-placement"
import { sameDocument } from "./markdown-block-source"
import { getMarkdownParser } from "./markdown-parser"
import { docToNormalizedMarkdown } from "./markdown-serializer"

// Pasting plain text that is written as Markdown makes blocks out of it, with the same
// parser a note is read with. Pasted blocks are new blocks: they carry no source text of
// their own and are written in the editor's form, like anything typed in the editor.

/** Lines only Markdown would have: a heading, a list, a quote, a fence, a rule, a table. */
const BLOCK_SYNTAX = [
  /^ {0,3}#{1,6}[ \t]+\S/mu,
  /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\S/mu,
  /^ {0,3}>[ \t]?\S/mu,
  /^ {0,3}(?:```|~~~)/mu,
  /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/mu,
  /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/mu,
]

/** Inline markup: emphasis, code, a link or an image, a wikilink is left to the editor. */
const INLINE_SYNTAX =
  /(?:\*\*[^\s*][^*\n]*\*\*|__[^\s_][^_\n]*__|~~[^\s~][^~\n]*~~|`[^`\n]+`|!?\[[^\]\n]*\]\([^)\s]+[^)\n]*\))/u

/** Whether pasted plain text should be read as Markdown rather than as lines of text. */
export function looksLikeMarkdown(text: string): boolean {
  return (
    BLOCK_SYNTAX.some((pattern) => pattern.test(text)) ||
    INLINE_SYNTAX.test(text) ||
    // A wikilink alone is the same text either way; with other lines it marks Markdown.
    (/\[\[[^\]\n]+\]\]/u.test(text) && text.includes("\n"))
  )
}

// Markdown as it is written, which a rendered page does not show as text: a heading
// marker, a fence, a table delimiter, a link or an image, a wikilink, a callout, a task,
// bold. A bare `- item` is not in the list: rendered lists are copied that way too.
const SOURCE_ONLY_SYNTAX = [
  /^ {0,3}#{1,6}[ \t]+\S/mu,
  /^ {0,3}(?:```|~~~)/mu,
  /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)+\|?[ \t]*$/mu,
  /!?\[[^\]\n]*\]\([^)\s]+[^)\n]*\)/u,
  /\[\[[^\]\n]+\]\]/u,
  /^ {0,3}>[ \t]?\[![^\]\n]+\]/mu,
  /^[ \t]*[-*+][ \t]+\[[ xX]\][ \t]/mu,
  /\*\*[^\s*][^*\n]*\*\*/u,
]

/**
 * Whether a paste is read from its plain text as Markdown. With plain text alone that is
 * any text written as Markdown. An application that knows Markdown (Obsidian, Notion)
 * puts both the Markdown and a rendered copy on the clipboard; the rendered copy has
 * lost what only Markdown says — a wikilink is an ordinary link there, a callout a line
 * of text — so the Markdown is taken. Code copied from a code editor or a code block
 * stays code, and a page that was simply selected in a browser stays rich text.
 */
export function pastesAsMarkdown(text: string, html: string, types: readonly string[]): boolean {
  if (!html) return looksLikeMarkdown(text)
  if (types.includes("vscode-editor-data") || /<pre[\s>]/iu.test(html)) return false
  return SOURCE_ONLY_SYNTAX.some((pattern) => pattern.test(text))
}

const KEPT_SOURCE_ATTRIBUTES = [
  "markdownBlockSource",
  "markdownBlockSignature",
  "markdownBlockGap",
  "markdownBlockPrev",
  // A table keeps a source of its own.
  "markdownSource",
  "markdownSignature",
]

/** The same content with nothing remembered about how its Markdown was spelled. */
function asNewBlocks(node: PMNode): PMNode {
  if (node.isText) return node
  const children: PMNode[] = []
  node.forEach((child) => children.push(asNewBlocks(child)))
  const attrs: Record<string, unknown> = { ...node.attrs }
  for (const name of KEPT_SOURCE_ATTRIBUTES) if (name in attrs) attrs[name] = null
  return node.type.create(attrs, Fragment.fromArray(children), node.marks)
}

/**
 * The blocks pasted Markdown stands for, or null when the text is not Markdown or the
 * editor could not write what it read (then the text is pasted as plain text, unchanged).
 */
export function markdownPasteContent(text: string): Fragment | null {
  const markdown = text.replace(/\r\n?/gu, "\n").replace(/^\n+|\s+$/gu, "")
  if (!markdown || !looksLikeMarkdown(markdown)) return null
  const parser = getMarkdownParser()
  let doc: PMNode
  try {
    doc = asNewBlocks(parser.parse(markdown))
    // What is pasted must be what the note will hold after it is saved and read again.
    if (!sameDocument(parser.parse(docToNormalizedMarkdown(doc)), doc)) return null
  } catch {
    return null
  }
  return doc.childCount > 0 ? doc.content : null
}

const CELL_TYPES = ["tableCell", "tableHeader"]
const ROW_TYPES = ["table", "tableRow"]

/** Whether the caret (or a text selection) is in a table cell. */
function inTableCell(state: EditorState): boolean {
  if (!(state.selection instanceof TextSelection)) return false
  const { $from } = state.selection
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if (CELL_TYPES.includes($from.node(depth).type.name)) return true
  }
  return false
}

/**
 * A GFM table cell is one line of inline text (EDIT-01), so pasted blocks become the
 * inline content of one paragraph: paragraphs, list items, headings and the lines of a
 * code block are joined with a space (a cell has no `<br>` in this editor's Markdown, and
 * a line break would not survive a cell), inline marks are kept, a code block becomes
 * inline code. Pipes are escaped when the cell is written.
 */
export function flattenToInline(content: Fragment, schema: Schema): Fragment {
  const out: PMNode[] = []
  const pushSpace = () => {
    const last = out[out.length - 1]
    if (out.length > 0 && !(last.isText && /\s$/u.test(last.text ?? ""))) {
      out.push(schema.text(" "))
    }
  }
  const walk = (node: PMNode, inCode: boolean) => {
    if (node.isText) {
      const text = (node.text ?? "").replace(/\s*\n\s*/gu, " ")
      if (!text) return
      const code = inCode && schema.marks.code ? schema.marks.code.create() : null
      out.push(schema.text(text, code ? code.addToSet(node.marks) : node.marks))
    } else if (node.type.name === "hardBreak") {
      pushSpace()
    } else if (node.isInline) {
      out.push(node)
    } else if (node.isTextblock) {
      pushSpace()
      node.forEach((child) => walk(child, inCode || Boolean(node.type.spec.code)))
    } else {
      node.forEach((child) => walk(child, inCode))
    }
  }
  content.forEach((child) => walk(child, false))
  const blank = (node: PMNode) => node.isText && !(node.text ?? "").trim()
  while (out.length > 0 && blank(out[0])) out.shift()
  while (out.length > 0 && blank(out[out.length - 1])) out.pop()
  return Fragment.fromArray(out)
}

/** Replaces the selection with pasted Markdown; null when the text is pasted as it is. */
export function pasteMarkdown(state: EditorState, text: string): Transaction | null {
  const { $from } = state.selection
  // Code keeps what is pasted into it, character for character.
  if ($from.parent.type.spec.code) return null
  const parsed = markdownPasteContent(text)
  if (!parsed) return null
  // The parser has a schema of its own; an editor only takes nodes of its own schema.
  const pasted = Fragment.fromJSON(state.schema, parsed.toJSON())
  // A table cell holds one paragraph: what is pasted there becomes the text of it.
  if (inTableCell(state)) {
    const inline = flattenToInline(pasted, state.schema)
    if (inline.childCount === 0) return null
    return state.tr
      .replaceSelection(new Slice(inline, 0, 0))
      .scrollIntoView()
      .setMeta("paste", true)
      .setMeta("uiEvent", "paste")
  }
  const content = pasted
  const only = content.childCount === 1 ? content.firstChild : null
  const tr = state.tr
  const images = imagesOnly(content)
  if (images) {
    tr.deleteSelection()
    let pos = tr.selection.from
    for (const image of images) pos = insertImageBlock(tr, pos, image)
  } else if (only && only.type.name === "paragraph") {
    // One paragraph is text for the place the cursor is in, with the spaces around it
    // that Markdown itself would not keep.
    const lead = /^[ \t]*/u.exec(text)?.[0] ?? ""
    const trail = /[ \t]*$/u.exec(text)?.[0] ?? ""
    let inline = only.content
    if (lead) inline = Fragment.from(state.schema.text(lead)).append(inline)
    if (trail) inline = inline.append(Fragment.from(state.schema.text(trail)))
    tr.replaceSelection(new Slice(inline, 0, 0))
  } else {
    tr.replaceRange(state.selection.from, state.selection.to, new Slice(content, 0, 0))
  }
  return tr.scrollIntoView().setMeta("paste", true).setMeta("uiEvent", "paste")
}

export const MarkdownPaste = Extension.create({
  name: "markdownPaste",

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey("ambyMarkdownPaste"),
        props: {
          // Rich text and plain text with lines: in a cell they become one paragraph.
          transformPasted(slice, view) {
            if (!inTableCell(view.state)) return slice
            const first = slice.content.firstChild
            // Rows copied from a table are placed as cells by the table's own paste. Bare
            // cells are not that: the parser wraps text pasted in a cell in cells.
            if (first && ROW_TYPES.includes(first.type.name)) return slice
            return new Slice(flattenToInline(slice.content, view.state.schema), 0, 0)
          },
          handlePaste(view, event) {
            const data = event.clipboardData
            if (!data) return false
            // Files have their own handling; rich text stays rich unless it came with
            // the Markdown it was rendered from.
            if (data.files.length > 0) return false
            const text = data.getData("text/plain")
            if (!pastesAsMarkdown(text, data.getData("text/html"), Array.from(data.types))) {
              return false
            }
            const tr = pasteMarkdown(view.state, text)
            if (!tr) return false
            view.dispatch(tr)
            return true
          },
        },
      }),
    ]
  },
})
