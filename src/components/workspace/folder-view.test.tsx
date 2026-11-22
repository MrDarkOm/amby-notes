// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest"
import { cleanup, render, screen } from "@testing-library/react"
import "@/lib/i18n"
import { FolderView } from "./folder-view"
import type { TreeItem } from "./sidebar-tree"

afterEach(cleanup)

describe("folder view cards", () => {
  it("says what each item is: a note, a database, a sketch or a canvas", () => {
    const folder = {
      id: "f",
      path: "/v/f",
      name: "f",
      type: "folder",
      children: [
        { id: "n", path: "/v/f/Tasks.md", name: "Tasks.md", type: "file" },
        { id: "d", path: "/v/f/Buy", name: "Buy", type: "database" },
        { id: "s", path: "/v/f/Draw.excalidraw", name: "Draw", type: "sketch" },
        { id: "c", path: "/v/f/Board.canvas", name: "Board", type: "canvas" },
      ],
    } as TreeItem
    render(
      <FolderView
        folder={folder}
        onOpenItem={() => {}}
        onNewNote={() => {}}
        onNewFolder={() => {}}
        onIconChange={() => {}}
      />,
    )
    const kind = (name: string) =>
      screen.getByText(name).parentElement?.querySelector("span:last-child")?.textContent
    expect(kind("Tasks")).toBe("Заметка")
    expect(kind("Buy")).toBe("База данных")
    expect(kind("Draw")).toBe("Набросок")
    expect(kind("Board")).toBe("Canvas")
  })
})
