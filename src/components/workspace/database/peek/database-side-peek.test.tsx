// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
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
