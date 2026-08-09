// Shared constants and helpers for the Tiptap editor, the CodeMirror source
// editor, and the markdown conversion layer.

// Unicode-aware Obsidian tags (including nested tags) and wiki links. The
// non-numeric lookahead follows Obsidian's rule that `#1984` is not a tag.
export const INLINE_TOKEN_RE =
  /(?<=^|[\s([{>])#((?=[\p{L}\p{N}_/-]*[\p{L}_-])[\p{L}\p{N}_-]+(?:\/[\p{L}\p{N}_-]+)*)|\[\[([^\]\r\n]+)\]\]/gu

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
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

// Reverses escapeHtml. Only the three entities escapeHtml produces are handled,
// so this stays DOM-free (usable outside the browser, e.g. in tests).
export function unescapeHtml(text: string) {
  return text.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
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

/**
 * Parse the inner content of a wiki-link (`[[…]]` without the brackets).
 *
 * Handles the three modifier forms used by Obsidian / Amby:
 *   - alias:      `Note|Alias`          → target="Note",  anchor=null,    label="Alias"
 *   - heading:    `Note#Heading`        → target="Note",  anchor="#Heading"
 *   - block:      `Note^block-id`       → target="Note",  anchor="^block-id"
 *   - combined:   `Note#Heading|Alias`  → target="Note",  anchor="#Heading", label="Alias"
 */
export function getWikiLinkParts(raw: string) {
  const [targetPart, aliasPart] = raw.split("|")
  const clean = (targetPart ?? "").trim()
  // Find the first anchor marker: '#' (heading) or '^' (block-id).
  const hashIdx = clean.indexOf("#")
  const caretIdx = clean.indexOf("^")
  const anchorStart =
    hashIdx !== -1 && caretIdx !== -1
      ? Math.min(hashIdx, caretIdx)
      : hashIdx !== -1
        ? hashIdx
        : caretIdx !== -1
          ? caretIdx
          : -1
  const target = anchorStart !== -1 ? clean.slice(0, anchorStart).trim() : clean
  const anchor: string | null = anchorStart !== -1 ? clean.slice(anchorStart) : null
  const label = (aliasPart ?? targetPart ?? "").trim()
  return { target, anchor, label: label || target }
}
