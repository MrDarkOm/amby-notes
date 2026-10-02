/**
 * Batches and caches key lookups: many visible items ask at once, but the
 * backend call is shared. Failures are not cached, and `clear()` answers every
 * queued or in-flight request with `null`, so a vault switch cannot leak old data.
 */
export interface BatchResolver<V> {
  request(key: string): Promise<V | null>
  clear(): void
}

const MAX_BATCH = 200

export function createBatchResolver<V>(
  resolve: (keys: string[]) => Promise<Array<V | null>>,
  delayMs = 16,
): BatchResolver<V> {
  let cache = new Map<string, Promise<V | null>>()
  const queue: Array<{
    key: string
    done: (value: V | null) => void
    fail: (error: unknown) => void
  }> = []
  let timer: ReturnType<typeof setTimeout> | null = null
  let generation = 0

  function flush() {
    timer = null
    const batch = queue.splice(0, MAX_BATCH)
    if (queue.length > 0) timer = setTimeout(flush, delayMs)
    if (batch.length === 0) return
    const flushGeneration = generation
    resolve(batch.map((item) => item.key)).then(
      (values) => {
        if (flushGeneration !== generation) return batch.forEach((item) => item.done(null))
        batch.forEach((item, index) => item.done(values[index] ?? null))
      },
      (error) => batch.forEach((item) => item.fail(error)),
    )
  }

  return {
    request(key) {
      const cached = cache.get(key)
      if (cached) return cached
      const pending = new Promise<V | null>((done, fail) => {
        queue.push({ key, done, fail })
        if (!timer) timer = setTimeout(flush, delayMs)
      })
      const tracked = pending.catch((error) => {
        if (cache.get(key) === tracked) cache.delete(key)
        throw error
      })
      cache.set(key, tracked)
      return tracked
    },
    clear() {
      generation += 1
      cache = new Map()
      for (const item of queue.splice(0)) item.done(null)
      if (timer) clearTimeout(timer)
      timer = null
    },
  }
}
