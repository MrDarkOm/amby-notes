// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import { DocumentHeader, type DocumentHeaderProps } from "./document-header"
import type { TreeItem } from "../sidebar-tree"

const tree: TreeItem[] = [
  {
    id: "f1",
    path: "/v/Books",
    name: "Books",
    type: "folder",
    children: [{ id: "n1", path: "/v/Books/Note.md", name: "Note", type: "file" }],
  },
]

function props(over: Partial<DocumentHeaderProps> = {}): DocumentHeaderProps {
  return {
    hasDocument: true,
    docId: "n1",
    docTitle: "Note",
    docPath: "/v/Books/Note.md",
    treeItems: tree,
    onOpenItem: vi.fn(),
    onBack: vi.fn(),
    onForward: vi.fn(),
    canGoBack: true,
    canGoForward: false,
    viewMode: "live",
    onViewModeChange: vi.fn(),
    contentWidth: "normal",
    onContentWidthChange: vi.fn(),
    nestedNotes: [],
    nestedNotesPlacement: "top",
    onRequestAttachLayer: vi.fn(),
    onRequestMove: vi.fn(),
    onRequestMerge: vi.fn(),
    onCopyPath: vi.fn(),
    onExportPdf: vi.fn(),
    onRequestRename: vi.fn(),
    moreActionsOpen: true,
    onMoreActionsOpenChange: vi.fn(),
    onToggleFavorite: vi.fn(),
    onOpenInNewTab: vi.fn(),
    onSplitRight: vi.fn(),
    onSplitDown: vi.fn(),
    onShowInExplorer: vi.fn(),
    onDeleteFile: vi.fn(),
    ...over,
  }
}

beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const rows = () => screen.getAllByRole("menuitem").map((item) => item.textContent?.trim())

describe("the note's header, drawn by the shared bar", () => {
  it("shows the folders as links and the note as the page", () => {
    const onOpenItem = vi.fn()
    render(<DocumentHeader {...props({ moreActionsOpen: false, onOpenItem })} />)
    fireEvent.click(screen.getByRole("button", { name: "Books" }))
    expect(onOpenItem).toHaveBeenCalledWith("f1")
    expect(screen.queryByRole("button", { name: "Note" })).toBeNull()
    expect(screen.getByText("Note")).toBeTruthy()
  })

  it("steps back and forward as before: the buttons have no names of their own", () => {
    const onBack = vi.fn()
    const { container } = render(<DocumentHeader {...props({ moreActionsOpen: false, onBack })} />)
    const [back, forward] = Array.from(container.querySelectorAll("button")).slice(0, 2)
    fireEvent.click(back)
    expect(onBack).toHaveBeenCalledTimes(1)
    expect(back.hasAttribute("aria-label")).toBe(false)
    expect((forward as HTMLButtonElement).disabled).toBe(true)
  })

  it("renders nothing with the navigation hidden", () => {
    const { container } = render(<DocumentHeader {...props({ hideNavigation: true })} />)
    expect(container.firstChild).toBeNull()
  })

  it("keeps the menu of a note in its order, with a separator between the groups", () => {
    render(<DocumentHeader {...props()} />)
    expect(rows()).toEqual([
      "Редактирование✓",
      "Исходный код",
      "Чтение",
      "Ширина контента",
      "Скрыть статусную панель",
      "Добавить слой",
      "Добавить в избранное",
      "Открыть в новой вкладке",
      "Разделить вправо",
      "Разделить вниз",
      "Переместить файл в…",
      "Объединить с…",
      "Копировать путь",
      "Экспорт заметки в PDF",
      "Показать в проводнике",
      "Переименовать",
      "В архив",
      "Удалить файл",
    ])
    expect(screen.getAllByRole("separator")).toHaveLength(4)
    // The mode in use carries the mark.
    expect(
      within(screen.getByRole("menuitem", { name: /Редактирование/ })).getByText("✓"),
    ).toBeTruthy()
  })

  it("runs the rows the surface gave, and disables the ones it did not", () => {
    const onToggleFavorite = vi.fn()
    const onViewModeChange = vi.fn()
    render(
      <DocumentHeader
        {...props({ onToggleFavorite, onViewModeChange, onDeleteFile: undefined })}
      />,
    )
    fireEvent.click(screen.getByRole("menuitem", { name: "Чтение" }))
    expect(onViewModeChange).toHaveBeenCalledWith("read")
    expect(
      screen.getByRole("menuitem", { name: "Удалить файл" }).getAttribute("aria-disabled"),
    ).toBe("true")
  })

  it("offers the layers of a note with several and the export of the layer in view", () => {
    render(
      <DocumentHeader
        {...props({
          activeLayer: "canvas",
          canvasEnabled: true,
          linkedLayers: { canvas: true, sketch: false, database: false, note: true },
        })}
      />,
    )
    expect(rows()).toEqual(
      expect.arrayContaining([
        "Основной слой",
        "Переключить слой",
        "Добавить слой",
        "Убрать слой",
        "Экспорт",
      ]),
    )
    expect(rows()).not.toContain("Экспорт заметки в PDF")
    // A canvas has no content width of its own.
    expect(rows()).not.toContain("Ширина контента")
  })

  it("shows the layer switch only for a note with more than one layer", () => {
    const { rerender } = render(<DocumentHeader {...props({ moreActionsOpen: false })} />)
    expect(screen.queryByTitle("Холст")).toBeNull()
    rerender(
      <DocumentHeader
        {...props({
          moreActionsOpen: false,
          canvasEnabled: true,
          linkedLayers: { canvas: true, sketch: false, database: false, note: true },
        })}
      />,
    )
    expect(screen.getAllByTitle("Холст").length).toBeGreaterThan(0)
  })
})
