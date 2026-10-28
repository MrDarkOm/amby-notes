import { registerAutosaveLifecycle } from "./autosave/autosave-lifecycle"

/** Shared ordering for body autosaves and custom-property writes to the same note. */
const queues = new Map<string, Promise<unknown>>()
const propertyVersions = new Map<string, number>()
const pendingProperties = new Map<string, number>()
const keyFor = (generation: number, noteId: string) => `${generation}:${noteId}`

export function enqueueNoteMutation<T>(
  generation: number,
  noteId: string,
  run: () => Promise<T>,
): Promise<T> {
  const key = keyFor(generation, noteId)
  const task = (queues.get(key) ?? Promise.resolve()).catch(() => {}).then(run)
  queues.set(key, task)
  void task
    .finally(() => {
      if (queues.get(key) === task) queues.delete(key)
    })
    .catch(() => {})
  return task
}

/** Property writes participate in the existing close/switch save barrier. */
export function enqueueNotePropertyMutation<T>(
  generation: number,
  noteId: string,
  run: () => Promise<T>,
): Promise<T> {
  let settled = false
  const task = enqueueNoteMutation(generation, noteId, run)
  const unregister = registerAutosaveLifecycle({
    generation,
    flush: async () => {
      await task
    },
    cancel: () => {},
    hasDirtyBuffers: () => !settled,
  })
  void task
    .finally(() => {
      settled = true
      unregister()
    })
    .catch(() => {})
  return task
}

export function propertyVersion(generation: number, noteId: string): number {
  return propertyVersions.get(keyFor(generation, noteId)) ?? 0
}

export function beginPropertyMutation(
  generation: number,
  noteId: string,
): { version: number; finish: () => void } {
  const key = keyFor(generation, noteId)
  const version = propertyVersion(generation, noteId) + 1
  propertyVersions.set(key, version)
  pendingProperties.set(key, (pendingProperties.get(key) ?? 0) + 1)
  return {
    version,
    finish: () => {
      const remaining = (pendingProperties.get(key) ?? 1) - 1
      if (remaining > 0) pendingProperties.set(key, remaining)
      else pendingProperties.delete(key)
    },
  }
}

export function propertyReadIsCurrent(
  generation: number,
  noteId: string,
  version: number,
): boolean {
  return (
    propertyVersion(generation, noteId) === version &&
    !pendingProperties.has(keyFor(generation, noteId))
  )
}
