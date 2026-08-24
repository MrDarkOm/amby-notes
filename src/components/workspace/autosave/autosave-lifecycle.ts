/** Coordinates editor-owned autosave queues at vault lifecycle boundaries. */
export interface AutosaveLifecycleParticipant {
  generation: number
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
  await Promise.all(current.map((participant) => participant.flush()))
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
import { flushEditorSerializations } from "../tiptap/editor-serialization-lifecycle"
