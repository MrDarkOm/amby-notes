// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import type { DatabaseRow } from "@/lib/storage"
import type { RowMenuModel } from "../row-menu"
import { ListView } from "./list-view"

function row(noteId: string, title: string): DatabaseRow {
  return {
    noteId,
    title,
    relativePath: `${title}.md`,
    parentNoteId: null,
    depth: 0,
    categoryPath: [],
    valuesJson: "{}",
    rowRevision: "",
  }
}

const rows = [row("a", "Alpha"), row("b", "Beta"), row("c", "Gamma")]

function menu(overrides: Partial<RowMenuModel> = {}): (row: DatabaseRow) => RowMenuModel {
  return () => ({
    isFavorite: false,
    openMode: "sidePeek",
    currentDatabaseId: "db",
    databases: [],
    onOpen: vi.fn(),
    onCopyLink: vi.fn(),
    onDelete: vi.fn(),
    ...overrides,
  })
}

/** Pointer events on `window`, as the drag listens there. */
function pointer(type: "pointermove" | "pointerup", x: number, y: number) {
  act(() => {
    const event = new Event(type, { bubbles: true })
    Object.assign(event, { clientX: x, clientY: y })
    window.dispatchEvent(event)
  })
}

describe("rows of a list placed by hand", () => {
  beforeEach(() => {
    // Rows are 40px tall and stacked: Alpha 0-40, Beta 40-80, Gamma 80-120.
    document.elementsFromPoint = (_x, y) => {
      const index = Math.floor(y / 40)
      const element = document.querySelector(`[data-reorder-id="${["a", "b", "c"][index]}"]`)
      return element ? [element] : []
    }
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (
      this: Element,
    ) {
      const id = this.getAttribute("data-reorder-id")
      const index = id ? ["a", "b", "c"].indexOf(id) : 0
      return new DOMRect(0, index * 40, 400, 40)
    })
  })
  afterEach(() => {
    cleanup()
    vi.restoreAllMocks()
  })

  it("drops a row after the row under the pointer when it is let go in its lower half", () => {
    const onReorder = vi.fn()
    render(
      <ListView
        rows={rows}
        rowMenu={menu()}
        rowReorder={{ enabled: true, onReorder }}
        onRowSelect={vi.fn()}
      />,
    )
    const grips = screen.getAllByRole("button", { name: /Перетащить строку/u })
    expect(grips).toHaveLength(3)
    fireEvent.pointerDown(grips[0], { button: 0, isPrimary: true, clientX: 5, clientY: 20 })
    pointer("pointermove", 5, 60) // moved 40px: a drag
    pointer("pointermove", 5, 110) // lower half of Gamma
    pointer("pointerup", 5, 110)
    expect(onReorder).toHaveBeenCalledWith("a", "c", "after")
  })

  it("does nothing when the row is let go over itself", () => {
    const onReorder = vi.fn()
    render(
      <ListView
        rows={rows}
        rowMenu={menu()}
        rowReorder={{ enabled: true, onReorder }}
        onRowSelect={vi.fn()}
      />,
    )
    const [grip] = screen.getAllByRole("button", { name: /Перетащить строку/u })
    fireEvent.pointerDown(grip, { button: 0, isPrimary: true, clientX: 5, clientY: 20 })
    pointer("pointermove", 5, 30)
    pointer("pointerup", 5, 30)
    expect(onReorder).not.toHaveBeenCalled()
  })

  it("opens the row's menu when the grip is pressed without moving", () => {
    const onRowSelect = vi.fn()
    render(
      <ListView
        rows={rows}
        rowMenu={menu()}
        rowReorder={{ enabled: true, onReorder: vi.fn() }}
        onRowSelect={onRowSelect}
      />,
    )
    const [grip] = screen.getAllByRole("button", { name: /Перетащить строку/u })
    fireEvent.pointerDown(grip, { button: 0, isPrimary: true, clientX: 5, clientY: 20 })
    pointer("pointerup", 5, 20)
    expect(screen.getByRole("button", { name: "Копировать ссылку" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Удалить" })).toBeTruthy()
    // The press did not open the page behind the grip.
    expect(onRowSelect).not.toHaveBeenCalled()
  })

  it("tells the owner about a drag that a sort forbids, instead of moving anything", () => {
    const onReorder = vi.fn()
    const onBlockedDrag = vi.fn()
    render(
      <ListView
        rows={rows}
        rowMenu={menu()}
        rowReorder={{ enabled: false, onReorder, onBlockedDrag }}
        onRowSelect={vi.fn()}
      />,
    )
    const [grip] = screen.getAllByRole("button", { name: /Открыть меню строки/u })
    fireEvent.pointerDown(grip, { button: 0, isPrimary: true, clientX: 5, clientY: 20 })
    pointer("pointermove", 5, 110)
    pointer("pointerup", 5, 110)
    expect(onReorder).not.toHaveBeenCalled()
    expect(onBlockedDrag).toHaveBeenCalledTimes(1)
  })

  it("shows no grips without a menu", () => {
    render(<ListView rows={rows} onRowSelect={vi.fn()} />)
    expect(screen.queryAllByRole("button", { name: /строк/u })).toHaveLength(0)
  })
})

describe("selecting rows and the context menu", () => {
  afterEach(cleanup)

  it("has no checkboxes: rows are ticked in the table only", () => {
    render(<ListView rows={rows} rowMenu={menu()} onRowSelect={vi.fn()} />)
    expect(screen.queryAllByRole("checkbox")).toHaveLength(0)
  })

  it("opens the row menu on a right click and keeps the page closed", () => {
    const onRowSelect = vi.fn()
    render(<ListView rows={rows} rowMenu={menu()} onRowSelect={onRowSelect} />)
    const item = screen.getAllByRole("button", { name: /Бета|Beta/u })[0] ?? document.body
    fireEvent.contextMenu(item.closest("[data-reorder-id]") ?? item)
    expect(screen.getByRole("button", { name: "Копировать ссылку" })).toBeTruthy()
    expect(onRowSelect).not.toHaveBeenCalled()
  })
})
