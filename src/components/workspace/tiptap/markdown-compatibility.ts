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

export type LiveAdmissionRefusal =
  /** A footnote: the editor has no node for it. */
  | "footnote"
  /** A link definition, which the parser consumes without leaving a block. */
  | "link_definition"
  /** Text between blocks that belongs to no block. */
  | "text_outside_blocks"
  /** A save without edits would not give the same file back. */
  | "bytes_not_kept"
  /** The editor's own form of the note does not read back as the same document. */
  | "document_changes"
  /** An independent reading finds a difference between the note and the editor's form. */
  | "meaning_changes"

export interface RoundTripCheck {
  /** The note may be opened in Live Preview. */
  ok: boolean
  /** What a save without edits writes when `ok`; the editor's own form otherwise. */
  result: string
  /** Why the note stays in Source. */
  refusal?: LiveAdmissionRefusal
}

export interface RoundTripTools {
  /** Reads Markdown into a document whose blocks keep their source text. */
  parse: (source: string) => PMNode
  /** Writes kept source for unchanged blocks, the editor's form for the rest. */
  serialize: (doc: PMNode) => string
  /** Writes every block in the editor's own form. */
  normalize: (doc: PMNode) => string
  sameDocument: (a: PMNode, b: PMNode) => boolean
  meaning: (source: string) => { content: string; hasDefinitions: boolean }
}

/**
 * Decides whether a note may be opened in Live Preview.
 *
 * A note is admitted when (1) saving it without an edit writes the same bytes, and
 * (2) rewriting any of its blocks in the editor's own form would change only how the
 * block is spelled: the editor's form of the whole note reads back as the same document,
 * for the editor's parser and for an independent one. Everything else stays in Source.
 */
export function roundTripCheck(markdown: string, tools: RoundTripTools): RoundTripCheck {
  const original = markdown ?? ""
  const doc = tools.parse(original)
  const normalized = restoreSourceFormatting(tools.normalize(doc), original)
  const refuse = (refusal: LiveAdmissionRefusal): RoundTripCheck => ({
    ok: false,
    result: normalized,
    refusal,
  })
  if (FOOTNOTE_SYNTAX_RE.test(original)) return refuse("footnote")
  const meaning = tools.meaning(original)
  if (meaning.hasDefinitions) return refuse("link_definition")
  let textOutsideBlocks = false
  doc.forEach((block) => {
    const gap = block.attrs.markdownBlockGap
    if (typeof gap === "string" && /[^ \t\n]/u.test(gap)) textOutsideBlocks = true
  })
  if (textOutsideBlocks) return refuse("text_outside_blocks")

  const untouched = restoreSourceFormatting(tools.serialize(doc), original)
  if (untouched !== original) return refuse("bytes_not_kept")
  if (normalized === original) return { ok: true, result: original }
  if (!tools.sameDocument(tools.parse(normalized), doc)) return refuse("document_changes")
  if (tools.meaning(normalized).content !== meaning.content) return refuse("meaning_changes")
  return { ok: true, result: original }
}
