// @vitest-environment happy-dom

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SidebarTree } from "./sidebar-tree"
import { useViewStateStore } from "../use-view-state-store"

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 29,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 29 })),
    measureElement: () => {},
    scrollToIndex: () => {},
  }),
}))

afterEach(() => {
  cleanup()
  useViewStateStore.setState({ closedTreeIds: new Set() })
})

const item = { id: "note-1", path: "/vault/Note.md", name: "Note", type: "file" as const }
const TAKEN = "Такое название уже занято. Введите другое."

async function renameTo(onRename: (id: string, name: string) => unknown, name: string) {
  const view = render(
    <SidebarTree
      items={[item]}
      selectedId={item.id}
      triggerRenameId={item.id}
      onSelect={() => {}}
      onRename={onRename as never}
    />,
  )
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
  const input = view.container.querySelector("input") as HTMLInputElement
  fireEvent.change(input, { target: { value: name } })
  await act(async () => {
    fireEvent.keyDown(input, { key: "Enter" })
  })
  return view
}

describe("a refused rename in the tree (docs/notices.md, section 8)", () => {
  it("opens the field again with the typed name and says why under it", async () => {
    const onRename = vi.fn().mockResolvedValue({ status: "failed", text: TAKEN })
    const { container } = await renameTo(onRename, "Taken")
    expect(onRename).toHaveBeenCalledWith("note-1", "Taken")
    const input = container.querySelector("input") as HTMLInputElement
    expect(input).not.toBeNull()
    expect(input.value).toBe("Taken")
    expect(screen.getByTestId("rename-hint").textContent).toContain(TAKEN)
    expect(input.getAttribute("aria-invalid")).toBe("true")
  })

  it("takes the line away when the person changes the name", async () => {
    const onRename = vi.fn().mockResolvedValue({ status: "failed", text: TAKEN })
    const { container } = await renameTo(onRename, "Taken")
    fireEvent.change(container.querySelector("input") as HTMLInputElement, {
      target: { value: "Taken 2" },
    })
    expect(screen.queryByTestId("rename-hint")).toBeNull()
  })

  it("takes the line away and closes the field on Escape", async () => {
    const onRename = vi.fn().mockResolvedValue({ status: "failed", text: TAKEN })
    const { container } = await renameTo(onRename, "Taken")
    fireEvent.keyDown(container.querySelector("input") as HTMLInputElement, { key: "Escape" })
    expect(container.querySelector("input")).toBeNull()
    expect(screen.queryByTestId("rename-hint")).toBeNull()
  })

  it("closes the field and shows nothing when the rename worked", async () => {
    const onRename = vi.fn().mockResolvedValue({ status: "renamed" })
    const { container } = await renameTo(onRename, "Fine")
    expect(container.querySelector("input")).toBeNull()
    expect(screen.queryByTestId("rename-hint")).toBeNull()
  })
})
