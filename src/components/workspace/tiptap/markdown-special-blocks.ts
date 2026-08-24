import type StateCore from "markdown-it/lib/rules_core/state_core.mjs"
import type Token from "markdown-it/lib/token.mjs"
import { CALLOUT_DEFAULTS } from "./callout-node"

const CALLOUT_FIRST_LINE_RE = /^\[!([A-Z0-9_-]+)\]([+-])?([ \t]+[^\n]*)?/i

/**
 * Transforms blockquotes whose first line is `[!TYPE] emoji` into `callout`
 * tokens so the MarkdownParser can create a proper `callout` ProseMirror node.
 *
 * Must run BEFORE softbreaksToText, AFTER detectTaskLists (order matters).
 */
export function detectCallouts(state: StateCore) {
  const tokens = state.tokens
  const out: Token[] = []
  const skippedTokenIndexes = new Set<number>()
  let i = 0

  while (i < tokens.length) {
    if (skippedTokenIndexes.has(i)) {
      i++
      continue
    }
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
        if (depth === 0) {
          bqClose = j
          break
        }
      }
    }
    if (bqClose < 0) {
      out.push(tokens[i++])
      continue
    }

    // Find the first paragraph (open / inline / close) inside the blockquote
    let firstParaOpen = -1,
      firstInlineIdx = -1,
      firstParaClose = -1
    for (let j = i + 1; j < bqClose; j++) {
      if (tokens[j].type === "paragraph_open" && firstParaOpen < 0) {
        firstParaOpen = j
      } else if (tokens[j].type === "inline" && firstParaOpen >= 0 && firstInlineIdx < 0) {
        firstInlineIdx = j
      } else if (
        tokens[j].type === "paragraph_close" &&
        firstInlineIdx >= 0 &&
        firstParaClose < 0
      ) {
        firstParaClose = j
        break
      }
    }

    if (firstInlineIdx < 0) {
      out.push(tokens[i++])
      continue
    }

    const firstInline = tokens[firstInlineIdx]
    const match = CALLOUT_FIRST_LINE_RE.exec(firstInline.content)
    if (!match) {
      out.push(tokens[i++])
      continue
    }

    const calloutType = match[1].toUpperCase()
    const headerLine = firstInline.content.split("\n", 1)[0]
    const markerOnly = /^\[![A-Z0-9_-]+\]/iu.exec(headerLine)?.[0] ?? ""
    const rawHeaderSuffix = headerLine.slice(markerOnly.length)
    let headerContentOffset = 0
    if (/^[+-]/u.test(rawHeaderSuffix)) headerContentOffset++
    while (/[ \t]/u.test(rawHeaderSuffix[headerContentOffset] ?? "")) headerContentOffset++
    const possibleEmoji = rawHeaderSuffix.slice(headerContentOffset)
    // A plain callout title is not an emoji. Keeping the entire suffix in the
    // emoji button is what caused every letter of a title to become a vertical
    // column. Only accept a real leading emoji; the NodeView renders any title.
    const leadingEmoji =
      /^\p{Extended_Pictographic}(?:\uFE0F|\u200D\p{Extended_Pictographic})*/u.exec(
        possibleEmoji,
      )?.[0]
    if (leadingEmoji) {
      headerContentOffset += leadingEmoji.length
      while (/[ \t]/u.test(rawHeaderSuffix[headerContentOffset] ?? "")) headerContentOffset++
    }
    const emoji = leadingEmoji || CALLOUT_DEFAULTS[calloutType] || "💡"
    const headerPrefix = rawHeaderSuffix.slice(0, headerContentOffset)
    const headerContent = rawHeaderSuffix.slice(headerContentOffset)
    const headerContentInBody = headerContent.length > 0
    let nextBlockStart: number | null = null
    for (let index = firstParaClose + 1; index < bqClose; index++) {
      if (tokens[index].map) {
        nextBlockStart = tokens[index].map![0]
        break
      }
    }
    const headerBodyTight =
      headerContentInBody &&
      typeof firstInline.map?.[1] === "number" &&
      nextBlockStart === firstInline.map[1]

    // Keep an existing title as the first ordinary content line. It is now
    // selectable, styled exactly like the following line, and can carry the
    // same inline Markdown marks. Only the structural marker/icon prefix is
    // removed from the editable content.
    const markerPrefixLen = markerOnly.length + headerContentOffset
    firstInline.content = firstInline.content.slice(markerPrefixLen)
    if (firstInline.children?.length) {
      let remainingPrefix = markerPrefixLen
      while (remainingPrefix > 0 && firstInline.children.length > 0) {
        const child = firstInline.children[0]
        if (child.type !== "text") break
        const removeCount = Math.min(remainingPrefix, child.content.length)
        child.content = child.content.slice(removeCount)
        remainingPrefix -= removeCount
        if (!child.content) firstInline.children.shift()
      }
      // With no title, the marker line is structural rather than an empty
      // editable line, so the following body starts immediately.
      if (!headerContentInBody && firstInline.children[0]?.type === "softbreak") {
        firstInline.children.shift()
        firstInline.content = firstInline.content.replace(/^\n/u, "")
      }
    }

    const skipFirstPara =
      !firstInline.content.trim() &&
      (!firstInline.children || firstInline.children.length === 0) &&
      firstParaClose < bqClose - 1

    const calloutOpen = new state.Token("callout_open", "div", 1)
    calloutOpen.attrSet("calloutType", calloutType)
    calloutOpen.attrSet("emoji", emoji)
    calloutOpen.attrSet("headerSuffix", rawHeaderSuffix)
    calloutOpen.attrSet("headerPrefix", headerPrefix)
    calloutOpen.attrSet("headerContentInBody", headerContentInBody ? "true" : "false")
    calloutOpen.attrSet("headerBodyTight", headerBodyTight ? "true" : "false")
    calloutOpen.attrSet("hasRawHeader", "true")
    out.push(calloutOpen)
    if (skipFirstPara) {
      for (let index = firstParaOpen; index <= firstParaClose; index++)
        skippedTokenIndexes.add(index)
    }
    // Continue through the original inner tokens instead of copying them as a
    // single block. This lets nested blockquotes be recognized as callouts too.
    tokens[bqClose] = new state.Token("callout_close", "div", -1)
    i++
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
export function detectAmbyBlocks(state: StateCore) {
  for (const tok of state.tokens) {
    if (tok.type !== "fence") continue
    const m = AMBY_BLOCK_INFO_RE.exec(tok.info.trim())
    if (!m) continue
    tok.type = "amby_block"
    tok.tag = ""
    tok.meta = { ...(tok.meta ?? {}), blockType: m[1].toLowerCase(), blockId: tok.content.trim() }
  }
}

// ── markdown-it: detect Obsidian-style transclusion embeds (`![[Note Name]]`) ─

/**
 * Scans the block-level token stream for paragraphs whose entire content is a
 * single `![[Note Name]]` embed link and replaces the paragraph triplet
 * (paragraph_open / inline / paragraph_close) with a single `transclusion`
 * token.  This mirrors Obsidian's block-embed behaviour.
 *
 * The original inner wikilink is kept for serialization, while the base note
 * name remains available separately for the preview lookup. This avoids losing
 * aliases (`|`) and anchors (`#`/`^`) when an unrelated live-editor edit saves
 * the document.
 */
const TRANSCLUSION_LINE_RE = /^!\[\[([^\]\r\n]+)\]\]\s*$/

export function detectTransclusions(state: StateCore) {
  const out: typeof state.tokens = []
  let i = 0
  while (i < state.tokens.length) {
    const tok = state.tokens[i]
    // Paragraph triplet: paragraph_open → inline → paragraph_close
    if (
      tok.type === "paragraph_open" &&
      i + 2 < state.tokens.length &&
      state.tokens[i + 1].type === "inline" &&
      state.tokens[i + 2].type === "paragraph_close"
    ) {
      const inline = state.tokens[i + 1]
      const m = TRANSCLUSION_LINE_RE.exec(inline.content)
      if (m) {
        // Strip alias (|) and anchor (#/^) to get the base note name.
        const raw = m[1].trim()
        const base = raw.split("|")[0].split(/[#^]/)[0].trim()
        const t = new state.Token("transclusion", "div", 0)
        t.attrSet("target", base)
        t.attrSet("raw", raw)
        out.push(t)
        i += 3 // consume paragraph_open + inline + paragraph_close
        continue
      }
    }
    out.push(tok)
    i++
  }
  state.tokens = out
}

// Keep block math as an opaque source node. Without this, a TeX command at the
// start of a line (for example `\int`) is treated as a Markdown escape during
// visual serialization and gains an extra backslash on disk.
const MATH_BLOCK_RE = /^\$\$\r?\n[\s\S]*\r?\n\$\$\s*$/u
export function detectMathBlocks(state: StateCore) {
  const out: typeof state.tokens = []
  let index = 0
  while (index < state.tokens.length) {
    const token = state.tokens[index]
    if (
      token.type === "paragraph_open" &&
      state.tokens[index + 1]?.type === "inline" &&
      state.tokens[index + 2]?.type === "paragraph_close"
    ) {
      const inline = state.tokens[index + 1]
      if (MATH_BLOCK_RE.test(inline.content)) {
        const opaque = new state.Token("opaque_markdown", "pre", 0)
        opaque.meta = { kind: "math", value: inline.content.trimEnd() }
        out.push(opaque)
        index += 3
        continue
      }
    }
    out.push(token)
    index++
  }
  state.tokens = out
}
