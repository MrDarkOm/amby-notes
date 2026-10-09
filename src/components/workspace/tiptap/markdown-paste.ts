import { Extension } from "@tiptap/core"
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model"
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state"
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

/** Replaces the selection with pasted Markdown; null when the text is pasted as it is. */
export function pasteMarkdown(state: EditorState, text: string): Transaction | null {
  const { $from } = state.selection
  // Code keeps what is pasted into it, character for character.
  if ($from.parent.type.spec.code) return null
  const parsed = markdownPasteContent(text)
  if (!parsed) return null
  // The parser has a schema of its own; an editor only takes nodes of its own schema.
  const content = Fragment.fromJSON(state.schema, parsed.toJSON())
  const only = content.childCount === 1 ? content.firstChild : null
  const tr = state.tr
  if (only && only.type.name === "paragraph") {
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
