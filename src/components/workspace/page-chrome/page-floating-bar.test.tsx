// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import { PageFloatingBar } from "./page-floating-bar"

afterEach(cleanup)

describe("PageFloatingBar", () => {
  it("draws only the parts the surface passes in", () => {
    const { container, rerender } = render(<PageFloatingBar wordCount="3 words" />)
    expect(screen.getByText("3 words")).toBeTruthy()
    expect(screen.queryByRole("button")).toBeNull()
    expect(container.querySelectorAll("div.w-px")).toHaveLength(0)

    rerender(
      <PageFloatingBar
        modified="Edited now"
        wordCount="3 words"
        onUndo={vi.fn()}
        onRedo={vi.fn()}
        undoLabel="Undo"
        redoLabel="Redo"
        lock={{ locked: false, onToggle: vi.fn(), title: "Lock" }}
        settings={{ title: "Settings", onClick: vi.fn() }}
      />,
    )
    expect(screen.getByText("Edited now")).toBeTruthy()
    for (const name of ["Undo", "Redo", "Lock", "Settings"]) {
      expect(screen.getByTitle(name)).toBeTruthy()
    }
    // Statistics, history and the tools are told apart by two separators.
    expect(container.querySelectorAll("div.w-px")).toHaveLength(2)
  })

  it("has no undo or redo on a page that has none", () => {
    render(
      <PageFloatingBar
        wordCount="3 words"
        lock={{ locked: false, onToggle: vi.fn(), title: "Lock" }}
      />,
    )
    expect(screen.queryByTitle("Undo")).toBeNull()
    expect(screen.getByTitle("Lock")).toBeTruthy()
  })

  it("takes undo and redo away while the page is locked", () => {
    render(
      <PageFloatingBar
        wordCount="3 words"
        onUndo={vi.fn()}
        onRedo={vi.fn()}
        undoLabel="Undo"
        redoLabel="Redo"
        historyDisabled
      />,
    )
    expect(screen.queryByTitle("Undo")).toBeNull()
    expect(screen.queryByTitle("Redo")).toBeNull()
  })

  it("toggles the lock and shows the state", () => {
    const toggle = vi.fn()
    render(
      <PageFloatingBar
        wordCount="3 words"
        lock={{ locked: true, onToggle: toggle, title: "Edit", asToggle: true }}
      />,
    )
    const button = screen.getByTitle("Edit")
    expect(button.getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(button)
    expect(toggle).toHaveBeenCalledTimes(1)
  })

  it("takes the place of the time and words with a summary of its own", () => {
    render(<PageFloatingBar summary="2 nodes" modified="ignored" wordCount="ignored" />)
    expect(screen.getByText("2 nodes")).toBeTruthy()
    expect(screen.queryByText("ignored")).toBeNull()
  })

  it("calls the settings button, or opens a popover of settings", () => {
    const click = vi.fn()
    const { rerender } = render(
      <PageFloatingBar
        settings={{ title: "Settings", onClick: click, active: true, toggle: true }}
      />,
    )
    const button = screen.getByTitle("Settings")
    expect(button.getAttribute("aria-pressed")).toBe("true")
    fireEvent.click(button)
    expect(click).toHaveBeenCalledTimes(1)

    rerender(<PageFloatingBar settings={{ title: "Settings", content: <p>Panel</p> }} />)
    fireEvent.pointerDown(screen.getByTitle("Settings"), { button: 0, ctrlKey: false })
    fireEvent.click(screen.getByTitle("Settings"))
    expect(screen.getByText("Panel")).toBeTruthy()
  })

  it("draws nothing when hidden or empty", () => {
    const { container, rerender } = render(<PageFloatingBar hidden wordCount="3 words" />)
    expect(container.firstChild).toBeNull()
    rerender(<PageFloatingBar />)
    expect(container.firstChild).toBeNull()
  })
})
