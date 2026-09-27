import { afterEach, describe, expect, it, vi } from "vitest"
import {
  cancelAutosaveGeneration,
  flushAutosaveGeneration,
  registerAutosaveLifecycle,
  inspectAutosaveGeneration,
} from "./autosave-lifecycle"
import { AutosaveCoordinator, type AutosaveKey } from "./autosave-coordinator"
import { registerEditorSerialization } from "../tiptap/editor-serialization-lifecycle"
import { scheduleRecoveryDraft } from "@/lib/recovery-drafts"
import { commands } from "@/lib/bindings"

describe("autosave lifecycle", () => {
  const unregister: Array<() => void> = []

  afterEach(() => unregister.splice(0).forEach((dispose) => dispose()))

  it("inspects current queue counters without flushing or exposing document identity", () => {
    const flush = vi.fn(async () => {})
    unregister.push(
      registerAutosaveLifecycle({
        generation: 42,
        flush,
        cancel: vi.fn(),
        hasDirtyBuffers: () => true,
        inspect: () => [
          {
            key: { generation: 42, kind: "markdown", documentId: "/private/Secret.md" },
            version: 3,
            savedVersion: 1,
            scheduled: true,
            inFlight: false,
            paused: true,
            dirty: true,
            lastError: new Error("private error"),
          },
        ],
      }),
    )
    const result = inspectAutosaveGeneration(42)
    expect(result).toEqual({
      participants: 1,
      scheduled: 1,
      inFlight: 0,
      paused: 1,
      dirty: 1,
      errors: 1,
    })
    expect(inspectAutosaveGeneration(41).participants).toBe(0)
    expect(flush).not.toHaveBeenCalled()
    expect(JSON.stringify(result)).not.toMatch(/private|Secret/)
  })

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

  it("serializes an edit made less than 200 ms before close before draining autosave", async () => {
    vi.useFakeTimers()
    const save = vi.fn(async () => {})
    const key: AutosaveKey = { generation: 9, kind: "markdown", documentId: "note-1" }
    const coordinator = new AutosaveCoordinator<string>({ delayMs: 200, save })
    let editorDirty = true

    unregister.push(
      registerEditorSerialization({
        flush: () => {
          if (!editorDirty) return
          editorDirty = false
          coordinator.enqueueImmediate(key, "last transaction")
        },
      }),
      registerAutosaveLifecycle({
        generation: 9,
        flush: () => coordinator.flushAll(),
        cancel: () => {},
        hasDirtyBuffers: () => coordinator.inspect(key)?.dirty ?? false,
      }),
    )

    // The normal serializer timer has not yet reached its 200 ms deadline.
    vi.advanceTimersByTime(199)
    await expect(flushAutosaveGeneration(9)).resolves.toEqual({ flushed: true, participants: 1 })

    expect(save).toHaveBeenCalledWith({ key, version: 1, value: "last transaction" })
  })

  it("still flushes primary participants when recovery persistence fails", async () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: {} })
    vi.spyOn(commands, "saveRecovery").mockRejectedValue(new Error("disk full"))
    scheduleRecoveryDraft("recovery-failure", "latest", "markdown", "/vault/latest.md")
    const primaryFlush = vi.fn(async () => {})
    unregister.push(
      registerAutosaveLifecycle({
        generation: 12,
        flush: primaryFlush,
        cancel: vi.fn(),
        hasDirtyBuffers: () => false,
      }),
    )

    await expect(flushAutosaveGeneration(12)).rejects.toThrow("disk full")
    expect(primaryFlush).toHaveBeenCalledOnce()
  })
})
