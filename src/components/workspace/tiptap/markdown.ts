/**
 * Stable Markdown boundary for editor callers. Parser construction stays lazy
 * in `markdown-parser`, preserving the schema/transclusion import-cycle guard.
 */
export { editorSchema } from "./schema"
export { restoreSourceFormatting } from "./markdown-compatibility"
export { markdownToDoc } from "./markdown-parser"
export { markdownToSafeReadonlyHtml, type SafeReadonlyHtml } from "./markdown-readonly"
export { docToMarkdown } from "./markdown-serializer"

import { roundTripCheck as checkRoundTrip } from "./markdown-compatibility"
import { getMarkdownParser } from "./markdown-parser"
import { docToMarkdown } from "./markdown-serializer"

/** Reports whether a Source document can enter Live Preview without byte drift. */
export function roundTripCheck(markdown: string): { ok: boolean; result: string } {
  return checkRoundTrip(markdown, (source) => getMarkdownParser().parse(source), docToMarkdown)
}
