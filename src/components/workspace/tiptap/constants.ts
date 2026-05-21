// Shared constants and helpers for the Tiptap editor, the CodeMirror source
// editor, and the markdown conversion layer.

// Unicode-aware: matches #тег/#tag/#タグ and [[Заметка]] wiki links.
// The `#` must be at the start of the text node or preceded by whitespace —
// otherwise hex colors like `#abc123` inside a word would be parsed as tags.
export const INLINE_TOKEN_RE = /(?<=^|\s)#(\p{L}[\p{L}\p{N}_-]*)|\[\[([^\]\r\n]+)\]\]/gu

export const HEX_RE = /^#[0-9a-fA-F]{6}$/
export const SAFE_SPAN_RE = /^<span\s+style=["']([^"']*)["']>(.*?)<\/span>$/is
export const SAFE_UNDERLINE_RE = /^<u>(.*?)<\/u>$/is

export const EMOJIS = ["✨", "✅", "🔥", "💡", "📌", "⭐", "❤️", "🚀", "🧠", "🎯", "⚠️", "📝"]

export interface EditorHandle {
  undo: () => void
  redo: () => void
}

export function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

export function escapeHtml(text: string) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

// Reverses escapeHtml. Only the three entities escapeHtml produces are handled,
// so this stays DOM-free (usable outside the browser, e.g. in tests).
export function unescapeHtml(text: string) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
}

export function parseSafeStyle(style: string): { color?: string; backgroundColor?: string } {
  const result: { color?: string; backgroundColor?: string } = {}
  for (const part of style.split(";")) {
    const [rawKey, rawValue] = part.split(":")
    const key = rawKey?.trim().toLowerCase()
    const value = rawValue?.trim()
    if (!value || !HEX_RE.test(value)) continue
    if (key === "color") result.color = value
    if (key === "background-color") result.backgroundColor = value
  }
  return result
}

export function styleAttrsToCss(attrs: { color?: string | null; backgroundColor?: string | null }) {
  const parts: string[] = []
  if (attrs.color && HEX_RE.test(attrs.color)) parts.push(`color:${attrs.color}`)
  if (attrs.backgroundColor && HEX_RE.test(attrs.backgroundColor)) {
    parts.push(`background-color:${attrs.backgroundColor}`)
  }
  return parts.join(";")
}

export function getWikiLinkParts(raw: string) {
  const [targetPart, aliasPart] = raw.split("|")
  const target = (targetPart ?? "").split("#")[0].trim()
  const label = (aliasPart ?? targetPart ?? "").trim()
  return { target, label: label || target }
}
