import linkRule from "markdown-it/lib/rules_inline/link.mjs"
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs"
import { SAFE_UNDERLINE_RE, parseSafeStyle, unescapeHtml } from "./constants"

const SPAN_OPEN_RE = /^<span\s+style=["']([^"']*)["']>([\s\S]*?)<\/span>/i
const U_OPEN_RE = /^<u>([\s\S]*?)<\/u>/i

function pushText(state: StateInline, content: string) {
  const token = state.push("text", "", 0)
  token.content = content
}

export function ambyInlineRule(state: StateInline, silent: boolean): boolean {
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

const TITLE_OPENERS: Record<string, string> = { '"': '"', "'": "'", ")": "(" }

// markdown-it keeps the text of a link title but not how it was quoted. An inline link
// ends with `)` and its title is the last thing before it, so the character that closes
// the title is read from the source and its opener is kept on the token.
export function linkWithTitleMarkup(state: StateInline, silent: boolean): boolean {
  const firstNew = state.tokens.length
  if (!linkRule(state, silent)) return false
  if (silent) return true
  const open = state.tokens.slice(firstNew).find((token) => token.type === "link_open")
  if (!open?.attrGet("title") || state.src[state.pos - 1] !== ")") return true
  let at = state.pos - 2
  while (at >= 0 && /\s/u.test(state.src[at])) at--
  const markup = TITLE_OPENERS[state.src[at]]
  if (markup) open.meta = { ...(open.meta ?? {}), titleMarkup: markup }
  return true
}
