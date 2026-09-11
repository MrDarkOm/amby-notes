import { describe, expect, it, vi } from "vitest"
import { adoptAsyncDisposer } from "./async-disposable"

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe("adoptAsyncDisposer", () => {
  it("disposes a registration that resolves after cleanup", async () => {
    const registration = deferred<() => void>()
    const dispose = vi.fn()
    const cleanup = adoptAsyncDisposer(registration.promise)

    cleanup()
    registration.resolve(dispose)
    await Promise.resolve()

    expect(dispose).toHaveBeenCalledOnce()
  })

  it("disposes an already-resolved registration exactly once", async () => {
    const dispose = vi.fn()
    const cleanup = adoptAsyncDisposer(Promise.resolve(dispose))
    await Promise.resolve()
    cleanup()
    cleanup()
    expect(dispose).toHaveBeenCalledOnce()
  })

  it("reports registration failures without an unhandled rejection", async () => {
    const error = new Error("registration failed")
    const onError = vi.fn()
    adoptAsyncDisposer(Promise.reject(error), onError)
    await Promise.resolve()
    await Promise.resolve()
    expect(onError).toHaveBeenCalledWith(error)
  })
})
