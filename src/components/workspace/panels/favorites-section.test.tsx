// @vitest-environment happy-dom

import { fireEvent, render } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"

import type { TreeItem } from "@/lib/storage"
import { collectFavoriteItems } from "./favorites-items"
import { FavoritesSection } from "./favorites-section"

const note: TreeItem = { id: "n1", name: "Starred note", path: "Starred note.md", type: "file" }
const folder: TreeItem = {
  id: "f1",
  name: "Folder",
  path: "Folder",
  type: "folder",
  children: [note],
}

describe("FavoritesSection", () => {
  beforeEach(() => localStorage.clear())

  it("collects bookmarked notes at any depth and skips folders", () => {
    expect(collectFavoriteItems([folder], new Set(["n1", "f1"])).map((i) => i.id)).toEqual(["n1"])
    expect(collectFavoriteItems([folder], undefined)).toEqual([])
  })

  it("renders nothing without bookmarks", () => {
    const { container } = render(<FavoritesSection items={[]} onSelect={() => {}} />)
    expect(container.firstChild).toBeNull()
  })

  it("opens a note, removes a bookmark and remembers the fold", () => {
    const onSelect = vi.fn()
    const onToggleFavorite = vi.fn()
    const { container, getByText } = render(
      <FavoritesSection items={[note]} onSelect={onSelect} onToggleFavorite={onToggleFavorite} />,
    )
    fireEvent.click(getByText("Starred note"))
    expect(onSelect).toHaveBeenCalledWith("n1")

    fireEvent.click(
      container.querySelector('[data-tree-file-status="favorite"]')!.closest("button")!,
    )
    expect(onToggleFavorite).toHaveBeenCalledWith("n1")
    expect(onSelect).toHaveBeenCalledTimes(1)

    fireEvent.click(container.querySelector("button[aria-expanded]")!)
    expect(container.textContent).not.toContain("Starred note")
    expect(localStorage.getItem("amby:favorites-section-open")).toBe("false")
  })
})
