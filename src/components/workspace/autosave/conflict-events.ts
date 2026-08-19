export const AUTOSAVE_CONFLICT_RESOLVED_EVENT = "amby:autosave-conflict-resolved"

export type AutosaveConflictResolution = "resume" | "discard"

export function emitAutosaveConflictResolution(
  fileId: string,
  resolution: AutosaveConflictResolution,
): void {
  window.dispatchEvent(
    new CustomEvent(AUTOSAVE_CONFLICT_RESOLVED_EVENT, { detail: { fileId, resolution } }),
  )
}
