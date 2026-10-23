// @vitest-environment happy-dom
// After a note comes back from the archive the sidebar tree must be rebuilt at once, not with the next file event.
import { describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"

import { useRefreshTreeOnArchiveChange } from "./use-archive-tree-refresh"

describe("useRefreshTreeOnArchiveChange", () => {
  it("rebuilds the tree through refreshTree when the archive changes", () => {
    const refreshTree = vi.fn()
    renderHook(() => useRefreshTreeOnArchiveChange(refreshTree))
    window.dispatchEvent(new Event("amby:archive-changed"))
    expect(refreshTree).toHaveBeenCalledTimes(1)
  })

  it("stops listening when it is unmounted", () => {
    const refreshTree = vi.fn()
    const { unmount } = renderHook(() => useRefreshTreeOnArchiveChange(refreshTree))
    unmount()
    window.dispatchEvent(new Event("amby:archive-changed"))
    expect(refreshTree).not.toHaveBeenCalled()
  })
})
