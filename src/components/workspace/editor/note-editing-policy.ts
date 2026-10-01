import type { NoteProperties } from "@/lib/storage"
import { roundTripCheck } from "../tiptap/markdown"

export type MarkdownCompatibilityReason =
  "round_trip_mismatch" | "mixed_line_endings" | "inspection_failed"

export interface MarkdownCompatibility {
  ok: boolean
  reason?: MarkdownCompatibilityReason
}

function hasMixedLineEndings(source: string): boolean {
  const hasCrLf = /\r\n/u.test(source)
  const hasLoneLf = /(^|[^\r])\n/u.test(source)
  const hasLoneCr = /\r(?!\n)/u.test(source)
  return hasLoneCr || (hasCrLf && hasLoneLf)
}

/**
 * Check the editor body at the Live Preview boundary.
 *
 * The backend gives the editor a body-only value and keeps the complete source
 * separately. The body is what Tiptap parses; the source is also inspected for
 * mixed line endings because normal notes deliberately normalise CRLF to LF at
 * the renderer boundary while preserving the original bytes on disk.
 */
export function inspectMarkdownCompatibility(body: string, source?: string): MarkdownCompatibility {
  if (hasMixedLineEndings(source ?? body) || hasMixedLineEndings(body)) {
    return { ok: false, reason: "mixed_line_endings" }
  }
  try {
    const result = roundTripCheck(body)
    return result.ok ? { ok: true } : { ok: false, reason: "round_trip_mismatch" }
  } catch {
    return { ok: false, reason: "inspection_failed" }
  }
}

export function noteEditingPolicy(
  properties?: NoteProperties,
  compatibility?: MarkdownCompatibility,
) {
  // Older/browser payloads may not yet distinguish YAML errors from ID conflicts.
  const readOnly = properties?.bodyReadOnly ?? Boolean(properties?.parseError)
  const sourceOnly = properties?.frontmatterStatus === "unterminated" || compatibility?.ok === false
  const warningKey = !properties?.parseError
    ? compatibility?.ok === false
      ? "workspace.losslessSourceOnly"
      : null
    : readOnly
      ? "workspace.identityReadOnly"
      : properties.frontmatterStatus === "unterminated"
        ? "workspace.unterminatedFrontmatter"
        : "workspace.invalidFrontmatter"
  return { readOnly, sourceOnly, warningKey }
}
