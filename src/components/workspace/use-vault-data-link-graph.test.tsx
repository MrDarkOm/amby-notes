// @vitest-environment happy-dom
// SHELL-02: the link graph is read only while something shows it.
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import * as storage from "@/lib/storage"
import { useVaultData } from "./use-vault-data"
import { useVaultStore } from "./use-vault-store"
import { useBacklinkCount, useLinkGraph, useLinkGraphStore } from "./use-link-graph-store"
import type { TreeItem } from "./sidebar-tree"

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => {}),
}))
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    label: "main",
    onCloseRequested: async () => () => {},
    onFocusChanged: async () => () => {},
    destroy: vi.fn(async () => {}),
  }),
}))
vi.mock("@/lib/storage", async (original) => ({
  ...(await original<typeof import("@/lib/storage")>()),
  isTauri: () => true,
  getLinkGraph: vi.fn(),
  startVaultWatcher: vi.fn(async () => {}),
  stopVaultWatcher: vi.fn(async () => {}),
}))

const wait = (ms: number) => act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)))
const tree = (name: string): TreeItem[] => [
  { id: `/v/${name}.md`, name, type: "file", path: `/v/${name}.md` } as unknown as TreeItem,
]

beforeEach(() => {
  window.localStorage.clear()
  vi.mocked(storage.getLinkGraph)
    .mockReset()
    .mockResolvedValue({ nodes: [], edges: [] } as never)
  useVaultStore.setState({ ...useVaultStore.getInitialState(), vault: "/v" })
  useLinkGraphStore.setState(useLinkGraphStore.getInitialState())
})
afterEach(cleanup)

describe("link graph loading", () => {
  it("does not read the graph on a tree change while nothing shows it", async () => {
    const hook = renderHook(() => useVaultData())
    await wait(200)
    act(() => hook.result.current.setTreeItems(tree("a")))
    await wait(250)
    act(() => hook.result.current.setTreeItems(tree("b")))
    await wait(250)
    expect(storage.getLinkGraph).not.toHaveBeenCalled()
  })

  it("reads the graph once when a view starts showing it", async () => {
    const hook = renderHook(() => useVaultData())
    act(() => hook.result.current.setTreeItems(tree("a")))
    await wait(250)
    expect(storage.getLinkGraph).not.toHaveBeenCalled()
    const view = renderHook(() => useLinkGraph())
    await wait(250)
    expect(storage.getLinkGraph).toHaveBeenCalledTimes(1)
    // A second view over the same, fresh graph does not read it again.
    const second = renderHook(() => useLinkGraph())
    await wait(250)
    expect(storage.getLinkGraph).toHaveBeenCalledTimes(1)
    second.unmount()
    view.unmount()
  })

  it("reads the graph again after a tree change while a view shows it", async () => {
    const hook = renderHook(() => useVaultData())
    const view = renderHook(() => useLinkGraph())
    await wait(250)
    const before = vi.mocked(storage.getLinkGraph).mock.calls.length
    act(() => hook.result.current.setTreeItems(tree("c")))
    await wait(250)
    expect(vi.mocked(storage.getLinkGraph).mock.calls.length).toBe(before + 1)
    view.unmount()
  })

  it("reads a graph that went stale while no view was open when one opens", async () => {
    const hook = renderHook(() => useVaultData())
    const first = renderHook(() => useLinkGraph())
    await wait(250)
    first.unmount()
    const before = vi.mocked(storage.getLinkGraph).mock.calls.length
    act(() => hook.result.current.setTreeItems(tree("d")))
    await wait(250)
    expect(vi.mocked(storage.getLinkGraph).mock.calls.length).toBe(before)
    const again = renderHook(() => useLinkGraph())
    await wait(250)
    expect(vi.mocked(storage.getLinkGraph).mock.calls.length).toBe(before + 1)
    again.unmount()
  })

  it("does not re-render the workspace root when the graph arrives", async () => {
    let renders = 0
    renderHook(() => {
      renders += 1
      return useVaultData()
    })
    await wait(200)
    const settled = renders
    act(() =>
      useLinkGraphStore.getState().setGraph({
        nodes: [{ id: "a", label: "A" }],
        edges: [{ source: "b", target: "a", label: "" }],
      } as never),
    )
    await wait(50)
    expect(renders).toBe(settled)
  })

  it("counts backlinks of one note without a re-render for other changes", () => {
    const counts: number[] = []
    renderHook(() => {
      const count = useBacklinkCount("a")
      counts.push(count)
      return count
    })
    act(() =>
      useLinkGraphStore.getState().setGraph({
        nodes: [],
        edges: [{ source: "b", target: "a", label: "" }],
      } as never),
    )
    const rendersAfterFirst = counts.length
    act(() =>
      useLinkGraphStore.getState().setGraph({
        nodes: [],
        edges: [
          { source: "b", target: "a", label: "" },
          { source: "b", target: "z", label: "" },
        ],
      } as never),
    )
    expect(counts[counts.length - 1]).toBe(1)
    expect(counts.length).toBe(rendersAfterFirst)
  })
})
