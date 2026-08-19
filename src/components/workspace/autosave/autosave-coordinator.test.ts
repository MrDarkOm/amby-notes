import { afterEach, describe, expect, it, vi } from "vitest"
import {
  AutosaveCoordinator,
  type AutosaveKey,
  type AutosaveSnapshot,
} from "./autosave-coordinator"

const markdownKey = (documentId: string, generation = 1): AutosaveKey => ({
  generation,
  kind: "markdown",
  documentId,
})

const canvasKey = (documentId: string, generation = 1): AutosaveKey => ({
  generation,
  kind: "canvas",
  documentId,
})

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function settle() {
  await Promise.resolve()
  await Promise.resolve()
}

afterEach(() => vi.useRealTimers())

describe("AutosaveCoordinator", () => {
  it("serializes versions for one key and keeps newer buffers dirty", async () => {
    vi.useFakeTimers()
    const first = deferred()
    const second = deferred()
    const saves: AutosaveSnapshot<string>[] = []
    const coordinator = new AutosaveCoordinator<string>({
      delayMs: 100,
      save: (snapshot) => {
        saves.push(snapshot)
        return saves.length === 1 ? first.promise : second.promise
      },
    })
    const key = markdownKey("note")

    coordinator.schedule(key, "first")
    vi.advanceTimersByTime(100)
    await settle()
    coordinator.enqueueImmediate(key, "second")
    await settle()

    expect(saves).toEqual([{ key, version: 1, value: "first" }])
    first.resolve()
    await settle()
    expect(saves).toEqual([
      { key, version: 1, value: "first" },
      { key, version: 2, value: "second" },
    ])
    expect(coordinator.inspect(key)).toMatchObject({ dirty: true, savedVersion: 1, version: 2 })

    second.resolve()
    await settle()
    expect(coordinator.inspect(key)).toMatchObject({ dirty: false, savedVersion: 2 })
  })

  it("allows different keys to save concurrently", async () => {
    const pending = [deferred(), deferred()]
    const save = vi.fn(() => pending.shift()!.promise)
    const coordinator = new AutosaveCoordinator<string>({ delayMs: 1, save })

    coordinator.enqueueImmediate(markdownKey("one"), "one")
    coordinator.enqueueImmediate(markdownKey("two"), "two")
    await settle()

    expect(save).toHaveBeenCalledTimes(2)
  })

  it("cancels a stale generation before its timer can write", async () => {
    vi.useFakeTimers()
    const save = vi.fn(async () => {})
    const coordinator = new AutosaveCoordinator<string>({ delayMs: 100, save })
    const stale = markdownKey("note", 4)

    coordinator.schedule(stale, "stale")
    coordinator.cancelGeneration(4)
    vi.advanceTimersByTime(100)
    await settle()

    expect(save).not.toHaveBeenCalled()
    expect(coordinator.inspect(stale)).toBeUndefined()
  })

  it("pauses a conflicting buffer until an explicit resume", async () => {
    vi.useFakeTimers()
    const save = vi.fn(async () => {})
    const coordinator = new AutosaveCoordinator<string>({ delayMs: 100, save })
    const key = markdownKey("conflicted")

    coordinator.schedule(key, "local")
    coordinator.pause(key)
    vi.advanceTimersByTime(100)
    await settle()
    expect(save).not.toHaveBeenCalled()
    expect(coordinator.inspect(key)).toMatchObject({ dirty: true, paused: true })

    coordinator.resume(key)
    await settle()
    expect(save).toHaveBeenCalledWith({ key, version: 1, value: "local" })
  })

  it("flushes a pending timer and waits for its queued write", async () => {
    vi.useFakeTimers()
    const saveDeferred = deferred()
    const save = vi.fn(() => saveDeferred.promise)
    const coordinator = new AutosaveCoordinator<string>({ delayMs: 10_000, save })
    const key = markdownKey("note")
    coordinator.schedule(key, "content")

    let complete = false
    const flushing = coordinator.flush(key).then(() => {
      complete = true
    })
    await settle()
    expect(save).toHaveBeenCalledTimes(1)
    expect(complete).toBe(false)

    saveDeferred.resolve()
    await flushing
    expect(complete).toBe(true)
    expect(coordinator.inspect(key)).toMatchObject({ dirty: false })
  })

  it("remaps an in-flight buffer and writes the new identity afterwards", async () => {
    const first = deferred()
    const second = deferred()
    const saves: AutosaveSnapshot<string>[] = []
    const coordinator = new AutosaveCoordinator<string>({
      delayMs: 1,
      save: (snapshot) => {
        saves.push(snapshot)
        return saves.length === 1 ? first.promise : second.promise
      },
    })
    const from = markdownKey("old")
    const to = markdownKey("new")

    coordinator.enqueueImmediate(from, "content")
    await settle()
    coordinator.remapKey(from, to)
    first.resolve()
    await settle()

    expect(saves.map((snapshot) => snapshot.key)).toEqual([from, to])
    expect(saves[1]).toMatchObject({ version: 2, value: "content" })
    second.resolve()
    await settle()
    expect(coordinator.inspect(to)).toMatchObject({ dirty: false, savedVersion: 2 })
  })

  it("reports failures without clearing the dirty version", async () => {
    const failure = new Error("disk unavailable")
    const onSaveFailure = vi.fn()
    const coordinator = new AutosaveCoordinator<string>({
      delayMs: 1,
      save: async () => Promise.reject(failure),
      onSaveFailure,
    })
    const key = markdownKey("note")

    coordinator.enqueueImmediate(key, "content")
    await vi.waitFor(() => expect(onSaveFailure).toHaveBeenCalledTimes(1))

    expect(onSaveFailure).toHaveBeenCalledWith({ key, version: 1, value: "content" }, failure)
    expect(coordinator.inspect(key)).toMatchObject({ dirty: true, lastError: failure })
  })

  it("finishes a pending Canvas save after its editor closes", async () => {
    const pending = deferred()
    const save = vi.fn(() => pending.promise)
    const coordinator = new AutosaveCoordinator<string>({ delayMs: 1, save })
    const key = canvasKey("/vault/Diagram.canvas")

    coordinator.enqueueImmediate(key, '{"nodes":[],"edges":[]}')
    await settle()
    // Closing an editor must not cancel its coordinator-owned save.
    expect(save).toHaveBeenCalledTimes(1)
    pending.resolve()
    await settle()

    expect(coordinator.inspect(key)).toMatchObject({ dirty: false })
  })

  it("remaps a pending Canvas save when the file is renamed", async () => {
    const first = deferred()
    const second = deferred()
    const saves: AutosaveSnapshot<string>[] = []
    const coordinator = new AutosaveCoordinator<string>({
      delayMs: 1,
      save: (snapshot) => {
        saves.push(snapshot)
        return saves.length === 1 ? first.promise : second.promise
      },
    })
    const beforeRename = canvasKey("/vault/Diagram.canvas")
    const afterRename = canvasKey("/vault/Renamed.canvas")

    coordinator.enqueueImmediate(beforeRename, "first")
    await settle()
    coordinator.remapKey(beforeRename, afterRename)
    first.resolve()
    await settle()

    expect(saves.map((snapshot) => snapshot.key)).toEqual([beforeRename, afterRename])
    second.resolve()
    await settle()
    expect(coordinator.inspect(afterRename)).toMatchObject({ dirty: false })
  })
})
