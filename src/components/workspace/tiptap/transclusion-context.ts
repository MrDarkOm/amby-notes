/**
 * Stores a per-editor fetcher function for transclusion content.
 *
 * Uses a WeakMap keyed on the Editor instance so:
 *  - no ref-threading through extension options (schema extensions are static)
 *  - the entry is automatically GC'd when the editor is destroyed
 *
 * TiptapEditor sets the fetcher via `setTransclusionFetcher` after creation;
 * the TransclusionNode NodeView reads it via `getTransclusionFetcher`.
 */
import type { Editor } from "@tiptap/core"

type Fetcher = (target: string) => Promise<string | null>

const fetchers = new WeakMap<Editor, Fetcher>()

export function setTransclusionFetcher(editor: Editor, fetcher: Fetcher) {
  fetchers.set(editor, fetcher)
}

export function getTransclusionFetcher(editor: Editor): Fetcher | undefined {
  return fetchers.get(editor)
}
