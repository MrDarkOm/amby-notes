import { beforeEach, describe, expect, it, vi } from "vitest"

type Handler = (event: { payload: unknown }) => void

const bus = vi.hoisted(() => ({
  handlers: new Map<string, Set<(event: { payload: unknown }) => void>>(),
  labels: ["main", "settings", "note-a"] as string[],
  own: "settings",
}))

vi.mock("@tauri-apps/api/event", () => ({
  listen: async (name: string, handler: Handler) => {
    const set = bus.handlers.get(name) ?? new Set()
    set.add(handler)
    bus.handlers.set(name, set)
    return () => set.delete(handler)
  },
  emit: async (name: string, payload: unknown) => {
    for (const handler of [...(bus.handlers.get(name) ?? [])]) handler({ payload })
  },
}))
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({ label: bus.own }),
  getAllWindows: async () => bus.labels.map((label) => ({ label })),
}))
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn() }, errorType: () => "Error" }))

beforeEach(() => {
  vi.resetModules()
  bus.handlers.clear()
  bus.own = "settings"
})

describe("flushing the edits of every window", () => {
  it("is done when every editing window answered that its edits are safe", async () => {
    const { answerFlushRequests, flushEditingWindows } = await import("./flush-all-windows")
    const asked: string[] = []
    // Two editing windows (main, note-a) answer through the same bus.
    for (const label of ["main", "note-a"]) {
      await answerFlushRequests(label, async () => (asked.push(label), true))
    }
    expect(await flushEditingWindows()).toBe(true)
    expect([...new Set(asked)].sort()).toEqual(["main", "note-a"])
  })

  it("is not done when a window could not keep its edits", async () => {
    const { answerFlushRequests, flushEditingWindows } = await import("./flush-all-windows")
    await answerFlushRequests("main", async () => false)
    await answerFlushRequests("note-a", async () => true)
    expect(await flushEditingWindows()).toBe(false)
  })

  it("is not done when a window never answers", async () => {
    vi.useFakeTimers()
    try {
      const { answerFlushRequests, flushEditingWindows } = await import("./flush-all-windows")
      await answerFlushRequests("main", async () => true)
      const result = flushEditingWindows()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(await result).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it("does not wait for the settings window, which holds no edits", async () => {
    bus.labels = ["main", "settings"]
    const { answerFlushRequests, flushEditingWindows } = await import("./flush-all-windows")
    await answerFlushRequests("main", async () => true)
    expect(await flushEditingWindows()).toBe(true)
    bus.labels = ["main", "settings", "note-a"]
  })
})
