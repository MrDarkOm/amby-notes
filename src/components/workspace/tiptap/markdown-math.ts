import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs"

// Inline math (`$E = mc^2$`). TeX is full of backslashes that Markdown would read as
// escapes (`\{`, `\,`, `\\`) and write back differently, so the text between the dollars
// is not Markdown at all: it is read into the note and written back character for
// character. One definition of "a formula" serves the parser, the serializer and the
// drawing in Live, so they can never disagree about where a formula is.

// The dollar that opens a formula has text right after it; the one that closes it has
// text right before it and no digit after it — "$5 and $10" is money, not math.
const BODY = String.raw`\$(?![\s$])((?:\\.|[^$\\\n])+?)(?<![\s\\])\$(?![\p{N}$])`
const AT = new RegExp(BODY, "uy")

/** A dollar opens a formula only at the start of a word: not after `\`, `$`, a letter or a digit. */
function opensFormula(before: string): boolean {
  return before === "" || !/[\\$\p{L}\p{N}]/u.test(before)
}

/** The formula that starts at an index of the text, dollars included, or null. */
export function inlineMathAt(text: string, index: number): { raw: string; tex: string } | null {
  if (text.charCodeAt(index) !== 0x24 /* $ */) return null
  if (!opensFormula(index > 0 ? text[index - 1] : "")) return null
  AT.lastIndex = index
  const match = AT.exec(text)
  return match ? { raw: match[0], tex: match[1] } : null
}

export interface MathPart {
  math: boolean
  text: string
  /** Offset of the part in the text it was cut from. */
  at: number
  /** The TeX without its dollars, for a formula. */
  tex?: string
}

/** Cuts text into formulas and what is between them. */
export function splitInlineMath(text: string): MathPart[] {
  const parts: MathPart[] = []
  let plainFrom = 0
  let index = text.indexOf("$")
  while (index !== -1) {
    const math = inlineMathAt(text, index)
    if (!math) {
      index = text.indexOf("$", index + 1)
      continue
    }
    if (index > plainFrom)
      parts.push({ math: false, text: text.slice(plainFrom, index), at: plainFrom })
    parts.push({ math: true, text: math.raw, at: index, tex: math.tex })
    plainFrom = index + math.raw.length
    index = text.indexOf("$", plainFrom)
  }
  if (plainFrom < text.length)
    parts.push({ math: false, text: text.slice(plainFrom), at: plainFrom })
  return parts
}

/** markdown-it inline rule: a formula becomes text exactly as it is written. */
export function inlineMathRule(state: StateInline, silent: boolean): boolean {
  const math = inlineMathAt(state.src, state.pos)
  if (!math || state.pos + math.raw.length > state.posMax) return false
  if (!silent) {
    const token = state.push("text", "", 0)
    token.content = math.raw
  }
  state.pos += math.raw.length
  return true
}
