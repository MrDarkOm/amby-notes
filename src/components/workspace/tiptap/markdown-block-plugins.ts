import {
  detectFootnoteDefinitions,
  footnoteInlineRule,
  footnoteReferenceRule,
  referenceUnlessFootnote,
} from "./markdown-footnotes"
import { inlineMathRule } from "./markdown-math"
import MarkdownIt from "markdown-it"
import type StateCore from "markdown-it/lib/rules_core/state_core.mjs"
import type Token from "markdown-it/lib/token.mjs"
import { ambyInlineRule, linkWithTitleMarkup } from "./markdown-inline"
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
    // A column keeps the source lines of its opening marker and of the marker that
    // ends it, so blank lines at its start and end can be read as empty paragraphs.
    const columnClose = (endingMarker: Token) => {
      const close = new state.Token("column_close", "div", -1)
      if (endingMarker.map) close.map = [endingMarker.map[0], endingMarker.map[1]]
      return close
    }
    let columnOpen = false
    for (let inner = index + 1; inner < end; inner++) {
      if (markerContent(tokens[inner]) === COLUMN_OPEN) {
        if (columnOpen) out.push(columnClose(tokens[inner]))
        const open = new state.Token("column_open", "div", 1)
        const markerMap = tokens[inner].map
        if (markerMap) open.map = [markerMap[0], markerMap[1]]
        out.push(open)
        columnOpen = true
      } else if (columnOpen) {
        out.push(tokens[inner])
      }
    }
    if (columnOpen) out.push(columnClose(tokens[end]))
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
  // Inside a column the same rule applies: its first block follows the column marker
  // and its last one precedes the next marker, so those gaps count as well.
  let previousColumnEnd: number | null = null
  let columnHasBlock = false

  function appendEmptyParagraphs(count: number) {
    for (let index = 0; index < count; index++) {
      out.push(new state.Token("paragraph_open", "p", 1))
      out.push(new state.Token("paragraph_close", "p", -1))
    }
  }

  for (const token of state.tokens) {
    if (token.type === "column_open" && token.map) {
      previousColumnEnd = token.map[1]
      columnHasBlock = false
    }
    if (token.type === "column_close" && token.map && previousColumnEnd !== null) {
      const blankLines = token.map[0] - previousColumnEnd
      // A column with blocks: one blank line is the normal separator, the rest are
      // empty paragraphs. A column with nothing in it has always been written as
      // three blank lines (its one empty paragraph); each line beyond is one more.
      appendEmptyParagraphs(
        columnHasBlock ? Math.max(0, blankLines - 1) : Math.max(1, blankLines - 2),
      )
      previousColumnEnd = null
    }
    // Blocks directly inside a column: set (1) > column (2) > block.
    const isColumnBlock =
      previousColumnEnd !== null &&
      depth === 2 &&
      token.map &&
      token.map[1] >= token.map[0] &&
      (token.nesting === 1 || token.nesting === 0)
    if (isColumnBlock) {
      const [start, end] = token.map!
      appendEmptyParagraphs(Math.max(0, start - previousColumnEnd! - 1))
      let contentEnd = end
      while (contentEnd > start && !(sourceLines[contentEnd - 1] ?? "").trim()) contentEnd--
      previousColumnEnd = contentEnd
      columnHasBlock = true
    }
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
        // Drop exactly the characters the raw prefix took: a space the user typed after it
        // may arrive as a character reference and is text, not part of the prefix.
        first.content = /^\[[ xX]\]/.test(first.content)
          ? first.content.slice(check.len)
          : first.content.replace(TASK_PREFIX_RE, "")
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

// markdown-it trims the content of a paragraph and of an ATX heading, so spaces and
// tabs at the end of its last line never reach the document, while the serializer
// writes text as it is. A space typed at the end of a paragraph therefore could not be
// read back and the note was treated as lossy. Put the stripped whitespace back as
// plain text: the bytes round-trip and nothing is trimmed in the user's file. A
// rendered paragraph is unchanged, because renderers ignore trailing spaces.
function preserveTrailingWhitespace(state: StateCore) {
  const lines = state.src.split("\n")
  const tokens = state.tokens
  for (let index = 1; index < tokens.length; index++) {
    const inline = tokens[index]
    if (inline.type !== "inline" || !inline.children?.length) continue
    const open = tokens[index - 1]
    const isParagraph = open.type === "paragraph_open"
    const isAtxHeading = open.type === "heading_open" && open.markup.startsWith("#")
    if ((!isParagraph && !isAtxHeading) || !open.map) continue
    // Anything this puts back that the file does not hold in exactly that form
    // (a closing `#` run, a lazy continuation) still fails the round-trip check
    // and keeps the note in Source mode.
    const trailing = /[ \t]+$/u.exec(lines[open.map[1] - 1] ?? "")?.[0]
    if (!trailing) continue
    const text = new state.Token("text", "", 0)
    text.content = trailing
    inline.children.push(text)
  }
}

// Earlier versions of the editor right-aligned the numbers of an ordered list (` 9.`
// above `10.`). Such a list is recognised by its numbers having different widths while
// their delimiters stand in one column, and is marked so that it is written back the
// same way. Every other list is written without padding.
function detectPaddedOrderedLists(state: StateCore) {
  const lines = state.src.split("\n")
  // Several markers may share a line (`1. 1. text`): each is searched after the previous.
  const searchFrom = new Map<number, number>()
  type OpenList = { open: Token; delimiterAt: Set<number>; widths: Set<number>; known: boolean }
  const stack: Array<OpenList | null> = []

  for (const token of state.tokens) {
    if (token.type === "ordered_list_open") {
      stack.push({ open: token, delimiterAt: new Set(), widths: new Set(), known: true })
    } else if (token.type === "bullet_list_open") {
      stack.push(null)
    } else if (token.type === "ordered_list_close" || token.type === "bullet_list_close") {
      const list = stack.pop()
      if (list?.known && list.widths.size > 1 && list.delimiterAt.size === 1) {
        list.open.meta = { ...(list.open.meta ?? {}), padded: true }
      }
    } else if (token.type === "list_item_open") {
      const list = stack[stack.length - 1]
      if (!list) continue
      const lineNumber = token.map?.[0]
      const line = typeof lineNumber === "number" ? lines[lineNumber] : undefined
      const marker = token.info + token.markup
      let at =
        line === undefined || !token.info ? -1 : line.indexOf(marker, searchFrom.get(lineNumber!))
      while (at > 0 && /\d/u.test(line![at - 1])) at = line!.indexOf(marker, at + 1)
      if (at < 0) {
        list.known = false
        continue
      }
      searchFrom.set(lineNumber!, at + marker.length)
      list.widths.add(token.info.length)
      list.delimiterAt.add(at + token.info.length)
    }
  }
}

/** A short key of a block's source text; it only tells whether two blocks were neighbours. */
export function blockSourceKey(source: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < source.length; index++) {
    hash = Math.imul(hash ^ source.charCodeAt(index), 0x01000193)
  }
  return `${source.length}:${(hash >>> 0).toString(16)}`
}

const BLANK_LINE = /^[ \t]*$/u

// Every top-level block keeps the lines it was read from, and the lines between it and
// the block before it. The serializer writes them back while the block is unchanged, so
// a form the editor would write differently (`* * *`, `1)`, a sparse list) survives a
// save. Runs last: by now the token stream is the one the document is built from.
function attachBlockSources(state: StateCore) {
  const lines = state.src.split("\n")
  const blocks: Token[] = []
  let depth = 0
  for (const token of state.tokens) {
    if (depth === 0 && token.nesting >= 0 && token.map) blocks.push(token)
    depth += token.nesting
  }

  let previous: { end: number; source: string } | null = null
  blocks.forEach((token, index) => {
    const start = token.map![0]
    // A list split at an empty block keeps the range of the whole original list.
    let end = Math.min(token.map![1], blocks[index + 1]?.map?.[0] ?? lines.length, lines.length)
    while (end > start && BLANK_LINE.test(lines[end - 1])) end--
    if (end <= start || start < (previous?.end ?? 0)) return
    const source = lines.slice(start, end).join("\n")
    const between = lines.slice(previous?.end ?? 0, start)
    token.meta = {
      ...(token.meta ?? {}),
      blockSource: source,
      // The first block has no neighbour to join; its gap only records text before it.
      blockGap:
        previous || between.some((line) => !BLANK_LINE.test(line))
          ? between.map((line) => `${line}\n`).join("")
          : null,
      blockPrev: previous ? blockSourceKey(previous.source) : null,
    }
    previous = { end, source }
    attachItemSources(state.tokens, token, lines, start, end)
  })
}

const LIST_OPEN = new Set(["bullet_list_open", "ordered_list_open", "task_list_open"])
const ITEM_OPEN = new Set(["list_item_open", "task_item_open"])

// The items of a top-level list keep their own lines too, so that an edit to one item
// leaves the others as they were written. Only a list whose items lie one after another
// inside the list's own lines is recorded; anything else is written as a whole.
function attachItemSources(
  tokens: Token[],
  list: Token,
  lines: string[],
  listStart: number,
  listEnd: number,
) {
  if (!LIST_OPEN.has(list.type)) return
  const items: Token[] = []
  let depth = 0
  for (let index = tokens.indexOf(list); index < tokens.length; index++) {
    const token = tokens[index]
    if (depth === 1 && ITEM_OPEN.has(token.type)) items.push(token)
    depth += token.nesting
    if (depth === 0) break
  }
  const ranges: Array<{ start: number; end: number }> = []
  for (let index = 0; index < items.length; index++) {
    const map = items[index].map
    if (!map) return
    const start = map[0]
    let end = Math.min(map[1], items[index + 1]?.map?.[0] ?? listEnd, listEnd)
    while (end > start && BLANK_LINE.test(lines[end - 1])) end--
    const previousEnd = ranges[index - 1]?.end ?? listStart
    if (end <= start || start < previousEnd || (index === 0 && start !== listStart)) return
    ranges.push({ start, end })
  }
  let previousSource: string | null = null
  ranges.forEach((range, index) => {
    const source = lines.slice(range.start, range.end).join("\n")
    const between = lines.slice(ranges[index - 1]?.end ?? listStart, range.start)
    // Only blank lines may stand between two items; anything else is not ours to keep.
    const blank = between.every((line) => BLANK_LINE.test(line))
    items[index].meta = {
      ...(items[index].meta ?? {}),
      itemSource: source,
      itemGap:
        previousSource !== null && blank ? between.map((line) => `${line}\n`).join("") : null,
      itemPrev: previousSource !== null && blank ? blockSourceKey(previousSource) : null,
    }
    previousSource = source
  })
}

// ── markdown-it: detect Obsidian-style callouts (`> [!NOTE] emoji`) ──────────

const EMPHASIS_TOKENS = new Set(["strong", "em", "s"])

// Bold inside bold (`**a **b** c**`) is still just bold, to every Markdown reader. A
// document has marks, not nesting: the inner closing token would switch the bold off for
// the rest of the outer one. The inner pair is dropped, so the whole stretch is bold.
function flattenNestedEmphasis(state: StateCore) {
  for (const token of state.tokens) {
    if (token.type !== "inline" || !token.children) continue
    const depth: Record<string, number> = {}
    let nested = false
    const kept = token.children.filter((child) => {
      const [, name, edge] = /^(.*)_(open|close)$/u.exec(child.type) ?? []
      if (!name || !EMPHASIS_TOKENS.has(name)) return true
      if (edge === "open") {
        depth[name] = (depth[name] ?? 0) + 1
        if (depth[name] === 1) return true
      } else {
        depth[name] = (depth[name] ?? 0) - 1
        if (depth[name] <= 0) return true
      }
      nested = true
      return false
    })
    if (nested) token.children = kept
  }
}

export function createAmbyTokenizer(): MarkdownIt {
  const tokenizer = new MarkdownIt("default", { html: true, linkify: false, breaks: false })
  ambyMarkdownItPlugin(tokenizer)
  return tokenizer
}

function ambyMarkdownItPlugin(md: MarkdownIt) {
  md.inline.ruler.before("html_inline", "amby_html", ambyInlineRule)
  md.inline.ruler.at("link", linkWithTitleMarkup)
  // Before escapes and emphasis: nothing between the dollars of a formula is Markdown.
  md.inline.ruler.before("escape", "amby_math", inlineMathRule)
  md.block.ruler.at("reference", referenceUnlessFootnote, { alt: ["paragraph"] })
  md.inline.ruler.before("link", "amby_footnote_ref", footnoteReferenceRule)
  md.inline.ruler.before("link", "amby_footnote_inline", footnoteInlineRule)
  md.core.ruler.push("amby_footnote_definitions", detectFootnoteDefinitions)
  md.core.ruler.push("amby_nested_emphasis", flattenNestedEmphasis)
  md.core.ruler.push("amby_tables", normalizeTables)
  md.core.ruler.push("amby_columns", detectColumns)
  md.core.ruler.push("amby_empty_paragraphs", preserveEmptyParagraphs)
  md.core.ruler.push("amby_split_ordered_lists", splitOrderedListsAtEmptyParagraphs)
  md.core.ruler.push("amby_padded_ordered_lists", detectPaddedOrderedLists)
  md.core.ruler.push("amby_task_lists", detectTaskLists)
  md.core.ruler.push("amby_blocks", detectAmbyBlocks)
  md.core.ruler.push("amby_callouts", detectCallouts)
  md.core.ruler.push("amby_transclusions", detectTransclusions)
  md.core.ruler.push("amby_math_blocks", detectMathBlocks)
  md.core.ruler.push("amby_softbreaks", softbreaksToText)
  md.core.ruler.push("amby_trailing_whitespace", preserveTrailingWhitespace)
  md.core.ruler.push("amby_block_sources", attachBlockSources)
}
