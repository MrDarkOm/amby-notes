import { flushAllRecoveryDrafts } from "@/lib/recovery-drafts"
import type { RecoveryScope } from "@/lib/recovery-drafts"
import { flushEditorSerializations } from "../tiptap/editor-serialization-lifecycle"
import { isPathInside } from "../workspace-mutations"
import type { AutosaveKey, AutosavePendingState } from "./autosave-coordinator"

/** Coordinates editor-owned autosave queues at vault lifecycle boundaries. */
export interface AutosaveLifecycleParticipant {
  generation: number
  recoveryScope?: RecoveryScope
  flush(): Promise<void>
  cancel(): void
  hasDirtyBuffers(): boolean
  /** Read-only inspection; never flushes editor state or accesses note contents. */
  inspect?(): AutosavePendingState[]
  /** Wait for active transports only; never flush queued edits. */
  waitForInFlight?(key: AutosaveKey): Promise<void>
  /** Hold the queue of one document: no write starts until `resume`. */
  pause?(key: AutosaveKey): void
  resume?(key: AutosaveKey): void
}

export interface AutosaveFlushResult {
  flushed: boolean
  participants: number
}

const participants = new Set<AutosaveLifecycleParticipant>()

export async function waitForInFlightAutosave(key: AutosaveKey): Promise<void> {
  await Promise.all(
    [...participants]
      .filter((participant) => participant.generation === key.generation)
      .map((participant) => participant.waitForInFlight?.(key)),
  )
}

/**
 * Hold the queued saves of every canvas and sketch at or under `root` and wait for the writes already
 * running, so a rename or move cannot meet a write to the old path (SAVE-10: the write would find the file
 * gone, ask "changed elsewhere", and "Overwrite" would bring the old file back). Call the returned
 * `release` once the operation ended, with the new path of an old one (identity when it did not move):
 * the queue is resumed under the key it has then. Notes are not held here: their saves are keyed by id.
 */
export async function holdLayerAutosavesInside(
  generation: number,
  root: string,
): Promise<(newPathOf: (oldPath: string) => string) => void> {
  const inside = (path: string) => isPathInside(path, root)
  const held: { participant: AutosaveLifecycleParticipant; key: AutosaveKey }[] = []
  for (const participant of participants) {
    if (participant.generation !== generation || !participant.pause) continue
    for (const state of participant.inspect?.() ?? []) {
      // A queue already held (an unanswered conflict) stays held: resuming it would ask again.
      if (state.key.kind === "markdown" || state.paused || !inside(state.key.documentId)) continue
      participant.pause(state.key)
      held.push({ participant, key: state.key })
    }
  }
  try {
    await Promise.all(held.map(({ participant, key }) => participant.waitForInFlight?.(key)))
  } catch (error) {
    for (const { participant, key } of held) participant.resume?.(key)
    throw error
  }
  return (newPathOf) => {
    for (const { participant, key } of held) {
      participant.resume?.({ ...key, documentId: newPathOf(key.documentId) })
      // The rename did not happen (or did not touch this path): the old key is still the queue.
      participant.resume?.(key)
    }
  }
}

export function inspectAutosaveGeneration(generation: number) {
  const current = [...participants].filter((participant) => participant.generation === generation)
  const states = current.flatMap((participant) => participant.inspect?.() ?? [])
  return {
    participants: current.length,
    scheduled: states.filter((state) => state.scheduled).length,
    inFlight: states.filter((state) => state.inFlight).length,
    paused: states.filter((state) => state.paused).length,
    dirty: states.filter((state) => state.dirty).length,
    errors: states.filter((state) => state.lastError !== undefined).length,
  }
}

/**
 * True while a queue of `key.generation` holds a newer, not yet saved snapshot of this document. The
 * store's unsaved flag alone is not enough: an edit that returns to the saved text marks the buffer
 * clean while its save is still queued, and a "clean" buffer is then replaced by an external change
 * that the queued save writes over (SAVE-03). Ask this before treating a document as clean.
 */
export function hasUnsavedAutosave(key: AutosaveKey): boolean {
  return [...participants].some(
    (participant) =>
      participant.generation === key.generation &&
      (participant.inspect?.() ?? []).some(
        (state) =>
          state.key.kind === key.kind &&
          state.key.documentId === key.documentId &&
          (state.dirty || state.scheduled),
      ),
  )
}

export function registerAutosaveLifecycle(participant: AutosaveLifecycleParticipant): () => void {
  participants.add(participant)
  return () => participants.delete(participant)
}

interface SettledFlush {
  flushed: boolean
  participants: number
  recoveryError?: unknown
  saveError?: unknown
}

async function settleAutosaveGeneration(generation: number): Promise<SettledFlush> {
  // Publish the final debounced ProseMirror transaction before inspecting or
  // draining coordinator buffers. An untouched editor is a no-op participant.
  flushEditorSerializations()
  const current = [...participants].filter((participant) => participant.generation === generation)
  const scopes = current
    .map((participant) => participant.recoveryScope)
    .filter((scope): scope is RecoveryScope => Boolean(scope))
  const recoveryPromise =
    scopes.length > 0
      ? Promise.all(scopes.map((scope) => flushAllRecoveryDrafts(scope)))
      : flushAllRecoveryDrafts()
  const [recovery, ...saves] = await Promise.allSettled([
    recoveryPromise,
    ...current.map((participant) => participant.flush()),
  ])
  const failedSave = saves.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  )
  return {
    flushed: !failedSave && current.every((participant) => !participant.hasDirtyBuffers()),
    participants: current.length,
    recoveryError: recovery.status === "rejected" ? recovery.reason : undefined,
    saveError: failedSave?.reason,
  }
}

export async function flushAutosaveGeneration(generation: number): Promise<AutosaveFlushResult> {
  const settled = await settleAutosaveGeneration(generation)
  const firstError = settled.recoveryError ?? settled.saveError
  if (firstError !== undefined) throw firstError
  return { flushed: settled.flushed, participants: settled.participants }
}

export interface LeaveFlushResult extends AutosaveFlushResult {
  /**
   * Every edit is in its file or in a written recovery draft. False when a note could not be saved
   * and its draft could not be written either (a full disk breaks both): leaving would lose text.
   */
  safe: boolean
}

/** Flush before the window closes or the vault changes, and say whether leaving keeps every edit. */
export async function flushBeforeLeaving(generation: number): Promise<LeaveFlushResult> {
  const settled = await settleAutosaveGeneration(generation)
  return {
    flushed: settled.flushed,
    participants: settled.participants,
    safe: settled.flushed || settled.recoveryError === undefined,
  }
}

/**
 * Flush, then decide whether to leave. `askToLeaveAnyway` is asked only when leaving would lose text
 * (SAVE-02); a failed flush itself is never a reason to lose it silently.
 */
export async function mayLeaveAfterFlush(
  generation: number,
  askToLeaveAnyway: () => Promise<boolean>,
): Promise<boolean> {
  const result = await flushBeforeLeaving(generation)
  return result.safe || (await askToLeaveAnyway())
}

export function cancelAutosaveGeneration(generation: number): void {
  for (const participant of participants) {
    if (participant.generation === generation) participant.cancel()
  }
}
