import type { PathChange } from "@/lib/storage"
import { remapRecoveryDraft, type RecoveryScope } from "@/lib/recovery-drafts"
import { useDocStore } from "../use-doc-store"
import { useTabsStore } from "../use-tabs-store"
import type { AutosaveCoordinator, AutosaveKey } from "../autosave/autosave-coordinator"
import type { FileRevisionTracker } from "../autosave/file-revision-tracker"
import { remapLayerAutosave } from "../autosave/remap-layer-autosave"

interface LayerState {
  kind: "canvas" | "sketch"
  setBuffers: (update: (buffers: Record<string, string>) => Record<string, string>) => void
  autosave: AutosaveCoordinator<{ path: string; json: string }>
  key: (path: string) => AutosaveKey
  revisions: FileRevisionTracker
}

/** Apply authoritative move pairs only to buffers whose destination is unoccupied. */
export function remapExternalLayers(
  changes: PathChange[],
  layers: LayerState[],
  recoveryScope: RecoveryScope,
): void {
  const remapped = new Map<string, string>()
  for (const layer of layers) {
    layer.setBuffers((buffers) => {
      const next = { ...buffers }
      for (const { oldPath, newPath } of changes) {
        if (!oldPath || !newPath || oldPath === newPath || next[oldPath] === undefined) continue
        if (next[newPath] !== undefined || layer.autosave.inspect(layer.key(newPath))) continue
        if (useDocStore.getState().openDocs[newPath]) continue
        remapLayerAutosave(layer.autosave, layer.revisions, layer.key(oldPath), layer.key(newPath))
        void remapRecoveryDraft(oldPath, newPath, layer.kind, newPath, recoveryScope)
        next[newPath] = next[oldPath]
        delete next[oldPath]
        remapped.set(oldPath, newPath)
      }
      return next
    })
  }
  if (!remapped.size) return
  const remap = (path: string) => remapped.get(path) ?? path
  useDocStore.setState((state) => {
    const openDocs = Object.fromEntries(
      Object.entries(state.openDocs).map(([id, doc]) => [
        remap(id),
        { ...doc, id: remap(doc.id), path: remap(doc.path) },
      ]),
    )
    const externalConflicts = Object.fromEntries(
      Object.entries(state.externalConflicts).map(([id, conflict]) => [
        remap(id),
        { ...conflict, fileId: remap(conflict.fileId), path: remap(conflict.path) },
      ]),
    )
    return {
      openDocs,
      externalConflicts,
      unsavedFileIds: new Set([...state.unsavedFileIds].map(remap)),
      activeConflictDialogFileId: state.activeConflictDialogFileId
        ? remap(state.activeConflictDialogFileId)
        : null,
    }
  })
  useTabsStore.getState().setTabs((tabs) =>
    tabs.map((tab) => ({
      ...tab,
      fileId: remap(tab.fileId),
      history: tab.history.map(remap),
    })),
  )
}
