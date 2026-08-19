export type AutosaveDocumentKind = "markdown" | "canvas"

/** A stable identity for a saveable buffer. */
export interface AutosaveKey {
  generation: number
  kind: AutosaveDocumentKind
  documentId: string
}

export interface AutosaveSnapshot<T> {
  key: AutosaveKey
  version: number
  value: T
}

export interface AutosavePendingState {
  key: AutosaveKey
  version: number
  savedVersion: number
  scheduled: boolean
  inFlight: boolean
  paused: boolean
  dirty: boolean
  lastError?: unknown
}

export interface AutosaveTimer {
  set(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>
  clear(handle: ReturnType<typeof setTimeout>): void
}

export interface AutosaveCoordinatorOptions<T> {
  delayMs: number
  save(snapshot: AutosaveSnapshot<T>): Promise<void>
  onSaveSuccess?(snapshot: AutosaveSnapshot<T>): void
  onSaveFailure?(snapshot: AutosaveSnapshot<T>, error: unknown): void
  timer?: AutosaveTimer
}

interface BufferState<T> {
  key: AutosaveKey
  version: number
  savedVersion: number
  value: T
  timer?: ReturnType<typeof setTimeout>
  ready: boolean
  paused: boolean
  inFlight?: Promise<void>
  lastError?: unknown
}

const browserTimer: AutosaveTimer = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle),
}

function keyId(key: AutosaveKey): string {
  return JSON.stringify([key.generation, key.kind, key.documentId])
}

function copyKey(key: AutosaveKey): AutosaveKey {
  return { ...key }
}

/**
 * A framework-independent, versioned autosave state machine. It owns timers
 * and serialisation policy only; persistence remains an injected transport.
 */
export class AutosaveCoordinator<T> {
  private readonly states = new Map<string, BufferState<T>>()
  private readonly timer: AutosaveTimer

  constructor(private readonly options: AutosaveCoordinatorOptions<T>) {
    this.timer = options.timer ?? browserTimer
  }

  schedule(key: AutosaveKey, value: T, delayMs = this.options.delayMs): number {
    const state = this.update(key, value)
    if (state.timer) this.timer.clear(state.timer)
    state.timer = this.timer.set(() => {
      state.timer = undefined
      state.ready = true
      this.startNext(state)
    }, delayMs)
    return state.version
  }

  enqueueImmediate(key: AutosaveKey, value: T): number {
    const state = this.update(key, value)
    if (state.timer) {
      this.timer.clear(state.timer)
      state.timer = undefined
    }
    state.ready = true
    this.startNext(state)
    return state.version
  }

  async flush(key: AutosaveKey): Promise<void> {
    const state = this.states.get(keyId(key))
    if (!state) return
    if (state.timer) {
      this.timer.clear(state.timer)
      state.timer = undefined
      state.ready = true
    }
    // A failed latest save remains dirty; flushing is an explicit retry.
    if (!state.inFlight && state.savedVersion < state.version) state.ready = true
    while (true) {
      this.startNext(state)
      const inFlight = state.inFlight
      if (!inFlight) return
      await inFlight
      if (!this.isCurrent(state)) return
      if (!state.ready && !state.timer && state.savedVersion >= state.version) return
    }
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.states.values()].map((state) => this.flush(state.key)))
  }

  cancelGeneration(generation: number): void {
    for (const [id, state] of this.states) {
      if (state.key.generation !== generation) continue
      if (state.timer) this.timer.clear(state.timer)
      // Already-started transports cannot be safely undone here, but their
      // completion is detached and cannot change coordinator state.
      this.states.delete(id)
    }
  }

  discard(key: AutosaveKey): void {
    const id = keyId(key)
    const state = this.states.get(id)
    if (!state) return
    if (state.timer) this.timer.clear(state.timer)
    this.states.delete(id)
  }

  pause(key: AutosaveKey): void {
    const state = this.states.get(keyId(key))
    if (!state) return
    if (state.timer) {
      this.timer.clear(state.timer)
      state.timer = undefined
    }
    state.paused = true
  }

  resume(key: AutosaveKey): void {
    const state = this.states.get(keyId(key))
    if (!state || !state.paused) return
    state.paused = false
    if (state.savedVersion < state.version) state.ready = true
    this.startNext(state)
  }

  remapKey(from: AutosaveKey, to: AutosaveKey): void {
    const fromId = keyId(from)
    const toId = keyId(to)
    if (fromId === toId) return
    const state = this.states.get(fromId)
    if (!state) return
    if (this.states.has(toId)) throw new Error("Cannot remap autosave key onto an active buffer")

    this.states.delete(fromId)
    state.key = copyKey(to)
    // A write already in flight still addresses the old identity. Bump the
    // version so the remapped identity is always persisted afterwards.
    state.version += 1
    if (state.timer) {
      this.timer.clear(state.timer)
      state.timer = undefined
    }
    state.ready = true
    this.states.set(toId, state)
    this.startNext(state)
  }

  inspect(key: AutosaveKey): AutosavePendingState | undefined {
    const state = this.states.get(keyId(key))
    return state ? this.inspectState(state) : undefined
  }

  inspectAll(): AutosavePendingState[] {
    return [...this.states.values()].map((state) => this.inspectState(state))
  }

  private update(key: AutosaveKey, value: T): BufferState<T> {
    const id = keyId(key)
    const existing = this.states.get(id)
    if (existing) {
      existing.version += 1
      existing.value = value
      existing.lastError = undefined
      return existing
    }
    const state: BufferState<T> = {
      key: copyKey(key),
      version: 1,
      savedVersion: 0,
      value,
      ready: false,
      paused: false,
    }
    this.states.set(id, state)
    return state
  }

  private startNext(state: BufferState<T>): void {
    if (!this.isCurrent(state) || state.inFlight || state.paused || !state.ready) return
    state.ready = false
    const snapshot: AutosaveSnapshot<T> = {
      key: copyKey(state.key),
      version: state.version,
      value: state.value,
    }
    const promise = Promise.resolve().then(() => this.options.save(snapshot))
    state.inFlight = promise
    void promise.then(
      () => {
        if (!this.isCurrent(state)) return
        if (state.inFlight === promise) state.inFlight = undefined
        state.savedVersion = Math.max(state.savedVersion, snapshot.version)
        if (snapshot.version === state.version) state.lastError = undefined
        this.options.onSaveSuccess?.(snapshot)
        this.startNext(state)
      },
      (error: unknown) => {
        if (!this.isCurrent(state)) return
        if (state.inFlight === promise) state.inFlight = undefined
        if (snapshot.version === state.version) state.lastError = error
        this.options.onSaveFailure?.(snapshot, error)
        this.startNext(state)
      },
    )
  }

  private isCurrent(state: BufferState<T>): boolean {
    return this.states.get(keyId(state.key)) === state
  }

  private inspectState(state: BufferState<T>): AutosavePendingState {
    return {
      key: copyKey(state.key),
      version: state.version,
      savedVersion: state.savedVersion,
      scheduled: Boolean(state.timer),
      inFlight: Boolean(state.inFlight),
      paused: state.paused,
      dirty: state.savedVersion < state.version,
      ...(state.lastError === undefined ? {} : { lastError: state.lastError }),
    }
  }
}
