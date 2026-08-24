import MarkdownIt from "markdown-it"
import type StateCore from "markdown-it/lib/rules_core/state_core.mjs"
import type Token from "markdown-it/lib/token.mjs"
import { ambyInlineRule } from "./markdown-inline"
import {
  detectAmbyBlocks,
  detectCallouts,
  detectMathBlocks,
  detectTransclusions,
} from "./markdown-special-blocks"

function normalizeTables(state: StateCore) {
  const out: Token[] = []
  for (let i = 0; i < state.tokens.length; i++) {
    const token = state.tokens[i]
    const type = token.type
    if (
      type === "thead_open" ||
      type === "thead_close" ||
      type === "tbody_open" ||
      type === "tbody_close"
    ) {
      continue
    }
    if (type === "table_open") {
      const startLine = token.map?.[0]
      const endLine = token.map?.[1]
      if (typeof startLine === "number" && typeof endLine === "number" && endLine > startLine) {
        const lines = state.src.split(/\r?\n/u)
        const separator = lines[startLine + 1]
        // Core rules receive tokens, not the block parser's bMarks/eMarks.
        // Keep a canonical-LF copy here; restoreSourceFormatting reapplies a
        // consistent CRLF convention at the document boundary.
        const source = lines.slice(startLine, endLine).join("\n")
        const signature: string[] = []
        for (let index = i + 1; index < state.tokens.length; index++) {
          const nested = state.tokens[index]
          if (nested.type === "table_close") break
          if (nested.type === "inline") signature.push(nested.content)
        }
        token.meta = {
          ...(token.meta ?? {}),
          markdownSeparator: separator ?? null,
          markdownSource: source,
          markdownSignature: JSON.stringify(signature),
        }
      }
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

export const COLUMNS_OPEN = "<!-- amby:columns -->"
export const COLUMN_OPEN = "<!-- amby:column -->"
export const COLUMNS_CLOSE = "<!-- /amby:columns -->"
const COLUMNS_OPEN_RE = /^<!-- amby:columns(?: widths="([0-9.,]+)")? -->$/u

function markerContent(token: Token): string {
  return token.type === "html_block" ? token.content.trim() : ""
}

function columnWidthsFromMarker(token: Token): string | null | undefined {
  const match = COLUMNS_OPEN_RE.exec(markerContent(token))
  return match ? (match[1] ?? null) : undefined
}

// Portable column layout: comments remain invisible in other Markdown
// previews, while every column body stays ordinary user-owned Markdown.
function detectColumns(state: StateCore) {
  const tokens = state.tokens
  const out: Token[] = []
  let index = 0

  while (index < tokens.length) {
    const widths = columnWidthsFromMarker(tokens[index])
    if (widths === undefined) {
      out.push(tokens[index++])
      continue
    }

    let end = index + 1
    let columnCount = 0
    for (; end < tokens.length; end++) {
      const marker = markerContent(tokens[end])
      if (columnWidthsFromMarker(tokens[end]) !== undefined) break
      if (marker === COLUMN_OPEN) columnCount++
      if (marker === COLUMNS_CLOSE) break
    }
    if (end >= tokens.length || markerContent(tokens[end]) !== COLUMNS_CLOSE || columnCount < 2) {
      out.push(tokens[index++])
      continue
    }

    const columnSetOpen = new state.Token("column_set_open", "div", 1)
    if (widths) columnSetOpen.attrSet("widths", widths)
    // Empty-paragraph preservation runs after column detection. Keep the
    // complete source range on the synthetic container so it knows that the
    // lines occupied by column markers/content are not a giant blank gap
    // between the surrounding top-level blocks.
    const sourceStart = tokens[index].map?.[0]
    const sourceEnd = tokens[end].map?.[1]
    if (typeof sourceStart === "number" && typeof sourceEnd === "number") {
      columnSetOpen.map = [sourceStart, sourceEnd]
    }
    out.push(columnSetOpen)
    let columnOpen = false
    for (let inner = index + 1; inner < end; inner++) {
      if (markerContent(tokens[inner]) === COLUMN_OPEN) {
        if (columnOpen) out.push(new state.Token("column_close", "div", -1))
        out.push(new state.Token("column_open", "div", 1))
        columnOpen = true
      } else if (columnOpen) {
        out.push(tokens[inner])
      }
    }
    if (columnOpen) out.push(new state.Token("column_close", "div", -1))
    out.push(new state.Token("column_set_close", "div", -1))
    index = end + 1
  }

  state.tokens = out
}

// Markdown uses one blank line to separate blocks. Every additional blank line
// is an intentional empty paragraph created in Live Preview, so retain it as a
// real ProseMirror node instead of collapsing it on the next mode switch.
function preserveEmptyParagraphs(state: StateCore) {
  const out: Token[] = []
  const sourceLines = state.src.split(/\r?\n/u)
  let depth = 0
  let previousTopLevelEnd: number | null = null

  function appendEmptyParagraphs(count: number) {
    for (let index = 0; index < count; index++) {
      out.push(new state.Token("paragraph_open", "p", 1))
      out.push(new state.Token("paragraph_close", "p", -1))
    }
  }

  for (const token of state.tokens) {
    const isTopLevelBlock =
      depth === 0 &&
      token.map &&
      token.map[1] >= token.map[0] &&
      // Containers open with nesting=1; fenced code, rules and HTML blocks
      // are leaf block tokens (nesting=0) and must also advance the source
      // boundary so they do not look like runs of empty paragraphs.
      (token.nesting === 1 || token.nesting === 0)
    if (isTopLevelBlock) {
      const [start, end] = token.map!
      if (previousTopLevelEnd !== null) {
        // A one-line gap is Markdown's normal block separator. Any following
        // blank lines are editable empty paragraphs.
        appendEmptyParagraphs(Math.max(0, start - previousTopLevelEnd - 1))
      }
      // markdown-it may include the normal separator line in a container's
      // map (notably lists). Trim only blank source lines from that mapped
      // tail, otherwise an intentional empty block immediately after a list
      // disappears when the following block is a column set.
      let contentEnd = end
      while (contentEnd > start && !(sourceLines[contentEnd - 1] ?? "").trim()) contentEnd--
      previousTopLevelEnd = contentEnd
    }
    out.push(token)
    depth += token.nesting
  }

  // A paragraph at the end needs two line endings in serialized Markdown;
  // further line endings stand for trailing empty paragraphs.
  const terminalBreaks = state.src.match(/(?:\r?\n)+$/u)?.[0] ?? ""
  const terminalCount = (terminalBreaks.match(/\n/g) ?? []).length
  if (previousTopLevelEnd !== null) appendEmptyParagraphs(Math.max(0, terminalCount - 2))

  state.tokens = out
}

// CommonMark treats ordered-list items separated by any number of blank lines
// as one loose list. In the block editor, however, an additional blank line is
// an explicit empty top-level block that separates two lists. Split that token
// stream before ProseMirror sees it so saving and reopening cannot merge the
// lists and renumber the second one.
function splitOrderedListsAtEmptyParagraphs(state: StateCore) {
  const tokens = state.tokens
  const insertions = new Map<number, Token[]>()
  const lines = state.src.split(/\r?\n/u)

  for (let openIndex = 0; openIndex < tokens.length; openIndex++) {
    const open = tokens[openIndex]
    if (open.type !== "ordered_list_open" || open.level !== 0) continue

    let closeIndex = -1
    for (let index = openIndex + 1; index < tokens.length; index++) {
      if (tokens[index].type === "ordered_list_close" && tokens[index].level === open.level) {
        closeIndex = index
        break
      }
    }
    if (closeIndex < 0) continue

    const itemStarts: number[] = []
    for (let index = openIndex + 1; index < closeIndex; index++) {
      const token = tokens[index]
      if (token.type === "list_item_open" && token.level === open.level + 1) {
        itemStarts.push(index)
      }
    }

    for (let itemIndex = 1; itemIndex < itemStarts.length; itemIndex++) {
      const previousStart = itemStarts[itemIndex - 1]
      const nextStart = itemStarts[itemIndex]
      const nextSourceLine = tokens[nextStart].map?.[0]
      if (typeof nextSourceLine !== "number") continue

      let previousContentEnd: number | null = null
      for (let index = previousStart + 1; index < nextStart; index++) {
        const token = tokens[index]
        if (!token.map || token.type.endsWith("_list_open") || token.type === "list_item_open") {
          continue
        }
        previousContentEnd = Math.max(previousContentEnd ?? token.map[1], token.map[1])
      }
      if (previousContentEnd === null) continue

      const emptyParagraphCount = nextSourceLine - previousContentEnd - 1
      if (emptyParagraphCount <= 0) continue

      const close = new state.Token("ordered_list_close", "ol", -1)
      close.level = open.level
      close.markup = open.markup
      close.block = true

      const reopen = new state.Token("ordered_list_open", "ol", 1)
      reopen.level = open.level
      reopen.markup = open.markup
      reopen.block = true
      reopen.map = [nextSourceLine, open.map?.[1] ?? nextSourceLine + 1]
      const marker = /^\s*(\d+)[.)]\s/u.exec(lines[nextSourceLine] ?? "")
      if (marker) reopen.attrSet("start", marker[1])

      const inserted: Token[] = [close]
      for (let index = 0; index < emptyParagraphCount; index++) {
        inserted.push(new state.Token("paragraph_open", "p", 1))
        inserted.push(new state.Token("paragraph_close", "p", -1))
      }
      inserted.push(reopen)
      insertions.set(nextStart, inserted)
    }

    openIndex = closeIndex
  }

  if (!insertions.size) return
  state.tokens = tokens.flatMap((token, index) => [...(insertions.get(index) ?? []), token])
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
    if (!items.length || items.some((it) => it.close < 0)) continue

    const checks = items.map((it) => {
      for (let j = it.open + 1; j < it.close; j++) {
        if (tokens[j].type === "inline") {
          const match = TASK_PREFIX_RE.exec(tokens[j].content)
          return match
            ? { token: tokens[j], checked: match[1].toLowerCase() === "x", len: match[0].length }
            : null
        }
      }
      return null
    })
    if (checks.some((c) => c === null)) continue

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

export function createAmbyTokenizer(): MarkdownIt {
  const tokenizer = new MarkdownIt("default", { html: true, linkify: false, breaks: false })
  ambyMarkdownItPlugin(tokenizer)
  return tokenizer
}

function ambyMarkdownItPlugin(md: MarkdownIt) {
  md.inline.ruler.before("html_inline", "amby_html", ambyInlineRule)
  md.core.ruler.push("amby_tables", normalizeTables)
  md.core.ruler.push("amby_columns", detectColumns)
  md.core.ruler.push("amby_empty_paragraphs", preserveEmptyParagraphs)
  md.core.ruler.push("amby_split_ordered_lists", splitOrderedListsAtEmptyParagraphs)
  md.core.ruler.push("amby_task_lists", detectTaskLists)
  md.core.ruler.push("amby_blocks", detectAmbyBlocks)
  md.core.ruler.push("amby_callouts", detectCallouts)
  md.core.ruler.push("amby_transclusions", detectTransclusions)
  md.core.ruler.push("amby_math_blocks", detectMathBlocks)
  md.core.ruler.push("amby_softbreaks", softbreaksToText)
}
