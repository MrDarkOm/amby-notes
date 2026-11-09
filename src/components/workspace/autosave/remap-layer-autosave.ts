import type { AutosaveCoordinator, AutosaveKey } from "./autosave-coordinator"
import type { FileRevisionTracker } from "./file-revision-tracker"

/** Move the revision before remapping the queue: remapKey may start a save immediately. */
export function remapLayerAutosave<T extends { path: string }>(
  coordinator: AutosaveCoordinator<T>,
  revisions: FileRevisionTracker,
  from: AutosaveKey,
  to: AutosaveKey,
): void {
  revisions.rename(from.documentId, to.documentId)
  coordinator.remapKey(from, to, (payload) => ({ ...payload, path: to.documentId }))
}
