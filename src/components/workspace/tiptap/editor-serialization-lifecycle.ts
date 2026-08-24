/** A mounted rich editor can publish its debounced Markdown before autosave flushes. */
export interface EditorSerializationParticipant {
  flush(): void
}

const participants = new Set<EditorSerializationParticipant>()

export function registerEditorSerialization(
  participant: EditorSerializationParticipant,
): () => void {
  participants.add(participant)
  return () => participants.delete(participant)
}

/**
 * Runs synchronously because a rich editor's serializer only needs to publish
 * its current ProseMirror state into the coordinator. Filesystem I/O remains
 * owned by the later autosave lifecycle stage.
 */
export function flushEditorSerializations(): void {
  for (const participant of participants) participant.flush()
}
