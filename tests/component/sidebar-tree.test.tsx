// @vitest-environment happy-dom
import * as React from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import i18n from "@/lib/i18n"
import { SidebarTree, type TreeItem } from "@/components/workspace/sidebar-tree"
import { useViewStateStore } from "@/components/workspace/use-view-state-store"

// Layout measurements are unavailable in happy-dom; render all visible rows.
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 29,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 29 })),
    measureElement: () => {},
    scrollToIndex: () => {},
  }),
}))
vi.mock("@/components/workspace/tiptap/EmojiPickerPanel", () => ({
  EmojiPickerPanel: () => null,
}))

const items: TreeItem[] = [
  {
    id: "folder:/vault/projects",
    path: "/vault/projects",
    name: "Projects",
    type: "folder",
    children: [
      {
        id: "parent-note",
        path: "/vault/projects/Parent/Parent.md",
        name: "Parent",
        type: "file",
        children: [
          { id: "child", path: "/vault/projects/Parent/Child.md", name: "Child", type: "file" },
        ],
      },
    ],
  },
  { id: "leaf", path: "/vault/Leaf.md", name: "Leaf", type: "file" },
]

beforeEach(() => {
  useViewStateStore.setState({ closedTreeIds: new Set() })
})
afterEach(cleanup)

describe("sidebar tree interactions", () => {
  it.each(["Leaf", "Parent", "Projects"])(
    "creates a note inside the context-menu target %s",
    (name) => {
      const onNewFile = vi.fn()
      render(
        <SidebarTree items={items} selectedId={null} onSelect={vi.fn()} onNewFile={onNewFile} />,
      )
      fireEvent.contextMenu(screen.getByRole("treeitem", { name }), { button: 2 })
      fireEvent.click(screen.getByRole("menuitem", { name: i18n.t("tree.newNote") }))
      expect(onNewFile).toHaveBeenCalledWith(
        { Leaf: "leaf", Parent: "parent-note", Projects: "folder:/vault/projects" }[name],
      )
    },
  )

  it("keeps nested branches collapsed across tree unmounts and item refreshes", () => {
    const props = { items, selectedId: null, onSelect: vi.fn() }
    const first = render(<SidebarTree {...props} />)
    fireEvent.click(screen.getAllByTitle(i18n.t("tree.collapse"))[1])
    expect(screen.queryByRole("treeitem", { name: "Child" })).toBeNull()
    first.unmount()

    const second = render(<SidebarTree {...props} />)
    expect(screen.getByRole("treeitem", { name: "Projects" }).getAttribute("aria-expanded")).toBe(
      "true",
    )
    expect(screen.getByRole("treeitem", { name: "Parent" }).getAttribute("aria-expanded")).toBe(
      "false",
    )
    second.rerender(<SidebarTree {...props} items={structuredClone(items)} />)
    expect(screen.queryByRole("treeitem", { name: "Child" })).toBeNull()

    fireEvent.click(screen.getByTitle(i18n.t("tree.collapse")))
    second.unmount()
    render(<SidebarTree {...props} />)
    expect(screen.queryByRole("treeitem", { name: "Parent" })).toBeNull()
    fireEvent.click(screen.getByTitle(i18n.t("tree.expand")))
    expect(screen.queryByRole("treeitem", { name: "Child" })).toBeNull()
  })

  it("selects a collapsed folder without expanding it, while its arrow only expands", () => {
    useViewStateStore.getState().toggleTreeItem(items[0].id)
    const onSelect = vi.fn()
    render(<SidebarTree items={items} selectedId={null} onSelect={onSelect} />)
    fireEvent.click(screen.getByRole("treeitem", { name: "Projects" }))
    expect(onSelect).toHaveBeenCalledWith(items[0].id)
    expect(screen.queryByRole("treeitem", { name: "Parent" })).toBeNull()
    onSelect.mockClear()
    fireEvent.click(screen.getByTitle(i18n.t("tree.expand")))
    expect(onSelect).not.toHaveBeenCalled()
    expect(screen.getByRole("treeitem", { name: "Parent" })).toBeTruthy()
  })

  it("preserves expand/collapse-all state after remounting", () => {
    const props = { items, selectedId: null, onSelect: vi.fn() }
    const tree = render(<SidebarTree {...props} />)
    act(() => useViewStateStore.getState().setTreeExpanded(items, false))
    tree.unmount()
    render(<SidebarTree {...props} />)
    expect(screen.getAllByRole("treeitem")).toHaveLength(2)
    act(() => useViewStateStore.getState().setTreeExpanded(items, true))
    expect(screen.getAllByRole("treeitem")).toHaveLength(4)
  })
})
