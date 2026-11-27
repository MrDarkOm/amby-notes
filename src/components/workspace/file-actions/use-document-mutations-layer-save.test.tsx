// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FsMutationResult, TreeItem } from "@/lib/storage"
import { AutosaveCoordinator, type AutosaveKey } from "../autosave/autosave-coordinator"
import { registerAutosaveLifecycle } from "../autosave/autosave-lifecycle"
import { useVaultStore } from "../use-vault-store"
import { useDocumentMutations } from "./use-document-mutations"

const renameItem = vi.fn()

vi.mock("@/lib/storage", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/storage")>()
  return {
    ...original,
    renameItem: (...args: unknown[]) => renameItem(...args),
  }
})
vi.mock("@/lib/confirm", () => ({ confirm: vi.fn() }))

const OLD = "/v/Доска.canvas"
const NEW = "/v/Новая.canvas"
const TREE: TreeItem[] = [{ id: OLD, path: OLD, name: "Доска", type: "file" }]
const renamed: FsMutationResult = {
  primaryId: NEW,
  primaryPath: NEW,
  pathChanges: [{ oldPath: OLD, newPath: NEW }],
  deletedPaths: [],
}

type Payload = { path: string; json: string }

describe("renaming a canvas whose save is still queued (SAVE-10)", () => {
  let events: string[]
  let releaseFirstWrite: () => void
  let coordinator: AutosaveCoordinator<Payload>
  let unregister: () => void
  const generation = 1
  const key = (path: string): AutosaveKey => ({ generation, kind: "canvas", documentId: path })

  beforeEach(() => {
    events = []
    useVaultStore.setState({ vault: "/v", generation })
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve
    })
    let writes = 0
    coordinator = new AutosaveCoordinator<Payload>({
      delayMs: 0,
      save: async ({ value }) => {
        events.push(`write-start:${value.path}:${value.json}`)
        if (writes++ === 0) await firstWrite
        events.push(`write-end:${value.path}:${value.json}`)
      },
    })
    unregister = registerAutosaveLifecycle({
      generation,
      flush: () => coordinator.flushAll(),
      cancel: () => coordinator.cancelGeneration(generation),
      hasDirtyBuffers: () => coordinator.inspectAll().some((state) => state.dirty),
      inspect: () => coordinator.inspectAll(),
      waitForInFlight: (k) => coordinator.waitForInFlight(k),
      pause: (k) => coordinator.pause(k),
      resume: (k) => coordinator.resume(k),
    })
  })
  afterEach(() => {
    unregister()
    cleanup()
  })

  function setup() {
    // What the workspace does with a rename result: the queue follows the file to its new path.
    const handleApplyMutation = vi.fn((result: FsMutationResult) => {
      for (const { oldPath, newPath } of result.pathChanges) {
        if (!oldPath || !newPath) continue
        coordinator.remapKey(key(oldPath), key(newPath), (value) => ({ ...value, path: newPath }))
      }
      return true
    })
    return renderHook(() =>
      useDocumentMutations({
        vault: "/v",
        treeItems: TREE,
        setTreeItems: vi.fn(),
        refreshTree: vi.fn().mockResolvedValue(TREE),
        backendGeneration: generation,
        autosave: {} as never,
        autosaveKey: (id: string) => id as never,
        handleApplyMutation,
        handleContentChange: vi.fn(),
        handleContentDirty: vi.fn(),
        recoveryScope: {} as never,
        releaseUnusedDocumentBuffers: vi.fn(),
        handleSelect: vi.fn().mockResolvedValue(undefined),
      }),
    )
  }

  it("waits for the running write, and no write goes to the old path afterwards", async () => {
    renameItem.mockImplementation(async () => {
      events.push("rename")
      return renamed
    })
    coordinator.enqueueImmediate(key(OLD), { path: OLD, json: "1" })
    // A newer edit is queued behind the running write.
    coordinator.enqueueImmediate(key(OLD), { path: OLD, json: "2" })
    await act(async () => {
      await Promise.resolve()
    })
    const hook = setup()
    let outcome: Promise<unknown> | undefined
    await act(async () => {
      outcome = hook.result.current.handleRenameFile(OLD, "Новая")
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    // The rename has not started while the write to the old path is running.
    expect(events).toEqual([`write-start:${OLD}:1`])
    await act(async () => {
      releaseFirstWrite()
      await outcome
      await coordinator.flush(key(NEW))
    })
    const renameAt = events.indexOf("rename")
    expect(renameAt).toBeGreaterThan(events.indexOf(`write-end:${OLD}:1`))
    // Nothing is written to the old path after the rename; the newest text lands on the new one.
    expect(events.slice(renameAt).some((event) => event.startsWith(`write-start:${OLD}`))).toBe(
      false,
    )
    expect(events).toContain(`write-end:${NEW}:2`)
    expect(coordinator.inspect(key(NEW))?.dirty).toBe(false)
  })

  it("resumes the queue under the old path when the rename fails, keeping the edit", async () => {
    renameItem.mockRejectedValue(new Error("boom"))
    coordinator.enqueueImmediate(key(OLD), { path: OLD, json: "1" })
    await act(async () => {
      await Promise.resolve()
    })
    const hook = setup()
    await act(async () => {
      const outcome = hook.result.current.handleRenameFile(OLD, "Новая")
      releaseFirstWrite()
      expect((await outcome).status).toBe("failed")
    })
    coordinator.enqueueImmediate(key(OLD), { path: OLD, json: "3" })
    await act(async () => {
      await coordinator.flush(key(OLD))
    })
    expect(events).toContain(`write-end:${OLD}:3`)
    expect(coordinator.inspect(key(OLD))?.paused).toBe(false)
  })
})
