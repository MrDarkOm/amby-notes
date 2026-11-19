// @vitest-environment happy-dom
import * as React from "react"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import type { DatabaseRow } from "@/lib/storage"
import { DatabaseSidePeek } from "./database-side-peek"

const row: DatabaseRow = {
  noteId: "n1",
  title: "Write docs",
  relativePath: "Write docs.md",
  parentNoteId: null,
  depth: 0,
  categoryPath: [],
  valuesJson: "{}",
  rowRevision: "r",
}

describe("DatabaseSidePeek", () => {
  afterEach(cleanup)

  it("shows the properties above the note and keeps them out of the way of the body", () => {
    render(
      <DatabaseSidePeek
        row={row}
        propertiesSection={<span>Status control</span>}
        body={<p>Note body</p>}
        onClose={() => {}}
      />,
    )
    expect(screen.getByText("Status control")).toBeTruthy()
    expect(screen.getByText("Note body")).toBeTruthy()
  })

  it("as a centered window it is a dialog that closes on Escape and on the backdrop", () => {
    const onClose = vi.fn()
    render(
      <DatabaseSidePeek row={row} variant="center" body={<p>Note body</p>} onClose={onClose} />,
    )
    const dialog = screen.getByRole("dialog")
    expect(dialog.getAttribute("aria-modal")).toBe("true")
    fireEvent.keyDown(window, { key: "Escape" })
    expect(onClose).toHaveBeenCalledTimes(1)
    // A click inside the window does not close it; one on the backdrop does.
    fireEvent.mouseDown(dialog)
    expect(onClose).toHaveBeenCalledTimes(1)
    fireEvent.mouseDown(dialog.parentElement!)
    expect(onClose).toHaveBeenCalledTimes(2)
  })

  it("the side variant is not a modal dialog", () => {
    render(<DatabaseSidePeek row={row} onClose={() => {}} />)
    expect(screen.queryByRole("dialog")).toBeNull()
  })
})

describe("DatabaseSidePeek centered focus", () => {
  afterEach(cleanup)

  function Harness() {
    const [open, setOpen] = React.useState(false)
    // Opened by an event, not a click: a click would make happy-dom move focus after React has.
    React.useEffect(() => {
      const show = () => setOpen(true)
      window.addEventListener("show-peek", show)
      return () => window.removeEventListener("show-peek", show)
    }, [])
    return (
      <>
        <button data-testid="opener">open</button>
        <button data-testid="outside">outside</button>
        {open && (
          <DatabaseSidePeek
            row={row}
            variant="center"
            body={<p>Note body</p>}
            onClose={() => setOpen(false)}
          />
        )}
      </>
    )
  }

  it("moves focus inside, keeps Tab inside, and returns it to the opener", async () => {
    render(<Harness />)
    const opener = screen.getByTestId("opener")
    opener.focus()
    act(() => {
      window.dispatchEvent(new Event("show-peek"))
    })
    const dialog = screen.getByRole("dialog")
    expect(dialog.contains(document.activeElement)).toBe(true)

    const buttons = Array.from(dialog.querySelectorAll<HTMLButtonElement>("button")).filter(
      (button) => !button.disabled,
    )
    const last = buttons[buttons.length - 1]
    last.focus()
    fireEvent.keyDown(last, { key: "Tab" })
    expect(document.activeElement).toBe(buttons[0])
    fireEvent.keyDown(buttons[0], { key: "Tab", shiftKey: true })
    expect(document.activeElement).toBe(last)

    fireEvent.keyDown(window, { key: "Escape" })
    await act(async () => {})
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(document.activeElement).toBe(opener)
  })
})
