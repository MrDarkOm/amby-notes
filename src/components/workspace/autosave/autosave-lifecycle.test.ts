import { afterEach, describe, expect, it, vi } from "vitest"
import {
  cancelAutosaveGeneration,
  flushAutosaveGeneration,
  flushBeforeLeaving,
  hasUnsavedAutosave,
  mayLeaveAfterFlush,
  registerAutosaveLifecycle,
  inspectAutosaveGeneration,
  waitForInFlightAutosave,
} from "./autosave-lifecycle"
import { AutosaveCoordinator, type AutosaveKey } from "./autosave-coordinator"
import { registerEditorSerialization } from "../tiptap/editor-serialization-lifecycle"
import { scheduleRecoveryDraft } from "@/lib/recovery-drafts"
import { commands } from "@/lib/bindings"

describe("autosave lifecycle", () => {
  const unregister: Array<() => void> = []

  afterEach(() => unregister.splice(0).forEach((dispose) => dispose()))

  it("observes only in-flight transports in the selected generation without flushing", async () => {
    const flush = vi.fn(async () => {})
    const activeWait = vi.fn(async () => {})
    const staleWait = vi.fn(async () => {})
    for (const [generation, waitForInFlight] of [
      [42, activeWait],
      [41, staleWait],
    ] as const) {
      unregister.push(
        registerAutosaveLifecycle({
          generation,
          flush,
          cancel: vi.fn(),
          hasDirtyBuffers: () => true,
          waitForInFlight,
        }),
      )
    }
    const key = { generation: 42, kind: "markdown" as const, documentId: "note" }
    await waitForInFlightAutosave(key)
    expect(activeWait).toHaveBeenCalledWith(key)
    expect(staleWait).not.toHaveBeenCalled()
    expect(flush).not.toHaveBeenCalled()
  })

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

  // SAVE-02: leaving (closing the window, switching the vault) is safe only when every edit is in its
  // file or in a durable recovery draft. A full disk breaks both at once.
  describe("before leaving", () => {
    // Each case has its own recovery scope, so drafts left failed by one case do not leak into the next.
    const scope = (generation: number) => ({ vault: `/vault-${generation}`, generation })
    function failRecovery(id: string, generation: number) {
      vi.stubGlobal("window", { __TAURI_INTERNALS__: {} })
      vi.spyOn(commands, "saveRecovery").mockRejectedValue(new Error("disk full"))
      scheduleRecoveryDraft(id, "latest", "markdown", `/vault/${id}.md`, scope(generation))
    }

    afterEach(() => {
      vi.restoreAllMocks()
      vi.unstubAllGlobals()
    })

    it("is not safe when the save and the recovery draft both failed", async () => {
      failRecovery("both-failed", 21)
      unregister.push(
        registerAutosaveLifecycle({
          generation: 21,
          recoveryScope: scope(21),
          flush: async () => {
            throw new Error("disk full")
          },
          cancel: vi.fn(),
          hasDirtyBuffers: () => true,
        }),
      )
      await expect(flushBeforeLeaving(21)).resolves.toMatchObject({ safe: false, flushed: false })
    })

    it("is safe when the draft failed but every note was saved", async () => {
      failRecovery("saved-anyway", 22)
      unregister.push(
        registerAutosaveLifecycle({
          generation: 22,
          recoveryScope: scope(22),
          flush: async () => {},
          cancel: vi.fn(),
          hasDirtyBuffers: () => false,
        }),
      )
      await expect(flushBeforeLeaving(22)).resolves.toMatchObject({ safe: true, flushed: true })
    })

    it("is safe when the save failed but the draft was written", async () => {
      unregister.push(
        registerAutosaveLifecycle({
          generation: 23,
          recoveryScope: scope(23),
          flush: async () => {
            throw new Error("permission denied")
          },
          cancel: vi.fn(),
          hasDirtyBuffers: () => true,
        }),
      )
      await expect(flushBeforeLeaving(23)).resolves.toMatchObject({ safe: true, flushed: false })
    })

    it("asks before leaving only when the text would be lost, and follows the answer", async () => {
      failRecovery("ask", 24)
      unregister.push(
        registerAutosaveLifecycle({
          generation: 24,
          recoveryScope: scope(24),
          flush: async () => {
            throw new Error("disk full")
          },
          cancel: vi.fn(),
          hasDirtyBuffers: () => true,
        }),
      )
      const stay = vi.fn(async () => false)
      await expect(mayLeaveAfterFlush(24, stay)).resolves.toBe(false)
      expect(stay).toHaveBeenCalledOnce()
      const leave = vi.fn(async () => true)
      await expect(mayLeaveAfterFlush(24, leave)).resolves.toBe(true)

      const notAsked = vi.fn(async () => false)
      await expect(mayLeaveAfterFlush(999, notAsked)).resolves.toBe(true)
      expect(notAsked).not.toHaveBeenCalled()
    })
  })

  // SAVE-03: the editor and the watcher ask the queue, not only the store flag, whether a note is clean.
  it("reports a document with a queued, unsaved snapshot", async () => {
    vi.useFakeTimers()
    const coordinator = new AutosaveCoordinator<string>({
      delayMs: 500,
      save: async () => {},
    })
    unregister.push(
      registerAutosaveLifecycle({
        generation: 31,
        flush: () => coordinator.flushAll(),
        cancel: () => {},
        hasDirtyBuffers: () => false,
        inspect: () => coordinator.inspectAll(),
      }),
    )
    const key = { generation: 31, kind: "markdown" as const, documentId: "queued" }
    expect(hasUnsavedAutosave(key)).toBe(false)
    coordinator.schedule(key, "text")
    expect(hasUnsavedAutosave(key)).toBe(true)
    expect(hasUnsavedAutosave({ ...key, documentId: "other" })).toBe(false)
    expect(hasUnsavedAutosave({ ...key, generation: 30 })).toBe(false)
    await coordinator.flush(key)
    expect(hasUnsavedAutosave(key)).toBe(false)
    vi.useRealTimers()
  })
})
