import type { Node as PMNode } from "@tiptap/pm/model"

const FOOTNOTE_SYNTAX_RE = /(?:\[\^[^\]\r\n]+\]|\^\[[^\]\r\n]+\])/u

function restoreLineEndings(serialized: string, original: string): string {
  // An all-blank document has no text nodes in ProseMirror. Preserve its exact
  // count and style of line endings instead of trying to derive overlapping
  // leading and trailing segments from the same bytes.
  if (/^(?:\r?\n)*$/u.test(serialized)) {
    return /^(?:\r?\n)*$/u.test(original) ? original : serialized
  }
  if (/^(?:\r?\n)*$/u.test(original)) {
    return original.includes("\r\n") ? serialized.replace(/\n/g, "\r\n") : serialized
  }
  const hasCrLf = original.includes("\r\n")
  const hasLoneLf = /(^|[^\r])\n/.test(original)
  const hasLoneCr = /\r(?!\n)/.test(original)
  if (hasLoneCr || (hasCrLf && hasLoneLf)) return serialized
  const leading = original.match(/^(?:\r?\n)+/)?.[0] ?? ""
  const trailing = original.match(/(?:\r?\n)+$/)?.[0] ?? ""
  const body = serialized.replace(/^(?:\r?\n)+/, "").replace(/(?:\r?\n)+$/, "")
  return `${leading}${hasCrLf ? body.replace(/\n/g, "\r\n") : body}${trailing}`
}

// Spaces and tabs on an otherwise blank line are not Markdown content: the parser sees
// a blank line, so a document cannot carry them. Older versions of the editor wrote a
// paragraph of nothing but spaces as exactly such a line. They are given back as they
// were, so the file is read and saved without changing a byte.
const WHITESPACE_ONLY_LINE = /^[ \t]+(?=\r?$)/gm

/**
 * Re-applies the source's line endings, leading and trailing blank lines and the
 * whitespace of whitespace-only lines to what the editor serialized.
 */
export function restoreSourceFormatting(serialized: string, original: string): string {
  const plain = restoreLineEndings(serialized, original)
  if (plain === original || !WHITESPACE_ONLY_LINE.test(original)) return plain
  WHITESPACE_ONLY_LINE.lastIndex = 0
  const restored = restoreLineEndings(serialized, original.replace(WHITESPACE_ONLY_LINE, ""))
  const sourceLines = original.split("\n")
  const lines = restored.split("\n")
  // Without the same number of lines there is no way to tell which blank line was which.
  if (lines.length !== sourceLines.length) return restored
  return lines
    .map((line, index) => {
      const source = sourceLines[index]
      return /^[ \t]+\r?$/.test(source) && line === source.replace(/[ \t]+/, "") ? source : line
    })
    .join("\n")
}

export function roundTripCheck(
  markdown: string,
  parse: (source: string) => PMNode,
  serialize: (doc: PMNode) => string,
): { ok: boolean; result: string } {
  const original = markdown ?? ""
  const result = restoreSourceFormatting(serialize(parse(original)), original)
  return { ok: result === original && !FOOTNOTE_SYNTAX_RE.test(original), result }
}
