import type { Editor } from "@tiptap/core"
import type { Transaction } from "@tiptap/pm/state"
import * as React from "react"

import { requestSourceRewriteSnapshot } from "../autosave/source-rewrite"
import { registerEditorSerialization } from "./editor-serialization-lifecycle"
import { registerEditorUserIntent } from "./editor-user-intent"
import { composeMarkdown, restoreSourceFormatting } from "./markdown"

/** How long after the last edit the document is serialized, in milliseconds. */
export const SERIALIZE_DEBOUNCE_MS = 200

export interface EditorSerializationOptions {
  /** The Markdown the parent holds; the editor compares what it writes against it. */
  value: string
  noteId?: string
  onChange: (value: string) => void
  onContentDirty?: () => void
  onContentClean?: () => void
}

export interface EditorSerialization {
  /** The Markdown last loaded or published by this editor. */
  currentValue(): string
  /** The person acted on the editor (key, input, paste, cut, drop, undo, an outside control). */
  markUserIntent(): void
  /** `onTransaction` of the editor: a UI or pointer transaction is the person's. */
  handleTransaction(transaction: Transaction): void
  /** `onUpdate` of the editor: a change the person made is queued for serialization. */
  handleUpdate(editor: Editor, transaction: Transaction): void
  /** Serializes a pending edit now; a no-op unless a real edit authorised a write. */
  flush(editor: Editor): void
  /**
   * The parent replaced the text (history navigation, a content reset): forget pending work and
   * the person's intent. Returns false when `value` is already what this editor holds.
   */
  acceptExternalValue(value: string): boolean
}

/**
 * The serialization lifecycle of a Live editor: Markdown is written only after a change the
 * person made, deferred because serializing is O(doc size), compared with the loaded source,
 * and flushed before the editor goes away. Menus and pointer heuristics stay in the component.
 */
export function useEditorSerialization(options: EditorSerializationOptions): EditorSerialization {
  const { value, noteId, onChange, onContentDirty, onContentClean } = options
  const valueRef = React.useRef(value)
  const originalValueRef = React.useRef(value)
  const onChangeRef = React.useRef(onChange)
  const onContentDirtyRef = React.useRef(onContentDirty)
  const onContentCleanRef = React.useRef(onContentClean)
  const noteIdRef = React.useRef(noteId)
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const documentDirtyRef = React.useRef(false)
  // One request per loaded text: the first save that may rewrite a block's source.
  const rewriteSnapshotRequestedRef = React.useRef(false)
  const userInteractedRef = React.useRef(false)

  React.useEffect(() => {
    onChangeRef.current = onChange
  }, [onChange])
  React.useEffect(() => {
    noteIdRef.current = noteId
  }, [noteId])
  React.useEffect(() => {
    onContentDirtyRef.current = onContentDirty
  }, [onContentDirty])
  React.useEffect(() => {
    onContentCleanRef.current = onContentClean
  }, [onContentClean])

  return React.useMemo<EditorSerialization>(() => {
    const clearTimer = () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current)
        timerRef.current = null
      }
    }

    // Serializing is O(doc size); running it on every keystroke lags large notes.
    // Debounce it, and flush on blur/unmount so the save path never loses edits.
    const flush = (ed: Editor) => {
      clearTimer()
      // Source/Live switches and React Fast Refresh both unmount the editor.
      // Serializing an untouched editor during those transitions can persist a
      // transient ProseMirror document and repeatedly materialise blank blocks.
      // Only a real editor update authorises a Markdown write.
      if (!documentDirtyRef.current) return
      if (ed.isDestroyed) return
      const composed = composeMarkdown(ed.state.doc)
      const markdown = restoreSourceFormatting(composed.markdown, originalValueRef.current)
      documentDirtyRef.current = false
      if (markdown === valueRef.current) {
        onContentCleanRef.current?.()
        return
      }
      // The note holds text the editor would spell differently, and this edit may be the
      // one that rewrites it: the file being replaced must stay recoverable from history.
      if (composed.mayRewriteSource && noteIdRef.current && !rewriteSnapshotRequestedRef.current) {
        rewriteSnapshotRequestedRef.current = true
        requestSourceRewriteSnapshot(noteIdRef.current)
      }
      valueRef.current = markdown
      originalValueRef.current = markdown
      onChangeRef.current(markdown)
    }

    return {
      currentValue: () => valueRef.current,
      markUserIntent: () => {
        userInteractedRef.current = true
      },
      handleTransaction: (transaction) => {
        if (transaction.getMeta("uiEvent") || transaction.getMeta("pointer")) {
          userInteractedRef.current = true
        }
      },
      handleUpdate: (editor, transaction) => {
        const isUserAction =
          userInteractedRef.current ||
          Boolean(transaction.getMeta("uiEvent") || transaction.getMeta("pointer"))
        if (!isUserAction) return
        documentDirtyRef.current = true
        onContentDirtyRef.current?.()
        clearTimer()
        timerRef.current = setTimeout(() => flush(editor), SERIALIZE_DEBOUNCE_MS)
      },
      flush,
      acceptExternalValue: (next) => {
        if (next === valueRef.current) return false
        userInteractedRef.current = false
        documentDirtyRef.current = false
        clearTimer()
        valueRef.current = next
        originalValueRef.current = next
        rewriteSnapshotRequestedRef.current = false
        return true
      },
    }
  }, [])
}

/**
 * Ties a mounted editor to the lifecycle: a flush before it goes away, a flush at lifecycle
 * boundaries (window close, visibility hide, vault switch) that happen before React unmounts,
 * and the intent mark for controls that live outside the editor's DOM (EDIT-02).
 */
export function useEditorSerializationLifecycle(
  editor: Editor | null,
  serialization: EditorSerialization,
): void {
  // Flush any pending serialization before this editor instance goes away
  // (document switch, view-mode toggle, tab close) so the latest edit is saved.
  React.useEffect(() => {
    if (!editor || editor.isDestroyed) return
    return () => serialization.flush(editor)
  }, [editor, serialization])

  // Lifecycle boundaries happen before React unmounts this component, so register the same
  // guarded flush independently of the unmount cleanup above.
  React.useEffect(() => {
    if (!editor || editor.isDestroyed) return
    return registerEditorSerialization({ flush: () => serialization.flush(editor) })
  }, [editor, serialization])

  // Block controls outside the editor DOM mark the person's intent through this (EDIT-02).
  React.useEffect(() => {
    if (!editor || editor.isDestroyed) return
    return registerEditorUserIntent(editor, () => serialization.markUserIntent())
  }, [editor, serialization])
}
