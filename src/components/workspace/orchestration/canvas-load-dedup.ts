/**
 * Shares one pending Canvas load between repeated opens of the same file.
 * The generation is part of the key so a vault switch can never reuse an
 * in-flight request that belongs to the previous workspace.
 */
export class CanvasLoadDeduplicator {
  private readonly pending = new Map<string, Promise<string>>()

  run(generation: number, path: string, load: () => Promise<string>): Promise<string> {
    const key = `${generation}\0${path}`
    const existing = this.pending.get(key)
    if (existing) return existing

    const request = Promise.resolve().then(load)
    this.pending.set(key, request)
    void request.then(
      () => this.deleteIfCurrent(key, request),
      () => this.deleteIfCurrent(key, request),
    )
    return request
  }

  private deleteIfCurrent(key: string, request: Promise<string>) {
    if (this.pending.get(key) === request) this.pending.delete(key)
  }
}
