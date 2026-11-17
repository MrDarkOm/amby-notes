// @vitest-environment happy-dom
import * as React from "react"
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import type { Editor } from "@tiptap/react"
import { afterEach, describe, expect, it } from "vitest"
import "@/lib/i18n"
import { ImageLightbox } from "./ImageLightbox"

const pictures = [
  { src: "a.png", shownSrc: "a.png" },
  { src: "b.png", shownSrc: "b.png" },
]

function Harness() {
  const [open, setOpen] = React.useState(false)
  return (
    <>
      <button data-testid="opener" onClick={() => setOpen(true)}>
        open
      </button>
      <button data-testid="other">other</button>
      {open && (
        <ImageLightbox
          editor={{} as Editor}
          pictures={pictures}
          start={0}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  )
}

async function openLightbox() {
  render(<Harness />)
  const opener = screen.getByTestId("opener")
  opener.focus()
  fireEvent.click(opener)
  await act(async () => {})
  return opener
}

describe("ImageLightbox focus", () => {
  afterEach(cleanup)

  it("moves focus inside when it opens", async () => {
    await openLightbox()
    const dialog = screen.getByRole("dialog")
    expect(dialog.contains(document.activeElement)).toBe(true)
  })

  it("keeps Tab inside the viewer", async () => {
    await openLightbox()
    const dialog = screen.getByRole("dialog")
    const buttons = dialog.querySelectorAll<HTMLElement>("button")
    const last = buttons[buttons.length - 1]
    last.focus()
    fireEvent.keyDown(last, { key: "Tab" })
    await act(async () => {})
    expect(document.activeElement).toBe(buttons[0])
    fireEvent.keyDown(buttons[0], { key: "Tab", shiftKey: true })
    await act(async () => {})
    expect(document.activeElement).toBe(last)
  })

  it("returns focus to the element that opened it", async () => {
    const opener = await openLightbox()
    fireEvent.keyDown(window, { key: "Escape" })
    await act(async () => {})
    expect(screen.queryByRole("dialog")).toBeNull()
    await waitFor(() => expect(document.activeElement).toBe(opener))
  })
})
