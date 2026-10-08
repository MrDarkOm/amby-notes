import referenceRule from "markdown-it/lib/rules_block/reference.mjs"
import type StateBlock from "markdown-it/lib/rules_block/state_block.mjs"
import type StateCore from "markdown-it/lib/rules_core/state_core.mjs"
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs"

// Footnotes: a reference `[^label]`, a definition `[^label]: text` and an inline note
// `^[text]`. Each one is a node of its own that is written exactly as it was read: the
// label and the text of an inline note are kept as written, and the text of a
// definition is ordinary inline Markdown.

/** A label is one word: `[^1]`, `[^note-a]`. Spaces make it ordinary text in brackets. */
const REFERENCE = /\[\^([^\]\s[^]+)\]/uy
const DEFINITION_START = /^\[\^([^\]\s[^]+)\]:([ \t]*)/u

/**
 * `[^label]: address` looks like a link definition (`[name]: address`) to plain
 * Markdown, which would swallow it without a trace. A label that starts with `^` is a
 * footnote for every reader that knows footnotes, and text for those that do not.
 */
export function referenceUnlessFootnote(
  state: StateBlock,
  startLine: number,
  endLine: number,
  silent: boolean,
): boolean {
  const start = state.bMarks[startLine] + state.tShift[startLine]
  if (state.src.startsWith("[^", start)) return false
  return referenceRule(state, startLine, endLine, silent)
}

/** markdown-it inline rule: `[^label]`. */
export function footnoteReferenceRule(state: StateInline, silent: boolean): boolean {
  if (state.src.charCodeAt(state.pos) !== 0x5b /* [ */) return false
  REFERENCE.lastIndex = state.pos
  const match = REFERENCE.exec(state.src)
  if (!match || state.pos + match[0].length > state.posMax) return false
  if (!silent) {
    const token = state.push("footnote_ref", "sup", 0)
    token.meta = { label: match[1] }
    token.content = match[0]
  }
  state.pos += match[0].length
  return true
}

/** markdown-it inline rule: `^[text]`, with balanced brackets and on one line. */
export function footnoteInlineRule(state: StateInline, silent: boolean): boolean {
  const { src, pos, posMax } = state
  if (src.charCodeAt(pos) !== 0x5e /* ^ */ || src.charCodeAt(pos + 1) !== 0x5b /* [ */) return false
  let depth = 0
  let end = -1
  for (let index = pos + 1; index < posMax; index++) {
    const code = src.charCodeAt(index)
    if (code === 0x0a /* \n */) break
    if (code === 0x5c /* \ */) index++
    else if (code === 0x5b) depth++
    else if (code === 0x5d /* ] */ && --depth === 0) {
      end = index
      break
    }
  }
  if (end === -1 || end === pos + 2) return false
  if (!silent) {
    const token = state.push("footnote_inline", "sup", 0)
    token.meta = { value: src.slice(pos + 2, end) }
    token.content = src.slice(pos, end + 1)
  }
  state.pos = end + 1
  return true
}

/**
 * A top-level paragraph that begins with `[^label]:` is the definition of that
 * footnote; what follows the colon is its text.
 */
export function detectFootnoteDefinitions(state: StateCore) {
  let depth = 0
  for (let index = 0; index < state.tokens.length; index++) {
    const open = state.tokens[index]
    const atTop = depth === 0
    depth += open.nesting
    if (!atTop || open.type !== "paragraph_open") continue
    const inline = state.tokens[index + 1]
    const close = state.tokens[index + 2]
    if (inline?.type !== "inline" || close?.type !== "paragraph_close") continue
    const start = DEFINITION_START.exec(inline.content)
    const [first, second] = inline.children ?? []
    if (!start || first?.type !== "footnote_ref" || first.meta?.label !== start[1]) continue
    // What stands between the colon and the text is spelling, not text. Only the
    // spaces written there go: a space written as `&#32;` is text of the note.
    const children = (inline.children ?? []).slice(1)
    const spelling = `:${start[2]}`
    if (second?.type === "text" && second.content.startsWith(spelling)) {
      second.content = second.content.slice(spelling.length)
      if (!second.content) children.shift()
    } else continue
    inline.children = children
    open.type = "footnote_def_open"
    open.tag = "div"
    open.meta = { ...(open.meta ?? {}), label: start[1] }
    close.type = "footnote_def_close"
    close.tag = "div"
  }
}
