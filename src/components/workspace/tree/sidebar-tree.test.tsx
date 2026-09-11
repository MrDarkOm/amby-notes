// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SidebarTree } from "./sidebar-tree"
import { useViewStateStore } from "../use-view-state-store"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"

const mockedVirtualizer = vi.hoisted(() => {
  const state = { count: 0 }
  const virtualizer = {
    getTotalSize: () => state.count * 29,
    getVirtualItems: () =>
      Array.from({ length: state.count }, (_, index) => ({
        key: index,
        index,
        start: index * 29,
      })),
    measureElement: () => {},
    scrollToIndex: () => {},
  }
  return { state, virtualizer }
})

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => {
    mockedVirtualizer.state.count = count
    return mockedVirtualizer.virtualizer
  },
}))

afterEach(() => {
  cleanup()
  useViewStateStore.setState({ closedTreeIds: new Set() })
})

describe("SidebarTree rename trigger", () => {
  it.each([
    ["note", { id: "note-1", path: "/vault/Note.md", name: "Note", type: "file" as const }],
    [
      "folder",
      {
        id: "folder-1",
        path: "/vault/Folder",
        name: "Folder",
        type: "folder" as const,
        children: [],
      },
    ],
  ])("starts renaming a %s on double click", async (_, item) => {
    const onRename = vi.fn()
    const { container } = render(
      <SidebarTree items={[item]} selectedId={item.id} onSelect={() => {}} onRename={onRename} />,
    )

    fireEvent.doubleClick(
      container.querySelector(`[data-tree-item-id="${item.id}"]`) as HTMLElement,
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const input = container.querySelector("input") as HTMLInputElement
    expect(input).not.toBeNull()
    expect(document.activeElement).toBe(input)
    expect(input.className).toContain("p-0")
    expect(input.className).not.toContain("px-1")
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(item.name.length)

    fireEvent.change(input, { target: { value: `${item.name} renamed` } })
    fireEvent.keyDown(input, { key: "Enter" })
    expect(onRename).toHaveBeenCalledWith(item.id, `${item.name} renamed`)
  })

  it("keeps root and leaf icons on the compact tree grid", () => {
    const child = {
      id: "child",
      path: "/vault/Bundle/Child.md",
      name: "Child",
      type: "file" as const,
    }
    const bundle = {
      id: "bundle",
      path: "/vault/Bundle/Bundle.md",
      name: "Bundle",
      type: "file" as const,
      children: [child],
    }
    const leaf = {
      id: "leaf",
      path: "/vault/Leaf.md",
      name: "Leaf",
      type: "file" as const,
    }
    const { container } = render(
      <SidebarTree items={[bundle, leaf]} selectedId={null} onSelect={() => {}} />,
    )

    const expandableRow = container.querySelector('[data-tree-item-id="bundle"]')?.parentElement
    const leafRow = container.querySelector('[data-tree-item-id="leaf"]') as HTMLElement
    expect(expandableRow?.style.paddingLeft).toBe("14px")
    expect(leafRow.style.paddingLeft).toBe("14px")
  })

  it("keeps nested rows on the icon grid without reserving a hidden chevron", () => {
    const child = {
      id: "child",
      path: "/vault/Folder/Child.md",
      name: "Child",
      type: "file" as const,
    }
    const folder = {
      id: "folder",
      path: "/vault/Folder",
      name: "Folder",
      type: "folder" as const,
      children: [child],
    }
    const { container } = render(
      <SidebarTree items={[folder]} selectedId={null} onSelect={() => {}} />,
    )

    const childRow = container.querySelector('[data-tree-item-id="child"]') as HTMLElement
    expect(childRow.style.paddingLeft).toBe("36px")
  })

  it("shows type icons on the right and a file icon with a star for favorites", () => {
    const items = [
      { id: "note-1", path: "/vault/one.md", name: "one", type: "file" as const },
      { id: "note-2", path: "/vault/two.md", name: "two", type: "file" as const },
      { id: "folder-1", path: "/vault/Folder", name: "Folder", type: "folder" as const },
    ]
    const { container } = render(
      <SidebarTree
        items={items}
        selectedId={null}
        onSelect={() => {}}
        favorites={new Set(["note-2"])}
      />,
    )

    expect(container.querySelector('[data-tree-file-status="file"]')).not.toBeNull()
    expect(container.querySelector('[data-tree-file-status="favorite"]')).not.toBeNull()
    expect(container.querySelector('[data-tree-file-status="folder"]')).not.toBeNull()
  })

  it("keeps ordinary file icons visible without a folder hover affordance", () => {
    const item = { id: "note-1", path: "/vault/one.md", name: "one", type: "file" as const }
    const { container } = render(
      <SidebarTree items={[item]} selectedId={null} onSelect={() => {}} />,
    )

    expect(
      container.querySelector('[data-tree-item-id="note-1"] .amby-tree-main-icon'),
    ).not.toBeNull()
    expect(
      container.querySelector('[data-tree-item-id="note-1"] .amby-tree-folder-icon'),
    ).toBeNull()
  })

  it("toggles a file favorite from its right-side status icon", () => {
    const onSelect = vi.fn()
    const onToggleFavorite = vi.fn()
    const item = { id: "note-1", path: "/vault/one.md", name: "one", type: "file" as const }
    const { container } = render(
      <SidebarTree
        items={[item]}
        selectedId={null}
        onSelect={onSelect}
        favorites={new Set()}
        onToggleFavorite={onToggleFavorite}
      />,
    )

    fireEvent.click(container.querySelector('[data-tree-file-status="file"]') as HTMLElement)

    expect(onToggleFavorite).toHaveBeenCalledWith(item.id)
    expect(onSelect).not.toHaveBeenCalled()
  })

  it("opens the new item's name input and selects the tree item", async () => {
    const item = {
      id: "note-1",
      path: "/vault/Без названия.md",
      name: "Без названия",
      type: "file" as const,
      icon: "file",
    }

    const { container } = render(
      <SidebarTree
        items={[item]}
        selectedId={item.id}
        triggerRenameId={item.id}
        onSelect={() => {}}
      />,
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const input = container.querySelector("input")
    expect(input).not.toBeNull()
    expect((input as HTMLInputElement).value).toBe(item.name)
    expect(document.activeElement).toBe(input)
    expect((input as HTMLInputElement).selectionStart).toBe(0)
    expect((input as HTMLInputElement).selectionEnd).toBe(item.name.length)
    expect(container.querySelector(`[data-tree-selected="true"]`)).not.toBeNull()
  })

  it("resolves a path trigger when the backend has not returned the note id yet", async () => {
    const item = {
      id: "note-1",
      path: "/vault/Без названия.md",
      name: "Без названия",
      type: "file" as const,
      icon: "file",
    }

    const { container } = render(
      <SidebarTree
        items={[item]}
        selectedId={null}
        triggerRenameId={item.path}
        onSelect={() => {}}
      />,
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    expect(container.querySelector("input")).not.toBeNull()
    expect(container.querySelector(`[data-tree-selected="true"]`)).not.toBeNull()
  })

  it("waits for a path-triggered item to appear after a delayed tree refresh", async () => {
    const item = {
      id: "note-1",
      path: "/vault/Без названия.md",
      name: "Без названия",
      type: "file" as const,
      icon: "file",
    }

    const view = render(
      <SidebarTree items={[]} selectedId={null} triggerRenameId={item.path} onSelect={() => {}} />,
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(view.container.querySelector("input")).toBeNull()

    view.rerender(
      <SidebarTree
        items={[item]}
        selectedId={null}
        triggerRenameId={item.path}
        onSelect={() => {}}
      />,
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(view.container.querySelector("input")).not.toBeNull()
  })

  it("focuses rename for a note created inside another note", async () => {
    const child = {
      id: "child-note",
      path: "/vault/Parent/Child.md",
      name: "Child",
      type: "file" as const,
      icon: "file",
    }
    const parent = {
      id: "parent-note",
      path: "/vault/Parent/Parent.md",
      name: "Parent",
      type: "file" as const,
      icon: "file",
      children: [child],
    }
    const { container } = render(
      <SidebarTree
        items={[parent]}
        selectedId={parent.id}
        triggerRenameId={child.id}
        onSelect={() => {}}
      />,
    )
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    const input = container.querySelector("input")
    expect(input).not.toBeNull()
    expect(document.activeElement).toBe(input)
    expect((input as HTMLInputElement).selectionStart).toBe(0)
    expect((input as HTMLInputElement).selectionEnd).toBe(child.name.length)
  })

  it("starts context-menu creation after the menu has closed", async () => {
    const item = {
      id: "note-1",
      path: "/vault/Parent.md",
      name: "Parent",
      type: "file" as const,
      icon: "file",
    }
    const onNewFile = vi.fn()
    const { container } = render(
      <SidebarTree items={[item]} selectedId={item.id} onSelect={() => {}} onNewFile={onNewFile} />,
    )
    const row = container.querySelector('[data-tree-item-id="note-1"]')
    expect(row).not.toBeNull()

    fireEvent.contextMenu(row as HTMLElement)
    const createItem = await screen.findByText("Новая заметка")
    fireEvent.click(createItem)

    expect(onNewFile).not.toHaveBeenCalled()
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 100))
    })
    expect(onNewFile).toHaveBeenCalledWith(item.id)
  })

  it("uses a star icon for the favorites action in the context menu", async () => {
    const item = {
      id: "note-1",
      path: "/vault/Note.md",
      name: "Note",
      type: "file" as const,
    }
    const { container } = render(
      <SidebarTree
        items={[item]}
        selectedId={item.id}
        onSelect={() => {}}
        favorites={new Set([item.id])}
        onToggleFavorite={() => {}}
      />,
    )

    fireEvent.contextMenu(container.querySelector('[data-tree-item-id="note-1"]') as HTMLElement)
    const favoriteAction = await screen.findByText("Убрать из избранного")
    const menuItem = favoriteAction.closest('[data-slot="context-menu-item"]')
    const star = menuItem?.querySelector(".lucide-star")

    expect(star).not.toBeNull()
    expect(star?.classList.contains("text-primary")).toBe(true)
    expect(star?.classList.contains("fill-current")).toBe(true)
    expect(menuItem?.querySelector(".lucide-bookmark")).toBeNull()
  })

  it("shows bulk actions for a multi-selection and deletes all selected items", async () => {
    const items = [
      { id: "note-1", path: "/vault/one.md", name: "one", type: "file" as const },
      { id: "note-2", path: "/vault/two.md", name: "two", type: "file" as const },
    ]
    const onDeleteMany = vi.fn()
    const { container } = render(
      <SidebarTree
        items={items}
        selectedId={items[0].id}
        onSelect={() => {}}
        onDeleteMany={onDeleteMany}
      />,
    )

    fireEvent.click(container.querySelector('[data-tree-item-id="note-2"]') as HTMLElement, {
      ctrlKey: true,
    })
    fireEvent.contextMenu(container.querySelector('[data-tree-item-id="note-1"]') as HTMLElement)

    expect(await screen.findByText("Выбрано: 2")).toBeTruthy()
    fireEvent.click(await screen.findByText("Удалить выбранные (2)"))

    expect(onDeleteMany).toHaveBeenCalledWith(["note-1", "note-2"])
  })

  it.each([
    ["note", { id: "note-1", path: "/vault/Parent.md", name: "Parent", type: "file" as const }],
    [
      "folder",
      {
        id: "folder-1",
        path: "/vault/Projects",
        name: "Projects",
        type: "folder" as const,
        children: [],
      },
    ],
  ])(
    "keeps a tree item's %s context menu working inside the panel context menu",
    async (_, item) => {
      const onNewFile = vi.fn()
      const { container } = render(
        <ContextMenu>
          <ContextMenuTrigger asChild>
            <div>
              <SidebarTree
                items={[item]}
                selectedId={item.id}
                onSelect={() => {}}
                onNewFile={onNewFile}
              />
            </div>
          </ContextMenuTrigger>
          <ContextMenuContent>
            <ContextMenuItem>Root action</ContextMenuItem>
          </ContextMenuContent>
        </ContextMenu>,
      )

      fireEvent.contextMenu(
        container.querySelector(`[data-tree-item-id="${item.id}"]`) as HTMLElement,
      )
      fireEvent.click(await screen.findByText("Новая заметка"))

      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100))
      })
      expect(onNewFile).toHaveBeenCalledWith(item.id)
      expect(screen.queryByText("Root action")).toBeNull()
    },
  )
})
