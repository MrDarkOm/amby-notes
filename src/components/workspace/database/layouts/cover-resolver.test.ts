import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createCoverResolver } from "./cover-resolver"

describe("createCoverResolver", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("batches simultaneous requests into one call and dedupes paths", async () => {
    const resolve = vi.fn(async (paths: string[]) => paths.map((path) => `/abs/${path}`))
    const resolver = createCoverResolver(resolve)
    const results = Promise.all([
      resolver.request("assets/a.png"),
      resolver.request("assets/b.png"),
      resolver.request("assets/a.png"),
    ])
    await vi.advanceTimersByTimeAsync(20)
    expect(await results).toEqual(["/abs/assets/a.png", "/abs/assets/b.png", "/abs/assets/a.png"])
    expect(resolve).toHaveBeenCalledTimes(1)
    expect(resolve.mock.calls[0][0]).toEqual(["assets/a.png", "assets/b.png"])
    // Later requests are served from the cache.
    expect(await resolver.request("assets/a.png")).toBe("/abs/assets/a.png")
    expect(resolve).toHaveBeenCalledTimes(1)
  })

  it("does not cache failures, so the next request retries", async () => {
    const resolve = vi
      .fn<(paths: string[]) => Promise<Array<string | null>>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(["/abs/a.png"])
    const resolver = createCoverResolver(resolve)
    const first = resolver.request("a.png")
    const firstOutcome = first.catch((error: Error) => error.message)
    await vi.advanceTimersByTimeAsync(20)
    expect(await firstOutcome).toBe("offline")
    const second = resolver.request("a.png")
    await vi.advanceTimersByTimeAsync(20)
    expect(await second).toBe("/abs/a.png")
  })

  it("answers nothing for lookups that were cleared by a vault change", async () => {
    let release: (value: Array<string | null>) => void = () => {}
    const resolve = vi.fn(() => new Promise<Array<string | null>>((done) => (release = done)))
    const resolver = createCoverResolver(resolve)
    const pending = resolver.request("a.png")
    await vi.advanceTimersByTimeAsync(20)
    resolver.clear()
    release(["/old-vault/a.png"])
    expect(await pending).toBeNull()
  })

  it("splits more than 200 paths across calls", async () => {
    const resolve = vi.fn(async (paths: string[]) => paths.map(() => "/x"))
    const resolver = createCoverResolver(resolve)
    const all = Promise.all(
      Array.from({ length: 250 }, (_, index) => resolver.request(`p${index}`)),
    )
    await vi.advanceTimersByTimeAsync(100)
    await all
    expect(resolve.mock.calls.map((call) => call[0].length)).toEqual([200, 50])
  })
})
