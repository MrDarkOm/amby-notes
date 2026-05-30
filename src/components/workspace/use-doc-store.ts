import { create } from "zustand"
import i18n from "@/lib/i18n"

/** An open document buffer (the in-memory copy being edited). */
export interface Document {
  id: string
  title: string
  content: string
  modified: string
  wordCount: number
  path: string
}

interface DocStore {
  openDocs: Record<string, Document>
  unsavedFileIds: Set<string>
  /** Insert or replace an open document. */
  setDoc: (fileId: string, doc: Document) => void
  /** Patch fields of an already-open document (no-op if it isn't open). */
  patchDoc: (fileId: string, patch: Partial<Document>) => void
  /** Drop all open documents and dirty flags (vault close/switch). */
  clearDocs: () => void
  /** Mark a document dirty. */
  markUnsaved: (fileId: string) => void
  /** Mark a document saved: clear its dirty flag and stamp "modified". */
  markSaved: (fileId: string) => void
  /** After a filesystem mutation, remap surviving docs' paths and drop deleted ones. */
  applyMutation: (deletedIds: string[], remapPath: (path: string) => string) => void
}

/**
 * Centralises open-document buffers + autosave state. Replaces the scattered
 * `openDocs`/`unsavedFileIds` useState and the `openDocsRef` hack in Workspace —
 * effects/timers read the latest docs via `useDocStore.getState()` instead.
 */
export const useDocStore = create<DocStore>((set) => ({
  openDocs: {},
  unsavedFileIds: new Set(),

  setDoc: (fileId, doc) =>
    set((s) => ({ openDocs: { ...s.openDocs, [fileId]: doc } })),

  patchDoc: (fileId, patch) =>
    set((s) =>
      s.openDocs[fileId]
        ? { openDocs: { ...s.openDocs, [fileId]: { ...s.openDocs[fileId], ...patch } } }
        : {},
    ),

  clearDocs: () => set({ openDocs: {}, unsavedFileIds: new Set() }),

  markUnsaved: (fileId) =>
    set((s) => {
      if (s.unsavedFileIds.has(fileId)) return {}
      const next = new Set(s.unsavedFileIds)
      next.add(fileId)
      return { unsavedFileIds: next }
    }),

  markSaved: (fileId) =>
    set((s) => {
      const unsaved = new Set(s.unsavedFileIds)
      unsaved.delete(fileId)
      const doc = s.openDocs[fileId]
      return {
        unsavedFileIds: unsaved,
        openDocs: doc
          ? { ...s.openDocs, [fileId]: { ...doc, modified: i18n.t("time.justNow") } }
          : s.openDocs,
      }
    }),

  applyMutation: (deletedIds, remapPath) =>
    set((s) => {
      const deleted = new Set(deletedIds)
      const openDocs: Record<string, Document> = {}
      for (const [id, doc] of Object.entries(s.openDocs)) {
        if (deleted.has(id)) continue
        openDocs[id] = { ...doc, path: remapPath(doc.path) }
      }
      const unsavedFileIds = new Set<string>()
      for (const id of s.unsavedFileIds) if (!deleted.has(id)) unsavedFileIds.add(id)
      return { openDocs, unsavedFileIds }
    }),
}))
