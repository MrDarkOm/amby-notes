import { afterEach, describe, expect, it, vi } from "vitest"
import {
  cancelAutosaveGeneration,
  flushAutosaveGeneration,
  registerAutosaveLifecycle,
} from "./autosave-lifecycle"

describe("autosave lifecycle", () => {
  const unregister: Array<() => void> = []

  afterEach(() => unregister.splice(0).forEach((dispose) => dispose()))

  it("flushes only the active vault generation and reports unresolved saves", async () => {
    const activeFlush = vi.fn(async () => {})
    const staleFlush = vi.fn(async () => {})
    unregister.push(
      registerAutosaveLifecycle({
        generation: 4,
        flush: activeFlush,
        cancel: vi.fn(),
        hasDirtyBuffers: () => true,
      }),
      registerAutosaveLifecycle({
        generation: 3,
        flush: staleFlush,
        cancel: vi.fn(),
        hasDirtyBuffers: () => false,
      }),
    )

    await expect(flushAutosaveGeneration(4)).resolves.toEqual({ flushed: false, participants: 1 })
    expect(activeFlush).toHaveBeenCalledOnce()
    expect(staleFlush).not.toHaveBeenCalled()
  })

  it("cancels only the requested generation", () => {
    const activeCancel = vi.fn()
    const staleCancel = vi.fn()
    unregister.push(
      registerAutosaveLifecycle({
        generation: 7,
        flush: async () => {},
        cancel: activeCancel,
        hasDirtyBuffers: () => false,
      }),
      registerAutosaveLifecycle({
        generation: 6,
        flush: async () => {},
        cancel: staleCancel,
        hasDirtyBuffers: () => false,
      }),
    )

    cancelAutosaveGeneration(7)

    expect(activeCancel).toHaveBeenCalledOnce()
    expect(staleCancel).not.toHaveBeenCalled()
  })
})
