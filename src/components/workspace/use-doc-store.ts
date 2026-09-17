import { create } from "zustand"
import i18n from "@/lib/i18n"
import type { NoteProperties } from "@/lib/storage"

/** An open document buffer (the in-memory copy being edited). */
export interface Document {
  id: string
  title: string
  content: string
  created: string
  modified: string
  wordCount: number
  path: string
  revision?: string
  /** Last complete on-disk source used only for safe external-delete restore. */
  source: string
  /** The stable-ID note is absent from the latest indexed filesystem tree. */
  externallyDeleted?: boolean
  noteProperties?: NoteProperties
  noteId?: string
}

export interface ExternalConflict {
  fileId: string
  path: string
  localContent: string
  externalContent: string | null
  externalRevision?: string
  /** Complete source template used to preserve opaque YAML on resolution/restore. */
  sourceTemplate?: string
}

interface DocStore {
  openDocs: Record<string, Document>
  unsavedFileIds: Set<string>
  externalConflicts: Record<string, ExternalConflict>
  /** Insert or replace an open document. */
  setDoc: (fileId: string, doc: Document) => void
  /** Patch fields of an already-open document (no-op if it isn't open). */
  patchDoc: (fileId: string, patch: Partial<Document>) => void
  /** Drop clean buffers after their tab/autosave/recovery lifecycle checks passed. */
  evictCleanDocs: (fileIds: Iterable<string>) => void
  /** Drop all open documents and dirty flags (vault close/switch). */
  clearDocs: () => void
  /** Mark a document dirty. */
  markUnsaved: (fileId: string) => void
  /** Mark a document saved: clear its dirty flag and stamp "modified". */
  markSaved: (fileId: string) => void
  /** Record an external change that must be resolved before autosave resumes. */
  setExternalConflict: (conflict: ExternalConflict) => void
  clearExternalConflict: (fileId: string) => void
  /** Drop in-memory documents, unsaved flags, and external conflicts immediately (e.g. after deletion). */
  dropDocs: (fileIds: Iterable<string>) => void
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
  externalConflicts: {},

  setDoc: (fileId, doc) => set((s) => ({ openDocs: { ...s.openDocs, [fileId]: doc } })),

  patchDoc: (fileId, patch) =>
    set((s) =>
      s.openDocs[fileId]
        ? { openDocs: { ...s.openDocs, [fileId]: { ...s.openDocs[fileId], ...patch } } }
        : {},
    ),

  evictCleanDocs: (fileIds) =>
    set((s) => {
      const candidates = new Set(fileIds)
      let changed = false
      const openDocs: Record<string, Document> = {}
      for (const [fileId, document] of Object.entries(s.openDocs)) {
        const canEvict =
          candidates.has(fileId) && !s.unsavedFileIds.has(fileId) && !s.externalConflicts[fileId]
        if (canEvict) {
          changed = true
          continue
        }
        openDocs[fileId] = document
      }
      return changed ? { openDocs } : {}
    }),

  clearDocs: () => set({ openDocs: {}, unsavedFileIds: new Set(), externalConflicts: {} }),

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

  setExternalConflict: (conflict) =>
    set((s) => ({ externalConflicts: { ...s.externalConflicts, [conflict.fileId]: conflict } })),

  clearExternalConflict: (fileId) =>
    set((s) => {
      if (!s.externalConflicts[fileId]) return {}
      const { [fileId]: _cleared, ...externalConflicts } = s.externalConflicts
      return { externalConflicts }
    }),

  dropDocs: (fileIds) =>
    set((s) => {
      const toDrop = new Set(fileIds)
      const openDocs: Record<string, Document> = {}
      for (const [id, doc] of Object.entries(s.openDocs)) {
        if (!toDrop.has(id)) openDocs[id] = doc
      }
      const unsavedFileIds = new Set<string>()
      for (const id of s.unsavedFileIds) {
        if (!toDrop.has(id)) unsavedFileIds.add(id)
      }
      const externalConflicts: Record<string, ExternalConflict> = {}
      for (const [id, conflict] of Object.entries(s.externalConflicts)) {
        if (!toDrop.has(id)) externalConflicts[id] = conflict
      }
      return { openDocs, unsavedFileIds, externalConflicts }
    }),

  applyMutation: (deletedIds, remapPath) =>
    set((s) => {
      const deleted = new Set(deletedIds)
      const openDocs: Record<string, Document> = {}
      for (const [id, doc] of Object.entries(s.openDocs)) {
        if (isDocDeleted(id, doc.path, deleted)) continue
        openDocs[id] = { ...doc, path: remapPath(doc.path) }
      }
      const unsavedFileIds = new Set<string>()
      for (const id of s.unsavedFileIds) {
        const doc = s.openDocs[id]
        if (!deleted.has(id) && (!doc || !isDocDeleted(id, doc.path, deleted))) {
          unsavedFileIds.add(id)
        }
      }
      const externalConflicts: Record<string, ExternalConflict> = {}
      for (const [id, conflict] of Object.entries(s.externalConflicts)) {
        if (!isDocDeleted(id, conflict.path, deleted)) {
          externalConflicts[id] = {
            ...conflict,
            path: remapPath(conflict.path),
          }
        }
      }
      return { openDocs, unsavedFileIds, externalConflicts }
    }),
}))

function isDocDeleted(id: string, path: string, deleted: Set<string>): boolean {
  if (deleted.has(id) || deleted.has(path)) return true
  const normPath = path.replace(/\\/g, "/").replace(/\/+$/, "")
  const idClean = id.startsWith("database:")
    ? id.slice("database:".length).replace(/\\/g, "/").replace(/\/+$/, "")
    : ""
  for (const del of deleted) {
    if (!del) continue
    const normDel = del.replace(/\\/g, "/").replace(/\/+$/, "")
    if (!normDel) continue
    if (normPath === normDel || normPath.startsWith(`${normDel}/`)) return true
    if (idClean && (idClean === normDel || idClean.startsWith(`${normDel}/`))) return true
  }
  return false
}
