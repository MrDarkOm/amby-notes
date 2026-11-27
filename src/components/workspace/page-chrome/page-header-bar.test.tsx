// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import "@/lib/i18n"
import { PageHeaderBar, type PageHeaderBarProps } from "./page-header-bar"
import type { PageCrumb } from "./page-chrome-types"

// happy-dom lays nothing out; a bar 800 px wide shows everything.
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(800)
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const crumb = (key: string, onOpen?: () => void): PageCrumb => ({ key, label: key, onOpen })

function mount(props: Partial<PageHeaderBarProps> = {}) {
  return render(<PageHeaderBar crumbs={[]} {...props} />)
}

const openMenu = () =>
  fireEvent.pointerDown(screen.getByRole("button", { name: "Другие действия" }), {
    button: 0,
    ctrlKey: false,
  })

describe("PageHeaderBar breadcrumb", () => {
  it("links every crumb but the last, which is the page", () => {
    const open = vi.fn()
    mount({ crumbs: [crumb("Workshop", open), crumb("Universe", vi.fn()), crumb("Story")] })
    fireEvent.click(screen.getByRole("button", { name: "Workshop" }))
    expect(open).toHaveBeenCalledTimes(1)
    expect(screen.getByRole("button", { name: "Universe" })).toBeTruthy()
    // The page itself is text, not a link.
    expect(screen.queryByRole("button", { name: "Story" })).toBeNull()
    expect(screen.getByText("Story")).toBeTruthy()
  })

  it("makes no link of a crumb that has no handler", () => {
    mount({ crumbs: [crumb("Folder"), crumb("Note")] })
    expect(screen.queryByRole("button", { name: "Folder" })).toBeNull()
  })

  it("folds a long trail into its first crumb, an ellipsis and the last two", () => {
    const open = vi.fn()
    mount({ crumbs: ["a", "b", "c", "d", "e"].map((key) => crumb(key, open)) })
    expect(screen.getByText("a")).toBeTruthy()
    expect(screen.getByText("…").getAttribute("title")).toBe("b › c")
    expect(screen.queryByText("b")).toBeNull()
    expect(screen.getByText("d")).toBeTruthy()
    expect(screen.getByText("e")).toBeTruthy()
    // Resting on the ellipsis shows the whole trail.
    fireEvent.mouseEnter(screen.getByText("…"))
    expect(screen.getByText("b")).toBeTruthy()
    expect(screen.getByText("c")).toBeTruthy()
  })

  it("shows a plain title while there are no crumbs", () => {
    mount({ fallbackTitle: "Untitled" })
    expect(screen.getByText("Untitled")).toBeTruthy()
  })
})

describe("PageHeaderBar buttons", () => {
  it("steps through the history and disables the ends", () => {
    const back = vi.fn()
    const forward = vi.fn()
    mount({
      onBack: back,
      onForward: forward,
      canGoBack: true,
      canGoForward: false,
      backLabel: "Back",
      forwardLabel: "Forward",
    })
    fireEvent.click(screen.getByRole("button", { name: "Back" }))
    expect(back).toHaveBeenCalledTimes(1)
    const forwardButton = screen.getByRole("button", { name: "Forward" }) as HTMLButtonElement
    expect(forwardButton.disabled).toBe(true)
  })

  it("leaves the history out when the surface has none", () => {
    mount({ showHistory: false, backLabel: "Back" })
    expect(screen.queryByRole("button", { name: "Back" })).toBeNull()
  })

  it("drops the path and then the focus toggle as the bar narrows", () => {
    const width = vi.spyOn(HTMLElement.prototype, "clientWidth", "get")
    width.mockReturnValue(300)
    const { unmount } = mount({ crumbs: [crumb("Story")], onToggleFocusMode: vi.fn() })
    expect(screen.getByTitle("Режим фокуса")).toBeTruthy()
    unmount()
    width.mockReturnValue(200)
    mount({ crumbs: [crumb("Story")], onToggleFocusMode: vi.fn() })
    expect(screen.queryByTitle("Режим фокуса")).toBeNull()
  })

  it("toggles focus mode and says which way", () => {
    const toggle = vi.fn()
    const { rerender } = mount({ onToggleFocusMode: toggle })
    fireEvent.click(screen.getByTitle("Режим фокуса"))
    expect(toggle).toHaveBeenCalledTimes(1)
    rerender(<PageHeaderBar crumbs={[]} isFocusMode onToggleFocusMode={toggle} />)
    expect(screen.getByTitle("Выйти из фокуса")).toBeTruthy()
  })

  it("puts the surface's own buttons around the focus toggle", () => {
    mount({
      onToggleFocusMode: vi.fn(),
      leadingActions: <button data-testid="before">before</button>,
      trailingActions: <button data-testid="after">after</button>,
    })
    const before = screen.getByTestId("before")
    const focus = screen.getByTitle("Режим фокуса")
    const after = screen.getByTestId("after")
    expect(before.compareDocumentPosition(focus) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(focus.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it("hands a function the width class of the bar", () => {
    const leading = vi.fn(() => null)
    mount({ leadingActions: leading })
    expect(leading).toHaveBeenCalledWith({ isNarrow: false, isUltraNarrow: false, isTiny: false })
  })

  it("names the page by its tab menu in focus mode", () => {
    mount({
      isFocusMode: true,
      crumbs: [crumb("Workshop", vi.fn()), crumb("Story")],
      focus: { title: "Story", tabs: [] },
    })
    expect(screen.getByTitle("Меню вкладок")).toBeTruthy()
  })
})

describe("PageHeaderBar floating variant", () => {
  it("lays its buttons over the surface and keeps what the graph shows", () => {
    const { container } = mount({
      variant: "floating",
      onBack: vi.fn(),
      onForward: vi.fn(),
      canGoBack: true,
      backLabel: "Back",
      forwardLabel: "Forward",
      onToggleFocusMode: vi.fn(),
    })
    const root = container.firstElementChild as HTMLElement
    expect(root.className).toContain("pointer-events-none absolute inset-x-0 top-0")
    expect(root.querySelectorAll(".amby-graph-toolbar")).toHaveLength(2)
    expect(screen.getByRole("button", { name: "Back" })).toBeTruthy()
    expect(screen.getByRole("button", { name: "Режим фокуса" })).toBeTruthy()
  })

  it("draws nothing on the right when there is nothing to put there", () => {
    const { container } = mount({
      variant: "floating",
      showHistory: false,
      hideFocusToggle: true,
    })
    expect(container.querySelectorAll(".amby-graph-toolbar")).toHaveLength(0)
  })
})

describe("PageHeaderBar menu", () => {
  it("builds the menu from groups and puts a separator between two groups only", () => {
    const select = vi.fn()
    mount({
      menu: {
        groups: [
          [{ id: "a", label: "Alpha", onSelect: select }],
          [],
          [
            { id: "b", label: "Beta", disabled: true },
            { id: "c", label: "Gamma", destructive: true },
          ],
        ],
      },
    })
    openMenu()
    const items = screen.getAllByRole("menuitem").map((item) => item.textContent)
    expect(items).toEqual(["Alpha", "Beta", "Gamma"])
    expect(screen.getAllByRole("separator")).toHaveLength(1)
    expect(screen.getByRole("menuitem", { name: "Beta" }).getAttribute("aria-disabled")).toBe(
      "true",
    )
    fireEvent.click(screen.getByRole("menuitem", { name: "Alpha" }))
    expect(select).toHaveBeenCalledTimes(1)
  })

  it("marks the chosen row of a choice", () => {
    mount({
      menu: {
        groups: [
          [
            { id: "x", label: "One", checked: true },
            { id: "y", label: "Two", checked: false },
          ],
        ],
      },
    })
    openMenu()
    expect(within(screen.getByRole("menuitem", { name: /One/ })).getByText("✓")).toBeTruthy()
    expect(within(screen.getByRole("menuitem", { name: /Two/ })).queryByText("✓")).toBeNull()
  })

  it("opens a side menu from a row that has one", () => {
    const pick = vi.fn()
    mount({
      menu: {
        groups: [
          [
            {
              id: "width",
              label: "Width",
              submenu: [[{ id: "wide", label: "Wide", onSelect: pick }]],
            },
          ],
        ],
      },
    })
    openMenu()
    const trigger = screen.getByRole("menuitem", { name: "Width" })
    fireEvent.keyDown(trigger, { key: "ArrowRight" })
    fireEvent.click(screen.getByRole("menuitem", { name: "Wide" }))
    expect(pick).toHaveBeenCalledTimes(1)
  })

  it("has no menu button when the surface gives no groups", () => {
    mount({})
    expect(screen.queryByRole("button", { name: "Другие действия" })).toBeNull()
  })
})
