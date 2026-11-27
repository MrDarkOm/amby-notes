// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TabItem, TabList, type HeaderTab } from "./header-tabs"

const tabs: HeaderTab[] = [
  { key: "a", fileId: "a", title: "Alpha" },
  { key: "b", fileId: "b", title: "Beta" },
  { key: "c", fileId: "c", title: "Gamma" },
]

function mount(activeKey = "b") {
  const onTabChange = vi.fn()
  const onTabClose = vi.fn()
  render(
    <TabList>
      {tabs.map((tab) => (
        <TabItem
          key={tab.key}
          tab={tab}
          isSelected={tab.key === activeKey}
          totalTabsInPane={tabs.length}
          onTabChange={onTabChange}
          onTabClose={onTabClose}
        />
      ))}
    </TabList>,
  )
  return { onTabChange, onTabClose }
}

afterEach(cleanup)

describe("document tabs keyboard access", () => {
  it("exposes a tablist of tabs with the active one selected", () => {
    mount("b")
    expect(screen.getByRole("tablist")).toBeTruthy()
    const items = screen.getAllByRole("tab")
    expect(items.map((el) => el.getAttribute("aria-selected"))).toEqual(["false", "true", "false"])
  })

  it("puts only the active tab in the Tab order", () => {
    mount("b")
    const items = screen.getAllByRole("tab")
    expect(items.map((el) => el.getAttribute("tabindex"))).toEqual(["-1", "0", "-1"])
  })

  it("moves focus with arrows, Home and End without activating", () => {
    const { onTabChange } = mount("b")
    const [a, b, c] = screen.getAllByRole("tab")
    b.focus()
    fireEvent.keyDown(b, { key: "ArrowRight" })
    expect(document.activeElement).toBe(c)
    fireEvent.keyDown(c, { key: "ArrowRight" })
    expect(document.activeElement).toBe(a)
    fireEvent.keyDown(a, { key: "ArrowLeft" })
    expect(document.activeElement).toBe(c)
    fireEvent.keyDown(c, { key: "Home" })
    expect(document.activeElement).toBe(a)
    fireEvent.keyDown(a, { key: "End" })
    expect(document.activeElement).toBe(c)
    expect(onTabChange).not.toHaveBeenCalled()
  })

  it("activates the focused tab with Enter and Space", () => {
    const { onTabChange } = mount("b")
    const [a, , c] = screen.getAllByRole("tab")
    fireEvent.keyDown(a, { key: "Enter" })
    expect(onTabChange).toHaveBeenLastCalledWith("a")
    fireEvent.keyDown(c, { key: " " })
    expect(onTabChange).toHaveBeenLastCalledWith("c")
  })

  it("does not activate on Enter that confirms an IME composition", () => {
    const { onTabChange } = mount("b")
    fireEvent.keyDown(screen.getAllByRole("tab")[0], { key: "Enter", keyCode: 229 })
    expect(onTabChange).not.toHaveBeenCalled()
  })

  it("closes the focused tab with Delete and keeps the close button out of the Tab order", () => {
    const { onTabClose } = mount("b")
    const [a] = screen.getAllByRole("tab")
    fireEvent.keyDown(a, { key: "Delete" })
    expect(onTabClose).toHaveBeenCalledWith("a")
    for (const button of screen.getAllByRole("button")) {
      expect(button.getAttribute("tabindex")).toBe("-1")
    }
  })

  it("ignores keys pressed inside the close button", () => {
    const { onTabChange, onTabClose } = mount("b")
    const button = screen.getAllByRole("button")[0]
    fireEvent.keyDown(button, { key: "Enter" })
    expect(onTabChange).not.toHaveBeenCalled()
    expect(onTabClose).not.toHaveBeenCalled()
  })
})
