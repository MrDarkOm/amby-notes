// @vitest-environment happy-dom
// After a note comes back from the archive the sidebar tree must follow at once, not with the next
// file event, and without reloading the whole vault when the change names its files.
import { describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"

import { dispatchArchiveChanged, useRefreshTreeOnArchiveChange } from "./use-archive-tree-refresh"

describe("useRefreshTreeOnArchiveChange", () => {
  it("reloads the tree when the archive changes without saying what changed", () => {
    const refreshTree = vi.fn()
    const refreshTreePaths = vi.fn()
    renderHook(() => useRefreshTreeOnArchiveChange(refreshTree, refreshTreePaths))
    window.dispatchEvent(new Event("amby:archive-changed"))
    expect(refreshTree).toHaveBeenCalledTimes(1)
    expect(refreshTreePaths).not.toHaveBeenCalled()
  })

  it("refreshes only the named files", () => {
    const refreshTree = vi.fn()
    const refreshTreePaths = vi.fn()
    renderHook(() => useRefreshTreeOnArchiveChange(refreshTree, refreshTreePaths))
    dispatchArchiveChanged({ paths: ["/vault/Back.md"] })
    expect(refreshTreePaths).toHaveBeenCalledWith(["/vault/Back.md"])
    expect(refreshTree).not.toHaveBeenCalled()
  })

  it("does nothing when the caller already put the change into the tree", () => {
    const refreshTree = vi.fn()
    const refreshTreePaths = vi.fn()
    renderHook(() => useRefreshTreeOnArchiveChange(refreshTree, refreshTreePaths))
    dispatchArchiveChanged({ paths: ["/vault/Gone.md"], treeUpdated: true })
    expect(refreshTree).not.toHaveBeenCalled()
    expect(refreshTreePaths).not.toHaveBeenCalled()
  })

  it("stops listening when it is unmounted", () => {
    const refreshTree = vi.fn()
    const { unmount } = renderHook(() => useRefreshTreeOnArchiveChange(refreshTree, vi.fn()))
    unmount()
    window.dispatchEvent(new Event("amby:archive-changed"))
    expect(refreshTree).not.toHaveBeenCalled()
  })
})
