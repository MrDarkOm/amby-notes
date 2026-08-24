import type { Node as PMNode } from "@tiptap/pm/model"

const FOOTNOTE_SYNTAX_RE = /(?:\[\^[^\]\r\n]+\]|\^\[[^\]\r\n]+\])/u

export function restoreSourceFormatting(serialized: string, original: string): string {
  const hasCrLf = original.includes("\r\n")
  const hasLoneLf = /(^|[^\r])\n/.test(original)
  const hasLoneCr = /\r(?!\n)/.test(original)
  if (hasLoneCr || (hasCrLf && hasLoneLf)) return serialized
  const leading = original.match(/^(?:\r?\n)+/)?.[0] ?? ""
  const trailing = original.match(/(?:\r?\n)+$/)?.[0] ?? ""
  let body = serialized
  if (leading) body = body.replace(/^(?:\r?\n)+/, "")
  if (trailing) body = body.replace(/(?:\r?\n)+$/, "")
  return `${leading}${hasCrLf ? body.replace(/\n/g, "\r\n") : body}${trailing}`
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
