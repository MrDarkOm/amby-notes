// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { Reorder } from "motion/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { DatabaseViewSummary } from "@/lib/storage"
import { ViewTabItem, type ViewTabDrag } from "./view-tab-item"

const view: DatabaseViewSummary = {
  viewId: "v1",
  title: "Table",
  layout: "table",
  revision: "r",
  groupField: null,
}

function mount(disabled = false) {
  const onClick = vi.fn()
  const onDropped = vi.fn()
  let handle: ViewTabDrag | null = null
  render(
    <Reorder.Group axis="x" values={[view]} onReorder={() => {}}>
      <ViewTabItem value={view} disabled={disabled} onDropped={onDropped}>
        {(drag) => {
          handle = drag
          return (
            <button
              type="button"
              onPointerDown={drag.startWatch}
              onClick={() => {
                if (!drag.consumeClick()) onClick()
              }}
            >
              Table
            </button>
          )
        }}
      </ViewTabItem>
    </Reorder.Group>,
  )
  return { onClick, onDropped, handle: () => handle as ViewTabDrag | null }
}

describe("ViewTabItem", () => {
  afterEach(cleanup)

  it("a press that hardly moves is still a click", () => {
    const { onClick, handle } = mount()
    const tab = screen.getByRole("button", { name: "Table" })
    fireEvent.pointerDown(tab, { button: 0, clientX: 10, clientY: 10 })
    act(() => {
      fireEvent.pointerMove(window, { clientX: 12, clientY: 11 })
      fireEvent.pointerUp(window)
    })
    fireEvent.click(tab)
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(handle()?.consumeClick()).toBe(false)
  })

  it("a press that moves far enough lifts the tab, and the click that ends it is swallowed", async () => {
    const { onClick, handle } = mount()
    const tab = screen.getByRole("button", { name: "Table" })
    fireEvent.pointerDown(tab, { button: 0, clientX: 10, clientY: 10 })
    act(() => {
      fireEvent.pointerMove(window, { clientX: 60, clientY: 12 })
    })
    expect(handle()?.consumeClick()).toBe(true)
    act(() => {
      fireEvent.pointerUp(window)
    })
    fireEvent.click(tab)
    expect(onClick).not.toHaveBeenCalled()
    // The next, ordinary click works again.
    await vi.waitFor(() => expect(handle()?.consumeClick()).toBe(false))
    fireEvent.click(tab)
    expect(onClick).toHaveBeenCalledTimes(1)
  })

  it("does not lift a tab while the database is locked", () => {
    const { handle } = mount(true)
    fireEvent.pointerDown(screen.getByRole("button", { name: "Table" }), {
      button: 0,
      clientX: 10,
      clientY: 10,
    })
    act(() => {
      fireEvent.pointerMove(window, { clientX: 90, clientY: 10 })
    })
    expect(handle()?.consumeClick()).toBe(false)
  })
})
