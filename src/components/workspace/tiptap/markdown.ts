/**
 * Stable Markdown boundary for editor callers. Parser construction stays lazy
 * in `markdown-parser`, preserving the schema/transclusion import-cycle guard.
 */
import type { Node as PMNode } from "@tiptap/pm/model"
import { composeMarkdown, parseMarkdown, sameDocument } from "./markdown-block-source"
import { roundTripCheck as checkRoundTrip, type RoundTripCheck } from "./markdown-compatibility"
import { markdownMeaning } from "./markdown-meaning"
import { docToNormalizedMarkdown } from "./markdown-serializer"

export { editorSchema } from "./schema"
export { composeMarkdown, type ComposedMarkdown } from "./markdown-block-source"
export {
  restoreSourceFormatting,
  type LiveAdmissionRefusal,
  type RoundTripCheck,
} from "./markdown-compatibility"
export { markdownToSafeReadonlyHtml, type SafeReadonlyHtml } from "./markdown-readonly"
export { docToNormalizedMarkdown } from "./markdown-serializer"

/** Reads Markdown into editor JSON; top-level blocks keep the text they were read from. */
export function markdownToDoc(markdown: string): Record<string, unknown> {
  return parseMarkdown(markdown).toJSON() as Record<string, unknown>
}

/**
 * Writes the document as Markdown. A block that was not edited is written as the text it
 * was read from; an edited or new block is written in the editor's own form.
 */
export function docToMarkdown(doc: PMNode): string {
  return composeMarkdown(doc).markdown
}

/** Reports whether a Source document may be opened in Live Preview. */
export function roundTripCheck(markdown: string): RoundTripCheck {
  return checkRoundTrip(markdown, {
    parse: parseMarkdown,
    serialize: docToMarkdown,
    normalize: docToNormalizedMarkdown,
    sameDocument,
    meaning: markdownMeaning,
  })
}
