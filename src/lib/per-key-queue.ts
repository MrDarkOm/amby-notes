/**
 * Runs work for the same key in order while allowing different keys to proceed
 * independently. Used by autosave so a slow disk write cannot let an older
 * document buffer overtake a newer one.
 */
export class PerKeySerialQueue {
  private readonly pending = new Map<string, Promise<void>>()

  enqueue(key: string, task: () => Promise<void>): Promise<void> {
    const previous = this.pending.get(key) ?? Promise.resolve()
    const current = previous.catch(() => undefined).then(task)
    this.pending.set(key, current)
    current.then(
      () => this.clearIfCurrent(key, current),
      () => this.clearIfCurrent(key, current),
    )
    return current
  }

  private clearIfCurrent(key: string, current: Promise<void>) {
    if (this.pending.get(key) === current) this.pending.delete(key)
  }
}
