import { flushAllRecoveryDrafts } from "@/lib/recovery-drafts"
import type { RecoveryScope } from "@/lib/recovery-drafts"
import { flushEditorSerializations } from "../tiptap/editor-serialization-lifecycle"
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

export function registerAutosaveLifecycle(participant: AutosaveLifecycleParticipant): () => void {
  participants.add(participant)
  return () => participants.delete(participant)
}

export async function flushAutosaveGeneration(generation: number): Promise<AutosaveFlushResult> {
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
  const results = await Promise.allSettled([
    recoveryPromise,
    ...current.map((participant) => participant.flush()),
  ])
  const firstError = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  )
  if (firstError) throw firstError.reason
  return {
    flushed: current.every((participant) => !participant.hasDirtyBuffers()),
    participants: current.length,
  }
}

export function cancelAutosaveGeneration(generation: number): void {
  for (const participant of participants) {
    if (participant.generation === generation) participant.cancel()
  }
}
