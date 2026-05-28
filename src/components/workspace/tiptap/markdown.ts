// Markdown <-> ProseMirror conversion layer for the Tiptap editor.
//
// We own this layer (instead of a community package) so the on-disk format
// stays stable. Built on prosemirror-markdown + markdown-it:
//   - markdownToDoc: markdown string -> Tiptap JSON content
//   - docToMarkdown: ProseMirror doc -> markdown string
//
// Custom styled spans (<span style="color:...">) and <u> underlines are parsed
// by a dedicated markdown-it inline rule and, on the way out, materialized as
// inline `ambyHtml` nodes so their on-disk HTML matches the legacy format
// byte-for-byte (see buildStyledHtml / the AmbyHtml node).

import { Fragment, type Mark as PMMark, type Node as PMNode } from "@tiptap/pm/model"
import MarkdownIt from "markdown-it"
import type StateCore from "markdown-it/lib/rules_core/state_core.mjs"
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs"
import type Token from "markdown-it/lib/token.mjs"
import { MarkdownParser, MarkdownSerializerState } from "prosemirror-markdown"

import { editorSchema } from "./schema"
import { CALLOUT_DEFAULTS } from "./callout-node"
import {
  SAFE_UNDERLINE_RE,
  escapeHtml,
  parseSafeStyle,
  styleAttrsToCss,
  unescapeHtml,
} from "./constants"

export { editorSchema }

// ── markdown-it: custom inline rule for styled spans / underlines ──────────────

const SPAN_OPEN_RE = /^<span\s+style=["']([^"']*)["']>([\s\S]*?)<\/span>/i
const U_OPEN_RE = /^<u>([\s\S]*?)<\/u>/i

function pushText(state: StateInline, content: string) {
  const token = state.push("text", "", 0)
  token.content = content
}

function ambyInlineRule(state: StateInline, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== 0x3c /* < */) return false
  const rest = state.src.slice(state.pos)

  const spanMatch = SPAN_OPEN_RE.exec(rest)
  if (spanMatch) {
    const attrs = parseSafeStyle(spanMatch[1])
    if (attrs.color || attrs.backgroundColor) {
      if (!silent) {
        const open = state.push("amby_span_open", "span", 1)
        open.meta = { color: attrs.color ?? null, backgroundColor: attrs.backgroundColor ?? null }
        const underline = SAFE_UNDERLINE_RE.exec(spanMatch[2])
        if (underline) {
          state.push("amby_u_open", "u", 1)
          pushText(state, unescapeHtml(underline[1]))
          state.push("amby_u_close", "u", -1)
        } else {
          pushText(state, unescapeHtml(spanMatch[2]))
        }
        state.push("amby_span_close", "span", -1)
      }
      state.pos += spanMatch[0].length
      return true
    }
  }

  const uMatch = U_OPEN_RE.exec(rest)
  if (uMatch) {
    if (!silent) {
      state.push("amby_u_open", "u", 1)
      pushText(state, unescapeHtml(uMatch[1]))
      state.push("amby_u_close", "u", -1)
    }
    state.pos += uMatch[0].length
    return true
  }

  return false
}

// markdown-it: wrap table cell content in paragraphs and drop thead/tbody
// grouping tokens so they map cleanly onto the Tiptap table schema.
function normalizeTables(state: StateCore) {
  const out: Token[] = []
  for (const token of state.tokens) {
    const type = token.type
    if (type === "thead_open" || type === "thead_close" || type === "tbody_open" || type === "tbody_close") {
      continue
    }
    if (type === "th_open" || type === "td_open") {
      out.push(token)
      out.push(new state.Token("paragraph_open", "p", 1))
      continue
    }
    if (type === "th_close" || type === "td_close") {
      out.push(new state.Token("paragraph_close", "p", -1))
      out.push(token)
      continue
    }
    out.push(token)
  }
  state.tokens = out
}

const TASK_PREFIX_RE = /^\[([ xX])\]\s+/

// markdown-it: retag bullet lists whose every item is a `[ ]` / `[x]` checkbox
// as task lists, and strip the checkbox prefix from the item content.
function detectTaskLists(state: StateCore) {
  const tokens = state.tokens
  for (let i = 0; i < tokens.length; i++) {
    if (tokens[i].type !== "bullet_list_open") continue

    let depth = 0
    let close = -1
    for (let j = i; j < tokens.length; j++) {
      if (tokens[j].type === "bullet_list_open") depth++
      else if (tokens[j].type === "bullet_list_close") {
        depth--
        if (depth === 0) {
          close = j
          break
        }
      }
    }
    if (close < 0) continue

    const items: Array<{ open: number; close: number }> = []
    let itemDepth = 0
    for (let j = i + 1; j < close; j++) {
      if (tokens[j].type === "list_item_open") {
        itemDepth++
        if (itemDepth === 1) items.push({ open: j, close: -1 })
      } else if (tokens[j].type === "list_item_close") {
        if (itemDepth === 1) items[items.length - 1].close = j
        itemDepth--
      }
    }
    if (!items.length || items.some(it => it.close < 0)) continue

    const checks = items.map(it => {
      for (let j = it.open + 1; j < it.close; j++) {
        if (tokens[j].type === "inline") {
          const match = TASK_PREFIX_RE.exec(tokens[j].content)
          return match ? { token: tokens[j], checked: match[1].toLowerCase() === "x", len: match[0].length } : null
        }
      }
      return null
    })
    if (checks.some(c => c === null)) continue

    tokens[i].type = "task_list_open"
    tokens[close].type = "task_list_close"
    items.forEach((it, idx) => {
      const check = checks[idx]!
      tokens[it.open].type = "task_item_open"
      tokens[it.close].type = "task_item_close"
      tokens[it.open].meta = { checked: check.checked }
      const inline = check.token
      inline.content = inline.content.slice(check.len)
      const first = inline.children?.[0]
      if (first && first.type === "text") {
        first.content = first.content.replace(TASK_PREFIX_RE, "")
      }
    })
  }
}

// markdown-it: keep soft line breaks as real newlines so the author's line
// breaks (and multi-line callouts) survive the round-trip instead of being
// collapsed into spaces.
function softbreaksToText(state: StateCore) {
  for (const token of state.tokens) {
    if (token.type !== "inline" || !token.children) continue
    for (const child of token.children) {
      if (child.type === "softbreak") {
        child.type = "text"
        child.content = "\n"
      }
    }
  }
}

// ── markdown-it: detect Obsidian-style callouts (`> [!NOTE] emoji`) ──────────

const CALLOUT_FIRST_LINE_RE = /^\[!(NOTE|WARNING|INFO|TIP|DANGER)\](?:\s+(\S[^\n]*))?/i

/**
 * Transforms blockquotes whose first line is `[!TYPE] emoji` into `callout`
 * tokens so the MarkdownParser can create a proper `callout` ProseMirror node.
 *
 * Must run BEFORE softbreaksToText, AFTER detectTaskLists (order matters).
 */
function detectCallouts(state: StateCore) {
  const tokens = state.tokens
  const out: Token[] = []
  let i = 0

  while (i < tokens.length) {
    if (tokens[i].type !== "blockquote_open") {
      out.push(tokens[i++])
      continue
    }

    // Find the end of this blockquote
    let depth = 0
    let bqClose = -1
    for (let j = i; j < tokens.length; j++) {
      if (tokens[j].type === "blockquote_open") depth++
      else if (tokens[j].type === "blockquote_close") {
        depth--
        if (depth === 0) { bqClose = j; break }
      }
    }
    if (bqClose < 0) { out.push(tokens[i++]); continue }

    // Find the first paragraph (open / inline / close) inside the blockquote
    let firstParaOpen = -1, firstInlineIdx = -1, firstParaClose = -1
    for (let j = i + 1; j < bqClose; j++) {
      if (tokens[j].type === "paragraph_open" && firstParaOpen < 0) {
        firstParaOpen = j
      } else if (tokens[j].type === "inline" && firstParaOpen >= 0 && firstInlineIdx < 0) {
        firstInlineIdx = j
      } else if (tokens[j].type === "paragraph_close" && firstInlineIdx >= 0 && firstParaClose < 0) {
        firstParaClose = j
        break
      }
    }

    if (firstInlineIdx < 0) { out.push(tokens[i++]); continue }

    const firstInline = tokens[firstInlineIdx]
    const match = CALLOUT_FIRST_LINE_RE.exec(firstInline.content)
    if (!match) { out.push(tokens[i++]); continue }

    const calloutType = match[1].toUpperCase()
    const emojiRaw = (match[2] ?? "").trim()
    const emoji = emojiRaw || CALLOUT_DEFAULTS[calloutType] || "💡"

    // Strip the "[!TYPE] emoji" prefix from the first inline token
    const markerLen = match[0].length
    firstInline.content = firstInline.content.slice(markerLen).trimStart()
    if (firstInline.children?.length) {
      const fc = firstInline.children[0]
      if (fc.type === "text") {
        fc.content = fc.content.slice(markerLen).trimStart()
        if (!fc.content) firstInline.children.shift()
      }
      // Drop the leading softbreak that separates [!TYPE] line from content
      if (firstInline.children[0]?.type === "softbreak") firstInline.children.shift()
    }

    const skipFirstPara =
      !firstInline.content.trim() &&
      (!firstInline.children || firstInline.children.length === 0)

    const calloutOpen = new state.Token("callout_open", "div", 1)
    calloutOpen.attrSet("calloutType", calloutType)
    calloutOpen.attrSet("emoji", emoji)
    out.push(calloutOpen)

    // Emit inner tokens, optionally skipping the (now-empty) first paragraph
    for (let j = i + 1; j < bqClose; j++) {
      if (skipFirstPara && j >= firstParaOpen && j <= firstParaClose) continue
      out.push(tokens[j])
    }

    // Guarantee at least one block in the callout (ProseMirror requires block+)
    const innerCount = bqClose - i - 1 - (skipFirstPara ? firstParaClose - firstParaOpen + 1 : 0)
    if (innerCount <= 0) {
      out.push(new state.Token("paragraph_open", "p", 1))
      const empty = new state.Token("inline", "", 0)
      empty.content = ""
      empty.children = []
      out.push(empty)
      out.push(new state.Token("paragraph_close", "p", -1))
    }

    out.push(new state.Token("callout_close", "div", -1))
    i = bqClose + 1
  }

  state.tokens = out
}

// ── markdown-it: detect Amby special blocks (```amby-<type> fences) ──────────

const AMBY_BLOCK_INFO_RE = /^amby-([a-z0-9-]+)$/i

/**
 * Converts a fenced code block whose info string is `amby-<type>` into a single
 * `amby_block` token carrying { blockType, blockId } (the fence body is the id).
 * Keeps the note's `.md` portable: other editors just render a code block.
 */
function detectAmbyBlocks(state: StateCore) {
  for (const tok of state.tokens) {
    if (tok.type !== "fence") continue
    const m = AMBY_BLOCK_INFO_RE.exec(tok.info.trim())
    if (!m) continue
    tok.type = "amby_block"
    tok.tag = ""
    tok.meta = { ...(tok.meta ?? {}), blockType: m[1].toLowerCase(), blockId: tok.content.trim() }
  }
}

function ambyMarkdownItPlugin(md: MarkdownIt) {
  md.inline.ruler.before("html_inline", "amby_html", ambyInlineRule)
  md.core.ruler.push("amby_tables", normalizeTables)
  md.core.ruler.push("amby_task_lists", detectTaskLists)
  md.core.ruler.push("amby_blocks", detectAmbyBlocks)
  md.core.ruler.push("amby_callouts", detectCallouts)
  md.core.ruler.push("amby_softbreaks", softbreaksToText)
}

const tokenizer = new MarkdownIt("default", { html: true, linkify: false, breaks: false })
tokenizer.use(ambyMarkdownItPlugin)
// Read-only HTML render of an Amby block (Live mode uses the React NodeView).
tokenizer.renderer.rules.amby_block = (tokens, idx) => {
  const t = tokens[idx]
  const type = (t.meta?.blockType as string) ?? "db"
  return `<div class="amby-block-readonly" data-block-type="${type}">[${type}]</div>`
}

/** Render a markdown string to HTML using the shared tokenizer (read-only display). */
export function markdownToHtml(markdown: string): string {
  return tokenizer.render(markdown ?? "")
}

// ── Parser ────────────────────────────────────────────────────────────────────

const parser = new MarkdownParser(editorSchema, tokenizer, {
  callout: {
    block: "callout",
    getAttrs: tok => ({
      calloutType: tok.attrGet("calloutType") ?? "NOTE",
      emoji: tok.attrGet("emoji") ?? "💡",
    }),
  },
  blockquote: { block: "blockquote" },
  paragraph: { block: "paragraph" },
  list_item: { block: "listItem" },
  bullet_list: {
    block: "bulletList",
    getAttrs: tok => ({ markdownMarkup: tok.markup || null }),
  },
  ordered_list: {
    block: "orderedList",
    getAttrs: tok => ({ start: tok.attrGet("start") ? Number(tok.attrGet("start")) : 1 }),
  },
  task_list: { block: "taskList" },
  task_item: {
    block: "taskItem",
    getAttrs: tok => ({ checked: Boolean(tok.meta?.checked) }),
  },
  heading: { block: "heading", getAttrs: tok => ({ level: Number(tok.tag.slice(1)) }) },
  code_block: { block: "codeBlock", noCloseToken: true },
  fence: {
    block: "codeBlock",
    getAttrs: tok => ({ language: tok.info ? tok.info.trim().split(/\s+/)[0] : null }),
    noCloseToken: true,
  },
  hr: { node: "horizontalRule" },
  image: {
    node: "image",
    getAttrs: tok => ({
      src: tok.attrGet("src"),
      title: tok.attrGet("title") || null,
      alt: tok.children?.[0]?.content || null,
    }),
  },
  hardbreak: { node: "hardBreak" },
  table: { block: "table" },
  tr: { block: "tableRow" },
  th: { block: "tableHeader" },
  td: { block: "tableCell" },
  em: { mark: "italic", getAttrs: tok => ({ markdownMarkup: tok.markup || null }) },
  strong: { mark: "bold", getAttrs: tok => ({ markdownMarkup: tok.markup || null }) },
  s: { mark: "strike" },
  link: {
    mark: "link",
    getAttrs: tok => ({ href: tok.attrGet("href") }),
  },
  code_inline: { mark: "code", noCloseToken: true },
  html_inline: { node: "ambyHtml", noCloseToken: true, getAttrs: tok => ({ value: tok.content }) },
  html_block: { ignore: true, noCloseToken: true },
  amby_block: {
    node: "ambyBlock",
    getAttrs: tok => ({
      blockType: (tok.meta?.blockType as string) ?? "db",
      blockId: (tok.meta?.blockId as string) ?? "",
    }),
  },
  amby_span: {
    mark: "ambyTextStyle",
    getAttrs: tok => ({
      color: (tok.meta?.color as string | null) ?? null,
      backgroundColor: (tok.meta?.backgroundColor as string | null) ?? null,
    }),
  },
  amby_u: { mark: "ambyUnderline" },
})

export function markdownToDoc(markdown: string): Record<string, unknown> {
  const doc = parser.parse(markdown ?? "")
  return doc.toJSON() as Record<string, unknown>
}

// ── Serializer ────────────────────────────────────────────────────────────────

// Like prosemirror-markdown's default esc, but does NOT escape `[`, `]` or `#`
// so that [[wikilinks]] and #tags survive on disk exactly as typed.
function ambyEsc(str: string, startOfLine?: boolean): string {
  str = str.replace(/[`*\\~_]/g, (match, index: number) => {
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
  if (startOfLine) {
    str = str
      .replace(/^[-*+>]/, "\\$&")
      .replace(/^(\s*\d+)\./, "$1\\.")
      .replace(/^---/, "\\---")
  }
  return str
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
  open: string | ((state: MarkdownSerializerState, mark: PMMark, parent: PMNode, index: number) => string)
  close: string | ((state: MarkdownSerializerState, mark: PMMark, parent: PMNode, index: number) => string)
  mixable?: boolean
  expelEnclosingWhitespace?: boolean
  escape?: boolean
}

type SerializerState = MarkdownSerializerState & { esc: typeof ambyEsc; out: string }

const nodeSerializers: Record<
  string,
  (state: SerializerState, node: PMNode, parent: PMNode, index: number) => void
> = {
  doc(state, node) {
    state.renderContent(node)
  },
  paragraph(state, node) {
    state.renderInline(node)
    state.closeBlock(node)
  },
  text(state, node) {
    state.text(node.text ?? "")
  },
  heading(state, node) {
    state.write(state.repeat("#", node.attrs.level) + " ")
    state.renderInline(node, false)
    state.closeBlock(node)
  },
  blockquote(state, node) {
    state.wrapBlock("> ", null, node, () => state.renderContent(node))
  },
  callout(state, node) {
    const type = (node.attrs.calloutType as string) || "NOTE"
    const emoji = (node.attrs.emoji as string) || CALLOUT_DEFAULTS[type] || "💡"
    // Write the [!TYPE] header line with the emoji
    state.write(`> [!${type}] ${emoji}\n`)
    // Wrap the content lines with "> " prefix
    state.wrapBlock("> ", null, node, () => state.renderContent(node))
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
  bulletList(state, node) {
    const bullet = node.attrs.markdownMarkup || "-"
    state.renderList(node, "  ", () => bullet + " ")
  },
  orderedList(state, node) {
    const start = node.attrs.start || 1
    const maxWidth = String(start + node.childCount - 1).length
    const indent = state.repeat(" ", maxWidth + 2)
    state.renderList(node, indent, index => {
      const numeral = String(start + index)
      return state.repeat(" ", maxWidth - numeral.length) + numeral + ". "
    })
  },
  listItem(state, node) {
    state.renderContent(node)
  },
  taskList(state, node) {
    state.renderList(node, "  ", index => `- [${node.child(index).attrs.checked ? "x" : " "}] `)
  },
  taskItem(state, node) {
    state.renderContent(node)
  },
  hardBreak(state, node, parent, index) {
    for (let i = index + 1; i < parent.childCount; i++) {
      if (parent.child(i).type !== node.type) {
        state.write("\\\n")
        return
      }
    }
  },
  image(state, node) {
    state.write(
      "![" +
        state.esc(node.attrs.alt || "") +
        "](" +
        String(node.attrs.src || "").replace(/[()]/g, "\\$&") +
        (node.attrs.title ? ' "' + String(node.attrs.title).replace(/"/g, '\\"') + '"' : "") +
        ")"
    )
  },
  ambyHtml(state, node) {
    state.text(node.attrs.value ?? "", false)
  },
  table(state, node) {
    const rows: string[][] = []
    node.forEach(row => {
      const cells: string[] = []
      row.forEach(cell => cells.push(serializeTableCell(cell)))
      rows.push(cells)
    })
    if (!rows.length) {
      state.closeBlock(node)
      return
    }
    const columnCount = Math.max(...rows.map(row => row.length))
    const padded = rows.map(row => {
      const next = row.slice()
      while (next.length < columnCount) next.push(" ")
      return next
    })
    state.write("| " + padded[0].join(" | ") + " |")
    state.ensureNewLine()
    state.write("| " + padded[0].map(() => "---").join(" | ") + " |")
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
      "](" +
      String(mark.attrs.href || "").replace(/[()"]/g, "\\$&") +
      ")",
    mixable: true,
  },
}

const SerializerStateCtor = MarkdownSerializerState as unknown as new (
  nodes: typeof nodeSerializers,
  marks: typeof markSerializers,
  options: { tightLists?: boolean }
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

// Build the on-disk HTML for a text node carrying style / underline marks,
// matching the legacy Milkdown output exactly (underline nests inside the span).
function buildStyledHtml(text: string, marks: readonly PMNode["marks"][number][]): string {
  const textStyle = marks.find(mark => mark.type.name === "ambyTextStyle")
  const underline = marks.find(mark => mark.type.name === "ambyUnderline")
  let inner = escapeHtml(text)
  if (underline) inner = `<u>${inner}</u>`
  if (textStyle) {
    const style = styleAttrsToCss(textStyle.attrs as { color?: string | null; backgroundColor?: string | null })
    if (style) inner = `<span style="${style}">${inner}</span>`
  }
  return inner
}

// Replace text nodes carrying ambyTextStyle / ambyUnderline marks with inline
// `ambyHtml` nodes so the serializer emits their exact on-disk HTML form.
function transformForSerialization(node: PMNode): PMNode {
  if (node.isText) {
    const hasStyle = node.marks.some(
      mark => mark.type.name === "ambyTextStyle" || mark.type.name === "ambyUnderline"
    )
    if (!hasStyle) return node
    return editorSchema.nodes.ambyHtml.create({ value: buildStyledHtml(node.text ?? "", node.marks) })
  }
  if (node.childCount === 0) return node
  const children: PMNode[] = []
  node.forEach(child => children.push(transformForSerialization(child)))
  return node.copy(Fragment.fromArray(children))
}

export function docToMarkdown(doc: PMNode): string {
  return serializeFragment(transformForSerialization(doc))
}

// Dev-only round-trip helper: parse then re-serialize and report drift.
export function roundTripCheck(markdown: string): { ok: boolean; result: string } {
  const doc = parser.parse(markdown ?? "")
  const result = docToMarkdown(doc)
  return { ok: result.trim() === (markdown ?? "").trim(), result }
}
