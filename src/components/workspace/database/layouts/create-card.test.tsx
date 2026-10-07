// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import { BoardView } from "./board-view"
import { GalleryView } from "./gallery-view"
import { ListView } from "./list-view"
import { OptionActionsProvider } from "../option-actions"

describe("adding a card under the cards", () => {
  beforeEach(() => {
    // The grid is virtualized: without a laid-out scroller it shows nothing.
    Object.defineProperty(HTMLElement.prototype, "offsetWidth", { configurable: true, value: 800 })
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", { configurable: true, value: 600 })
    Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, value: 800 })
  })
  afterEach(() => {
    cleanup()
    for (const key of ["offsetWidth", "offsetHeight", "clientWidth"]) {
      Reflect.deleteProperty(HTMLElement.prototype, key)
    }
  })

  it("offers a new page under the gallery's cards", () => {
    const onCreateCard = vi.fn()
    render(<GalleryView rows={[]} onCreateCard={onCreateCard} />)
    fireEvent.click(screen.getByRole("button", { name: "Новая страница" }))
    expect(onCreateCard).toHaveBeenCalledTimes(1)
  })

  it("has no add button when pages cannot be added", () => {
    render(<GalleryView rows={[]} />)
    expect(screen.queryByRole("button", { name: "Новая страница" })).toBeNull()
  })

  it("offers a new page in each lane and says which lane it was for", () => {
    const onCreateCard = vi.fn()
    render(
      <BoardView
        rows={[]}
        groupField={null}
        lanes={[
          { key: "todo", rows: [], label: "Todo", color: null },
          { key: "done", rows: [], label: "Done", color: null },
        ]}
        onCreateCard={onCreateCard}
      />,
    )
    const buttons = screen.getAllByRole("button", { name: "Новая страница" })
    expect(buttons).toHaveLength(2)
    fireEvent.click(buttons[1])
    expect(onCreateCard).toHaveBeenCalledWith("done")
  })

  it("puts the lane's button right under its last card, inside the scrolling lane", () => {
    render(
      <BoardView
        rows={[]}
        groupField={null}
        lanes={[{ key: "todo", rows: [], label: "Todo", color: "#ec4899" }]}
        onCreateCard={vi.fn()}
        colorColumns
      />,
    )
    const button = screen.getByRole("button", { name: "Новая страница" })
    // Not pinned to the bottom of the lane: it scrolls with the cards.
    expect(button.parentElement?.className).toContain("overflow-y-auto")
    // Dashed, in the lane's colour.
    expect(button.className).toContain("border-dashed")
    expect(button.style.color).not.toBe("")
  })

  it("shows no column colour unless the view asks for it", () => {
    const { container } = render(
      <BoardView
        rows={[]}
        groupField={null}
        lanes={[{ key: "todo", rows: [], label: "Todo", color: "#ec4899" }]}
        onCreateCard={vi.fn()}
      />,
    )
    const lane = container.querySelector<HTMLElement>("[data-lane-drop]")!
    expect(lane.style.backgroundColor).toBe("")
    expect(lane.className).toContain("bg-muted/40")
    expect(screen.getByRole("button", { name: "Новая страница" }).style.color).toBe("")
  })

  it("lets the column colour be changed where the schema can be edited", () => {
    const setOptionColor = vi.fn(async () => {})
    render(
      <OptionActionsProvider
        value={{ createOption: async () => null, saveOptions: async () => {}, setOptionColor }}
      >
        <BoardView
          rows={[]}
          groupField={{ kind: "property", propertyId: "p" }}
          lanes={[
            { key: "opt1", rows: [], label: "Todo", color: "#ec4899" },
            { key: "__empty__", rows: [], label: null, color: null },
          ]}
          colorColumns
        />
      </OptionActionsProvider>,
    )
    // Only the column of a real option has a colour menu.
    const triggers = screen.getAllByRole("button", { name: "Цвет колонки" })
    expect(triggers).toHaveLength(1)
    fireEvent.click(triggers[0])
    fireEvent.click(screen.getAllByRole("option")[0])
    expect(setOptionColor).toHaveBeenCalledWith("p", "opt1", expect.stringMatching(/^#/))
  })

  it("has no colour menu without a schema owner (a view inside a note)", () => {
    render(
      <BoardView
        rows={[]}
        groupField={{ kind: "property", propertyId: "p" }}
        lanes={[{ key: "opt1", rows: [], label: "Todo", color: "#ec4899" }]}
        colorColumns
      />,
    )
    expect(screen.queryByRole("button", { name: "Цвет колонки" })).toBeNull()
  })

  it("offers a new page row under the list, like the table", () => {
    const onCreateCard = vi.fn()
    render(<ListView rows={[]} onCreateCard={onCreateCard} />)
    fireEvent.click(screen.getByRole("button", { name: "Новая страница" }))
    expect(onCreateCard).toHaveBeenCalledTimes(1)
  })
})
