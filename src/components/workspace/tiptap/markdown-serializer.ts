import { Fragment, type Mark as PMMark, type Node as PMNode } from "@tiptap/pm/model"
import MarkdownIt from "markdown-it"
import { MarkdownSerializerState } from "prosemirror-markdown"
import { CALLOUT_DEFAULTS } from "./callout-node"
import { escapeHtml, styleAttrsToCss } from "./constants"
import { COLUMN_OPEN, COLUMNS_CLOSE, COLUMNS_OPEN } from "./markdown-block-plugins"
import { editorSchema } from "./schema"

// A line cannot begin with whitespace in Markdown: a parser drops up to three spaces,
// and four or more turn the line into a code block. Text the user typed at the start
// of a line is therefore written with its first whitespace character as a numeric
// character reference (`&#32;`, `&#9;`, `&#160;`), which a reader turns back into that exact
// character. Anything that would otherwise open a block (list, quote, heading marker)
// is backslash-escaped, so what the editor writes is always read back as typed.
const entityProbe = new MarkdownIt()

// Any whitespace a parser trims counts (tab, no-break space and the other Unicode spaces).
const referenceFor = (char: string) => `&#${char.codePointAt(0)};`

type EscapeState = {
  out: string
  delim: string
  /** `out.length` right after a heading marker or a hard break was written. */
  headingStartAt?: number
  lineStartAt?: number
}

function ambyEsc(this: EscapeState | void, str: string, startOfLine?: boolean): string {
  const state = this || undefined
  // The text right after a heading marker is a line start for whitespace purposes,
  // though not for block markers (the `#` run already occupies the line). The first
  // text after a hard break begins a line for both.
  const afterHeadingMarker = Boolean(state && state.headingStartAt === state.out.length)
  const tail = state && state.lineStartAt !== undefined ? state.out.slice(state.lineStartAt) : null
  startOfLine = startOfLine || (tail !== null && (tail === "" || tail === state?.delim))
  str = str
    .replace(/[`*\\~_]/g, (match, index: number) => {
      if (
        match === "_" &&
        index > 0 &&
        index + 1 < str.length &&
        /\w/.test(str[index - 1]) &&
        /\w/.test(str[index + 1])
      ) {
        return match
      }
      return "\\" + match
    })
    // A literal `&#32;` or `&amp;` in the text must not be read as a character reference.
    .replace(/&(?:#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g, (reference) =>
      // Only a reference the Markdown parser really decodes is escaped: `AT&T;` is text.
      entityProbe.utils.unescapeAll(reference) === reference ? reference : `\\${reference}`,
    )
  if (startOfLine || afterHeadingMarker) {
    const lead = /^[^\S\r\n]/u.exec(str)?.[0]
    if (lead) return referenceFor(lead) + str.slice(lead.length)
  }
  if (startOfLine) {
    str = str
      .replace(/^[-*+>]/, "\\$&")
      .replace(/^(\d+)([.)])/, "$1\\$2")
      .replace(/^#{1,6}(?=[ \t]|$)/, "\\$&")
      .replace(/^---/, "\\---")
      .replace(/^</, "\\<")
  }
  return str
}

const TITLE_CLOSERS: Record<string, string> = { '"': '"', "'": "'", "(": ")" }

// A link title is written in the quoting form it was read in, double quotes otherwise.
// Only what would end the title or change its text is escaped, so a title is always read
// back as the same text; a source form this does not reproduce keeps its note in Source.
function linkTitleSource(mark: PMMark): string {
  const title = typeof mark.attrs.title === "string" ? mark.attrs.title : ""
  if (!title) return ""
  const open =
    (mark.attrs.markdownTitleMarkup as string) in TITLE_CLOSERS
      ? (mark.attrs.markdownTitleMarkup as string)
      : '"'
  const close = TITLE_CLOSERS[open]
  const escaped = title
    // A title is inline text: a line break inside it would leave the enclosing block.
    .replace(/\s*[\r\n]\s*/g, " ")
    .replace(
      /\\(?=[!-/:-@[-`{-~]|$)|["'()]|&(?:#\d+|#[xX][0-9a-fA-F]+|[A-Za-z][A-Za-z0-9]*);/g,
      (match) => {
        if (match === "\\") return "\\\\"
        if (match.length === 1) return match === open || match === close ? `\\${match}` : match
        return entityProbe.utils.unescapeAll(match) === match ? match : `\\${match}`
      },
    )
  return ` ${open}${escaped}${close}`
}

function backticksFor(node: PMNode, side: number): string {
  const ticks = /`+/g
  let len = 0
  if (node.isText && node.text) {
    let match: RegExpExecArray | null
    while ((match = ticks.exec(node.text))) len = Math.max(len, match[0].length)
  }
  let result = len > 0 && side > 0 ? " `" : "`"
  for (let i = 0; i < len; i++) result += "`"
  if (len > 0 && side < 0) result += " "
  return result
}

// prosemirror-markdown marks `MarkdownSerializerState`'s constructor and the
// `out` / `marks` members as @internal, so the public types omit them. We
// re-declare the bits we rely on locally.
type MarkSerializerSpec = {
  open:
    | string
    | ((state: MarkdownSerializerState, mark: PMMark, parent: PMNode, index: number) => string)
  close:
    | string
    | ((state: MarkdownSerializerState, mark: PMMark, parent: PMNode, index: number) => string)
  mixable?: boolean
  expelEnclosingWhitespace?: boolean
  escape?: boolean
}

type SerializerState = MarkdownSerializerState & {
  esc: typeof ambyEsc
  out: string
  flushClose: (size?: number) => void
  closed: PMNode | null
  inTightList: boolean
  options: { tightLists?: boolean }
}

const nodeSerializers: Record<
  string,
  (state: SerializerState, node: PMNode, parent: PMNode, index: number) => void
> = {
  doc(state, node) {
    state.renderContent(node)
  },
  paragraph(state, node, parent) {
    if (node.childCount === 0 && (parent.type.name === "doc" || parent.type.name === "column")) {
      // A single empty paragraph is ProseMirror's structural representation of
      // a genuinely empty Markdown document; it must not materialise a newline
      // merely because the editor mounted or received a focus transaction.
      if (parent.childCount === 1) return
      // The stock serializer coalesces an empty paragraph into the surrounding
      // block separator. Emit one extra line so it survives parsing and a
      // Source ↔ Live transition as a genuine blank block.
      state.flushClose()
      state.write("\n")
      return
    }
    state.renderInline(node)
    state.closeBlock(node)
  },
  text(state, node) {
    state.text(node.text ?? "")
  },
  heading(state, node) {
    state.write(state.repeat("#", node.attrs.level) + " ")
    const contentStart = state.out.length
    ;(state as unknown as EscapeState).headingStartAt = contentStart
    state.renderInline(node, false)
    // A trailing run of `#` after a space is a closing sequence, not text.
    const written = state.out.slice(contentStart)
    const closing = /(^|[ \t])(#+)[ \t]*$/.exec(written)
    if (closing) {
      const at = contentStart + closing.index + closing[1].length
      state.out = `${state.out.slice(0, at)}\\${state.out.slice(at)}`
    }
    state.closeBlock(node)
  },
  blockquote(state, node) {
    state.wrapBlock("> ", null, node, () => state.renderContent(node))
  },
  callout(state, node) {
    const type = (node.attrs.calloutType as string) || "NOTE"
    const emoji = (node.attrs.emoji as string) || CALLOUT_DEFAULTS[type] || "💡"
    if (node.attrs.hasRawHeader && node.attrs.headerContentInBody) {
      const content = serializeFragment(node)
      const lineBreak = content.indexOf("\n")
      const headerContent = lineBreak < 0 ? content : content.slice(0, lineBreak)
      let body = lineBreak < 0 ? "" : content.slice(lineBreak + 1)
      if (node.attrs.headerBodyTight && body.startsWith("\n")) body = body.slice(1)
      state.write(`> [!${type}]${(node.attrs.headerPrefix as string) || " "}${headerContent}`)
      if (body) {
        state.write("\n")
        state.write(
          body
            .split("\n")
            .map((line) => `> ${line}`)
            .join("\n"),
        )
      }
      state.closeBlock(node)
      return
    }
    const header = node.attrs.hasRawHeader
      ? ((node.attrs.headerPrefix || node.attrs.headerSuffix) as string)
      : ` ${emoji}`
    state.write(`> [!${type}]${header}\n`)
    state.wrapBlock("> ", null, node, () => state.renderContent(node))
  },
  columnSet(state, node) {
    const columns: string[] = []
    node.forEach((column) => {
      // Empty paragraphs at the end of a column are written as extra line breaks;
      // the separator to the next marker already supplies the normal blank line.
      let trailingEmpty = 0
      for (let at = column.childCount - 1; at > 0; at--) {
        const child = column.child(at)
        if (child.type.name !== "paragraph" || child.childCount !== 0) break
        trailingEmpty++
      }
      const body = serializeFragment(column).replace(/\n+$/u, "") + "\n".repeat(trailingEmpty)
      columns.push(`${COLUMN_OPEN}\n\n${body}`)
    })
    const open = node.attrs.widths
      ? `<!-- amby:columns widths="${node.attrs.widths as string}" -->`
      : COLUMNS_OPEN
    state.write(`${open}\n\n${columns.join("\n\n")}\n\n${COLUMNS_CLOSE}`)
    state.closeBlock(node)
  },
  column(state, node) {
    state.renderContent(node)
  },
  codeBlock(state, node) {
    const fenceMatches = node.textContent.match(/`{3,}/gm)
    const fence = fenceMatches ? fenceMatches.sort().slice(-1)[0] + "`" : "```"
    state.write(fence + (node.attrs.language || "") + "\n")
    state.text(node.textContent, false)
    state.write("\n")
    state.write(fence)
    state.closeBlock(node)
  },
  horizontalRule(state, node) {
    state.write("---")
    state.closeBlock(node)
  },
  ambyBlock(state, node) {
    const type = (node.attrs.blockType as string) || "db"
    state.write("```amby-" + type + "\n")
    state.text((node.attrs.blockId as string) || "", false)
    state.write("\n```")
    state.closeBlock(node)
  },
  transclusion(state, node) {
    state.write(`![[${(node.attrs.raw as string) || (node.attrs.target as string)}]]`)
    state.closeBlock(node)
  },
  bulletList(state, node) {
    const bullet = node.attrs.markdownMarkup || "-"
    state.renderList(node, "  ", () => bullet + " ")
  },
  orderedList(state, node) {
    const start = node.attrs.start || 1
    // Numbers are right-aligned only in a list that was read that way from disk.
    const maxWidth = node.attrs.markdownPadded ? String(start + node.childCount - 1).length : 0
    // `renderList` with one difference: what follows the first line of an item is
    // indented by the width of that item's own marker (`9. ` and `10. ` differ).
    if (state.closed && state.closed.type === node.type) state.flushClose(3)
    else if (state.inTightList) state.flushClose(1)
    const isTight =
      typeof node.attrs.tight !== "undefined" ? node.attrs.tight : state.options.tightLists
    const prevTight = state.inTightList
    state.inTightList = isTight
    node.forEach((child, _offset, index) => {
      if (index && isTight) state.flushClose(1)
      const marker = String(start + index).padStart(maxWidth) + ". "
      state.wrapBlock(state.repeat(" ", marker.length), marker, node, () =>
        state.render(child, node, index),
      )
    })
    state.inTightList = prevTight
  },
  listItem(state, node) {
    state.renderContent(node)
  },
  taskList(state, node) {
    state.renderList(node, "  ", (index) => `- [${node.child(index).attrs.checked ? "x" : " "}] `)
  },
  taskItem(state, node) {
    state.renderContent(node)
  },
  hardBreak(state, node, parent, index) {
    for (let i = index + 1; i < parent.childCount; i++) {
      if (parent.child(i).type !== node.type) {
        state.write("\\\n")
        ;(state as unknown as EscapeState).lineStartAt = state.out.length
        return
      }
    }
  },
  image(state, node) {
    let altPart = (node.attrs.alt as string | undefined) || ""
    const width = node.attrs.width as number | string | null | undefined
    const height = node.attrs.height as number | string | null | undefined
    if (width) {
      const sizeStr = height ? `${width}x${height}` : `${width}`
      if (altPart) {
        altPart = `${altPart}|${sizeStr}`
      } else if (node.attrs.hasPipe) {
        altPart = `|${sizeStr}`
      } else {
        altPart = sizeStr
      }
    }
    state.write(
      "![" +
        state.esc(altPart) +
        "](" +
        String(node.attrs.src || "").replace(/[()]/g, "\\$&") +
        (node.attrs.title ? ' "' + String(node.attrs.title).replace(/"/g, '\\"') + '"' : "") +
        ")",
    )
  },
  ambyHtml(state, node) {
    state.text(node.attrs.value ?? "", false)
  },
  opaqueHtmlBlock(state, node) {
    state.write(node.attrs.value ?? "")
    state.closeBlock(node)
  },
  opaqueMarkdownBlock(state, node) {
    state.write(node.attrs.value ?? "")
    state.closeBlock(node)
  },
  table(state, node) {
    const rows: string[][] = []
    node.forEach((row) => {
      const cells: string[] = []
      row.forEach((cell) => cells.push(serializeTableCell(cell)))
      rows.push(cells)
    })
    if (!rows.length) {
      state.closeBlock(node)
      return
    }
    const originalSource = node.attrs.markdownSource
    if (
      typeof originalSource === "string" &&
      node.attrs.markdownSignature === tableSignatureFromRows(rows)
    ) {
      state.write(originalSource)
      state.closeBlock(node)
      return
    }
    const columnCount = Math.max(...rows.map((row) => row.length))
    const padded = rows.map((row) => {
      const next = row.slice()
      while (next.length < columnCount) next.push(" ")
      return next
    })
    state.write("| " + padded[0].join(" | ") + " |")
    state.ensureNewLine()
    state.write(tableSeparator(node, padded[0].length))
    state.ensureNewLine()
    for (let r = 1; r < padded.length; r++) {
      state.write("| " + padded[r].join(" | ") + " |")
      state.ensureNewLine()
    }
    state.closeBlock(node)
  },
  tableRow(state, node) {
    state.renderContent(node)
  },
  tableHeader(state, node) {
    state.renderContent(node)
  },
  tableCell(state, node) {
    state.renderContent(node)
  },
}

const markSerializers: Record<string, MarkSerializerSpec> = {
  bold: {
    open: (_state, mark) => mark.attrs.markdownMarkup || "**",
    close: (_state, mark) => mark.attrs.markdownMarkup || "**",
    mixable: true,
    expelEnclosingWhitespace: true,
  },
  italic: {
    open: (_state, mark) => mark.attrs.markdownMarkup || "*",
    close: (_state, mark) => mark.attrs.markdownMarkup || "*",
    mixable: true,
    expelEnclosingWhitespace: true,
  },
  strike: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true },
  code: {
    open: (_state, _mark, parent, index) => backticksFor(parent.child(index), -1),
    close: (_state, _mark, parent, index) => backticksFor(parent.child(index - 1), 1),
    escape: false,
  },
  link: {
    open: "[",
    close: (_state, mark) =>
      "](" + String(mark.attrs.href || "").replace(/[()"]/g, "\\$&") + linkTitleSource(mark) + ")",
    mixable: true,
  },
}

const SerializerStateCtor = MarkdownSerializerState as unknown as new (
  nodes: typeof nodeSerializers,
  marks: typeof markSerializers,
  options: { tightLists?: boolean },
) => SerializerState

function createSerializerState(): SerializerState {
  const state = new SerializerStateCtor(nodeSerializers, markSerializers, { tightLists: true })
  state.esc = ambyEsc
  return state
}

function serializeFragment(content: PMNode): string {
  const state = createSerializerState()
  state.renderContent(content)
  return state.out
}

// Render a single table cell's content to inline markdown, collapsed onto one
// line with pipes escaped.
function serializeTableCell(cell: PMNode): string {
  const doc = editorSchema.topNodeType.create(null, cell.content)
  const md = serializeFragment(doc).trim().replace(/\|/g, "\\|").replace(/\n+/g, " ")
  return md || " "
}

function tableSeparator(table: PMNode, columnCount: number): string {
  const original = table.attrs.markdownSeparator
  if (typeof original === "string") {
    const cells = original
      .trim()
      .split("|")
      .map((cell) => cell.trim())
      .filter(Boolean)
    if (cells.length === columnCount && cells.every((cell) => /^:?-{3,}:?$/u.test(cell))) {
      return original
    }
  }
  return "| " + Array.from({ length: columnCount }, () => "---").join(" | ") + " |"
}

function tableSignatureFromRows(rows: string[][]): string {
  return JSON.stringify(rows.flat())
}

// Build the on-disk HTML for a text node carrying style / underline marks,
// matching the legacy Milkdown output exactly (underline nests inside the span).
function buildStyledHtml(text: string, marks: readonly PMNode["marks"][number][]): string {
  const textStyle = marks.find((mark) => mark.type.name === "ambyTextStyle")
  const underline = marks.find((mark) => mark.type.name === "ambyUnderline")
  let inner = escapeHtml(text)
  if (underline) inner = `<u>${inner}</u>`
  if (textStyle) {
    const style = styleAttrsToCss(
      textStyle.attrs as { color?: string | null; backgroundColor?: string | null },
    )
    if (style) inner = `<span style="${style}">${inner}</span>`
  }
  return inner
}

// Replace text nodes carrying ambyTextStyle / ambyUnderline marks with inline
// `ambyHtml` nodes so the serializer emits their exact on-disk HTML form.
function transformForSerialization(node: PMNode): PMNode {
  if (node.isText) {
    const hasStyle = node.marks.some(
      (mark) => mark.type.name === "ambyTextStyle" || mark.type.name === "ambyUnderline",
    )
    if (!hasStyle) return node
    return editorSchema.nodes.ambyHtml.create({
      value: buildStyledHtml(node.text ?? "", node.marks),
    })
  }
  if (node.childCount === 0) return node
  const children: PMNode[] = []
  node.forEach((child) => children.push(transformForSerialization(child)))
  return node.copy(Fragment.fromArray(children))
}

export function docToMarkdown(doc: PMNode): string {
  return serializeFragment(transformForSerialization(doc))
}

// ProseMirror documents represent neither a document's terminal line-breaks
// nor its preferred line-ending form. Both are nevertheless file data: losing
// them on an unrelated Live Preview edit is a silent Markdown normalization.
// Restore them at the editor boundary. Mixed line endings remain Source-only —
