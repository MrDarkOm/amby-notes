import { describe, expect, it, vi } from "vitest"
import {
  AutosaveCoordinator,
  type AutosaveKey,
} from "@/components/workspace/autosave/autosave-coordinator"

function createManualTimer() {
  const pending = new Map<number, () => void>()
  let counter = 0

  return {
    timer: {
      set(callback: () => void) {
        const id = ++counter
        pending.set(id, callback)
        return id as unknown as ReturnType<typeof setTimeout>
      },
      clear(handle: ReturnType<typeof setTimeout>) {
        pending.delete(handle as unknown as number)
      },
    },
    tickAll() {
      const callbacks = [...pending.values()]
      pending.clear()
      callbacks.forEach((cb) => cb())
    },
  }
}

describe("Autosave state machine and error recovery", () => {
  const testKey: AutosaveKey = {
    generation: 1,
    kind: "markdown",
    documentId: "doc-1",
  }

  it("transitions from idle to dirty, scheduled, in-flight, and saved", async () => {
    const { timer, tickAll } = createManualTimer()
    let savedValue = ""

    const coordinator = new AutosaveCoordinator<string>({
      delayMs: 300,
      timer,
      save: async (snapshot) => {
        savedValue = snapshot.value
      },
    })

    // 1. Initial schedule
    coordinator.schedule(testKey, "Initial content")
    let state = coordinator.inspect(testKey)
    expect(state?.dirty).toBe(true)
    expect(state?.scheduled).toBe(true)
    expect(state?.inFlight).toBe(false)

    // 2. Trigger debounce timer
    tickAll()

    await coordinator.flush(testKey)

    // 3. Saved
    state = coordinator.inspect(testKey)
    expect(state?.dirty).toBe(false)
    expect(state?.inFlight).toBe(false)
    expect(savedValue).toBe("Initial content")
  })

  it("handles save failure by keeping state dirty and recording error", async () => {
    const { timer, tickAll } = createManualTimer()
    let shouldFail = true
    const onSaveFailure = vi.fn()
    const onSaveSuccess = vi.fn()

    const coordinator = new AutosaveCoordinator<string>({
      delayMs: 300,
      timer,
      save: async () => {
        if (shouldFail) throw new Error("Disk write error")
      },
      onSaveFailure,
      onSaveSuccess,
    })

    coordinator.schedule(testKey, "Content to fail")
    tickAll()

    await expect(coordinator.flush(testKey)).rejects.toThrow("Disk write error")

    let state = coordinator.inspect(testKey)
    expect(state?.dirty).toBe(true)
    expect(state?.lastError).toBeDefined()
    expect(onSaveFailure).toHaveBeenCalledTimes(1)

    // Retry save with success
    shouldFail = false
    await coordinator.flush(testKey)

    state = coordinator.inspect(testKey)
    expect(state?.dirty).toBe(false)
    expect(state?.lastError).toBeUndefined()
    expect(onSaveSuccess).toHaveBeenCalledTimes(1)
  })
})
