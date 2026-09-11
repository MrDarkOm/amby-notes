import { flushAllRecoveryDrafts } from "@/lib/recovery-drafts"
import type { RecoveryScope } from "@/lib/recovery-drafts"
import { flushEditorSerializations } from "../tiptap/editor-serialization-lifecycle"

/** Coordinates editor-owned autosave queues at vault lifecycle boundaries. */
export interface AutosaveLifecycleParticipant {
  generation: number
  recoveryScope?: RecoveryScope
  flush(): Promise<void>
  cancel(): void
  hasDirtyBuffers(): boolean
}

export interface AutosaveFlushResult {
  flushed: boolean
  participants: number
}

const participants = new Set<AutosaveLifecycleParticipant>()

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
