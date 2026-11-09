// @vitest-environment happy-dom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { useDatabaseController } from "./use-database-controller"
import { useDatabaseStore } from "./database-store"

const state = vi.hoisted(() => ({
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
  listDatabases: vi.fn(),
  rebuild: vi.fn(),
}))
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async (name: string, handler: (event: { payload: unknown }) => void) => {
    state.listeners.set(name, handler)
    return () => {
      state.listeners.delete(name)
    }
  }),
}))
vi.mock("@/lib/storage", async (original) => ({
  ...(await original<typeof import("@/lib/storage")>()),
  isTauri: () => true,
  getDatabaseModuleState: vi.fn(async () => ({
    enabled: true,
    vaultGeneration: 7,
    projection: null,
  })),
  listDatabases: state.listDatabases,
  rebuildDatabaseProjection: state.rebuild,
  refreshDatabaseChange: vi.fn(),
}))

beforeEach(() => {
  state.listeners.clear()
  state.listDatabases.mockReset().mockResolvedValue([])
  state.rebuild.mockReset()
  useDatabaseStore.getState().reset(null)
})
afterEach(cleanup)

it("refreshes open database hosts after a local write from another window", async () => {
  renderHook(() => useDatabaseController({ enabled: true, vaultGeneration: 7 }))
  await waitFor(() => expect(state.listeners.has("amby:database-written")).toBe(true))
  const before = useDatabaseStore.getState().invalidationSeq
  act(() => state.listeners.get("amby:database-written")!({ payload: { generation: 6 } }))
  act(() => state.listeners.get("amby:database-written")!({ payload: { generation: 7 } }))
  await waitFor(() => expect(useDatabaseStore.getState().invalidationSeq).toBe(before + 1))
  expect(state.listDatabases).toHaveBeenCalledTimes(2)
  expect(state.rebuild).not.toHaveBeenCalled()
})

it("refreshes again when a sync batch keeps writing while a rebuild is running", async () => {
  let finishFirst: (value: unknown) => void = () => {}
  const runtime = { enabled: true, vaultGeneration: 7, projection: null }
  state.rebuild
    .mockImplementationOnce(() => new Promise((resolve) => (finishFirst = resolve)))
    .mockResolvedValue(runtime)
  renderHook(() => useDatabaseController({ enabled: true, vaultGeneration: 7 }))
  await waitFor(() => expect(state.listeners.has("database:changed")).toBe(true))
  const change = (path: string) => ({
    payload: { generation: 7, kind: "manifest", path, requiresFullRebuild: true },
  })
  act(() => state.listeners.get("database:changed")!(change("a/Database.md")))
  await waitFor(() => expect(state.rebuild).toHaveBeenCalledTimes(1))
  // The batch is still writing: this event arrives while the first rebuild runs.
  act(() => state.listeners.get("database:changed")!(change("b/Database.md")))
  await new Promise((resolve) => setTimeout(resolve, 250))
  expect(state.rebuild).toHaveBeenCalledTimes(1)
  await act(async () => finishFirst(runtime))
  await waitFor(() => expect(state.rebuild).toHaveBeenCalledTimes(2))
})
