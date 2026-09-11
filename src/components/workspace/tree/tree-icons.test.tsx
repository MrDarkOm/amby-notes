// @vitest-environment happy-dom

import { fireEvent, render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { TreeItemIcon, TreeItemStatusIcon } from "./tree-icons"
import type { TreeItem } from "./tree-types"

const folder: TreeItem = {
  id: "folder",
  name: "Folder",
  path: "Folder",
  type: "folder",
  icon: "🌐",
}

const note: TreeItem = {
  id: "note",
  name: "Note",
  path: "Note.md",
  type: "file",
  icon: "😀",
}

describe("TreeItemIcon", () => {
  it("keeps a custom folder icon without adding a folder glyph", () => {
    const { container } = render(<TreeItemIcon item={folder} />)

    expect(container.textContent).toBe("🌐")
    expect(container.querySelector("svg")).toBeNull()
  })

  it("does not add a folder glyph to custom note icons", () => {
    const { container } = render(<TreeItemIcon item={note} />)

    expect(container.textContent).toBe("😀")
    expect(container.querySelector("svg")).toBeNull()
  })

  it("renders a file icon with a star for a favorite note", () => {
    const { container } = render(<TreeItemStatusIcon item={note} isFavorite />)

    expect(container.querySelector('[data-tree-file-status="favorite"]')).not.toBeNull()
    expect(container.querySelectorAll("svg")).toHaveLength(2)
  })

  it("activates the favorite control without selecting the tree item", () => {
    const onActivate = vi.fn()
    const { container } = render(
      <TreeItemStatusIcon
        item={note}
        isFavorite={false}
        onActivate={onActivate}
        label="Add to favorites"
      />,
    )
    const control = container.querySelector('[role="button"]') as HTMLElement

    fireEvent.click(control)
    fireEvent.keyDown(control, { key: "Enter" })

    expect(onActivate).toHaveBeenCalledTimes(2)
    expect(control.getAttribute("aria-label")).toBe("Add to favorites")
  })
})
