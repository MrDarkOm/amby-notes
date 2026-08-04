import { describe, expect, it } from "vitest"
import { PerKeySerialQueue } from "./per-key-queue"

describe("PerKeySerialQueue", () => {
  it("serializes work for the same key", async () => {
    const queue = new PerKeySerialQueue()
    const events: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = queue.enqueue("note", async () => {
      events.push("first:start")
      await firstGate
      events.push("first:end")
    })
    const second = queue.enqueue("note", async () => {
      events.push("second")
    })

    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events).toEqual(["first:start"])
    releaseFirst()
    await Promise.all([first, second])
    expect(events).toEqual(["first:start", "first:end", "second"])
  })

  it("does not block a different key", async () => {
    const queue = new PerKeySerialQueue()
    const events: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })

    const first = queue.enqueue("one", async () => {
      await firstGate
    })
    await queue.enqueue("two", async () => {
      events.push("two")
    })

    expect(events).toEqual(["two"])
    releaseFirst()
    await first
  })
})
