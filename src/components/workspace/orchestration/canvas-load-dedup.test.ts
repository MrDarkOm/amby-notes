import { describe, expect, it, vi } from "vitest"

import { CanvasLoadDeduplicator } from "./canvas-load-dedup"

describe("CanvasLoadDeduplicator", () => {
  it("shares a pending load for the same generation and path", async () => {
    let resolveLoad!: (value: string) => void
    const load = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          resolveLoad = resolve
        }),
    )
    const deduplicator = new CanvasLoadDeduplicator()

    const first = deduplicator.run(3, "/vault/board.canvas", load)
    const second = deduplicator.run(3, "/vault/board.canvas", load)

    expect(second).toBe(first)
    await Promise.resolve()
    expect(load).toHaveBeenCalledTimes(1)
    resolveLoad("canvas")
    await expect(first).resolves.toBe("canvas")
  })

  it("does not reuse a load across vault generations", async () => {
    const load = vi.fn(async () => "canvas")
    const deduplicator = new CanvasLoadDeduplicator()

    await Promise.all([
      deduplicator.run(3, "/vault/board.canvas", load),
      deduplicator.run(4, "/vault/board.canvas", load),
    ])

    expect(load).toHaveBeenCalledTimes(2)
  })

  it("allows retry after a rejected load", async () => {
    const load = vi
      .fn<() => Promise<string>>()
      .mockRejectedValueOnce(new Error("failed"))
      .mockResolvedValueOnce("retried")
    const deduplicator = new CanvasLoadDeduplicator()

    await expect(deduplicator.run(3, "/vault/board.canvas", load)).rejects.toThrow("failed")
    await expect(deduplicator.run(3, "/vault/board.canvas", load)).resolves.toBe("retried")
    expect(load).toHaveBeenCalledTimes(2)
  })
})
