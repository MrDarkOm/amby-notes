// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { useDatabaseStore } from "../database/database-store"
import { catalog, project } from "./project-fixtures.test-support"
import { useProjectStore } from "./project-store"
import { useProjectController } from "./use-project-controller"

const storage = vi.hoisted(() => ({
  listProjects: vi.fn(),
  refreshProjects: vi.fn(),
  isTauri: vi.fn(),
}))
const events = vi.hoisted(() => ({
  handler: null as null | ((event: { payload: unknown }) => void),
}))
vi.mock("@/lib/storage", () => storage)
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (_name: string, handler: (event: { payload: unknown }) => void) => {
    events.handler = handler
    return () => {
      events.handler = null
    }
  }),
}))

const flush = () => act(async () => {})

describe("useProjectController", () => {
  beforeEach(() => {
    vi.useFakeTimers()
    storage.listProjects.mockReset().mockResolvedValue(catalog([project("a")]))
    storage.refreshProjects.mockReset().mockResolvedValue(catalog([project("a"), project("b")]))
    storage.isTauri.mockReset().mockReturnValue(true)
    events.handler = null
    useProjectStore.getState().reset()
    useDatabaseStore.getState().reset(1)
  })
  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it("is disabled while the module is off and reads nothing", async () => {
    renderHook(() => useProjectController({ enabled: false, vaultGeneration: 1 }))
    await flush()
    expect(useProjectStore.getState().status).toBe("disabled")
    expect(storage.listProjects).not.toHaveBeenCalled()
  })

  it("waits for the database catalog, because sections resolve through it", async () => {
    renderHook(() => useProjectController({ enabled: true, vaultGeneration: 1 }))
    await flush()
    expect(storage.listProjects).not.toHaveBeenCalled()
    act(() => useDatabaseStore.getState().setCatalog([]))
    await flush()
    expect(storage.listProjects).toHaveBeenCalledTimes(1)
    expect(useProjectStore.getState().catalog?.workshops).toHaveLength(1)
    expect(useProjectStore.getState().status).toBe("ready")
  })

  it("re-reads the catalog when the databases change", async () => {
    act(() => useDatabaseStore.getState().setCatalog([]))
    renderHook(() => useProjectController({ enabled: true, vaultGeneration: 1 }))
    await flush()
    act(() => useDatabaseStore.getState().setCatalog([]))
    await flush()
    expect(storage.listProjects).toHaveBeenCalledTimes(2)
  })

  it("rebuilds from the files once after a burst of project:changed events", async () => {
    act(() => useDatabaseStore.getState().setCatalog([]))
    renderHook(() => useProjectController({ enabled: true, vaultGeneration: 1 }))
    await flush()
    expect(events.handler).not.toBeNull()
    for (const path of ["A/amby-workshop.json", "A", "B"]) {
      events.handler!({ payload: { kind: "file", path, generation: 1 } })
    }
    expect(storage.refreshProjects).not.toHaveBeenCalled()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(storage.refreshProjects).toHaveBeenCalledTimes(1)
    expect(storage.refreshProjects).toHaveBeenCalledWith(1)
    // Two markers and no folder named by the setting: the store keeps both, and none is active
    // until the default folder or the setting picks one.
    expect(useProjectStore.getState().rawCatalog?.workshops).toHaveLength(2)
    expect(useProjectStore.getState().catalog?.workshops).toHaveLength(0)
    expect(useProjectStore.getState().catalog?.diagnostics.map((entry) => entry.code)).toEqual([
      "otherWorkshop",
      "otherWorkshop",
    ])
  })

  it("ignores events of another vault generation", async () => {
    act(() => useDatabaseStore.getState().setCatalog([]))
    renderHook(() => useProjectController({ enabled: true, vaultGeneration: 1 }))
    await flush()
    events.handler!({ payload: { kind: "file", path: "x", generation: 9 } })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500)
    })
    expect(storage.refreshProjects).not.toHaveBeenCalled()
  })

  it("keeps the catalog on screen when a refresh fails, and reports the error", async () => {
    act(() => useDatabaseStore.getState().setCatalog([]))
    renderHook(() => useProjectController({ enabled: true, vaultGeneration: 1 }))
    await flush()
    storage.refreshProjects.mockRejectedValueOnce(new Error("index busy"))
    await act(async () => {
      await useProjectStore.getState().refresh?.(true)
    })
    expect(useProjectStore.getState().error).toBe("index busy")
    expect(useProjectStore.getState().catalog?.workshops).toHaveLength(1)
  })

  it("unsubscribes when disabled", async () => {
    act(() => useDatabaseStore.getState().setCatalog([]))
    const { rerender } = renderHook(
      ({ enabled }) => useProjectController({ enabled, vaultGeneration: 1 }),
      { initialProps: { enabled: true } },
    )
    await flush()
    expect(events.handler).not.toBeNull()
    rerender({ enabled: false })
    await flush()
    expect(events.handler).toBeNull()
  })
})
