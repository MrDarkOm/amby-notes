// @vitest-environment happy-dom

import { fireEvent, render } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import type { TreeItem } from "@/lib/storage"
import { FavoritesPanel } from "./favorites-panel"

const favorite: TreeItem = {
  id: "favorite-note",
  name: "Favorite note",
  path: "Favorite note.md",
  type: "file",
  icon: "😀",
}

describe("FavoritesPanel", () => {
  it("shows custom note icons and a clickable file-with-star control", () => {
    const onToggleFavorite = vi.fn()
    const { container } = render(
      <FavoritesPanel
        treeItems={[favorite]}
        selectedId={null}
        vault="/vault"
        onSelect={() => {}}
        onOpenVault={() => {}}
        favorites={new Set([favorite.id])}
        onToggleFavorite={onToggleFavorite}
      />,
    )

    expect(container.textContent).toContain("😀")
    const statusIcon = container.querySelector('[data-tree-file-status="favorite"]')
    expect(statusIcon).not.toBeNull()
    expect(statusIcon?.querySelectorAll("svg")).toHaveLength(2)

    fireEvent.click(statusIcon?.closest("button") as HTMLButtonElement)
    expect(onToggleFavorite).toHaveBeenCalledWith(favorite.id)
  })
})
