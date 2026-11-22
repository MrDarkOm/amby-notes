// @vitest-environment happy-dom
import type { ComponentProps } from "react"
import { describe, expect, it, vi } from "vitest"
import { fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"
import { detectWindowControlsSide, HeaderTabs } from "@/components/workspace/header-tabs"

function headerProps(): ComponentProps<typeof HeaderTabs> {
  return {
    tabs: [],
    activeTabKey: "",
    onTabChange: vi.fn(),
    onTabClose: vi.fn(),
    vaults: [],
    currentVaultPath: null,
    showWorkspacePicker: false,
    onSwitchVault: vi.fn(),
    onAddVault: vi.fn(),
    onManageVaults: vi.fn(),
  }
}

describe("HeaderTabs tab layout and close button visibility", () => {
  it("renders tabs with equal fixed width and shrinking capabilities", () => {
    const tabs = [
      { key: "tab-1", fileId: "file-1", title: "Short" },
      { key: "tab-2", fileId: "file-2", title: "A very long note title that spans many words" },
    ]
    render(<HeaderTabs {...headerProps()} tabs={tabs} activeTabKey="tab-1" />)

    const tabElements = screen.getAllByTitle(/Short|A very long note/)
    expect(tabElements).toHaveLength(2)
    for (const el of tabElements) {
      expect(el.className).toContain("w-48")
      expect(el.className).toContain("shrink")
      expect(el.className).toContain("min-w-10")
    }

    const activeTab = screen.getByTitle("Short")
    const inactiveTab = screen.getByTitle("A very long note title that spans many words")
    expect(activeTab.className).toContain("h-10")
    expect(inactiveTab.className).toContain("h-8")
  })

  it("hides close button for inactive tabs at rest and keeps it visible on active tab", () => {
    const onTabClose = vi.fn()
    const tabs = [
      { key: "active-tab", fileId: "file-1", title: "Active Note" },
      { key: "inactive-tab", fileId: "file-2", title: "Inactive Note" },
    ]
    render(
      <HeaderTabs
        {...headerProps()}
        tabs={tabs}
        activeTabKey="active-tab"
        onTabClose={onTabClose}
      />,
    )

    const activeTab = screen.getByTitle("Active Note")
    const inactiveTab = screen.getByTitle("Inactive Note")

    const activeButton = activeTab.querySelector(
      'button[aria-label="Закрыть вкладку"]',
    ) as HTMLButtonElement
    const inactiveButton = inactiveTab.querySelector(
      'button[aria-label="Закрыть вкладку"]',
    ) as HTMLButtonElement

    expect(activeButton).not.toBeNull()
    expect(inactiveButton).not.toBeNull()

    // Active tab close button is interactive
    expect(activeButton.style.pointerEvents).toBe("auto")

    // Inactive tab close button is pointer-events none at rest
    expect(inactiveButton.style.pointerEvents).toBe("none")

    // Hovering inactive tab reveals the close button
    fireEvent.mouseEnter(inactiveTab)
    expect(inactiveButton.style.pointerEvents).toBe("auto")

    // Clicking close button calls onTabClose
    fireEvent.click(inactiveButton)
    expect(onTabClose).toHaveBeenCalledWith("inactive-tab")

    // Mouse leave hides it again
    fireEvent.mouseLeave(inactiveTab)
    expect(inactiveButton.style.pointerEvents).toBe("none")
  })

  it("renders a subtle divider between adjacent inactive tabs", () => {
    const tabs = [
      { key: "tab-1", fileId: "file-1", title: "Tab 1" },
      { key: "tab-2", fileId: "file-2", title: "Tab 2" },
      { key: "tab-3", fileId: "file-3", title: "Tab 3" },
    ]
    render(<HeaderTabs {...headerProps()} tabs={tabs} activeTabKey="tab-1" />)

    const tab1 = screen.getByTitle("Tab 1")
    const tab2 = screen.getByTitle("Tab 2")
    const tab3 = screen.getByTitle("Tab 3")

    // Active tab (tab 1) has no divider
    expect(tab1.querySelector("span[aria-hidden='true'].bg-border\\/60")).toBeNull()

    // Tab 2 has divider between itself and Tab 3
    const divider = tab2.querySelector("span[aria-hidden='true'].bg-border\\/60")
    expect(divider).not.toBeNull()

    // Tab 3 is the last tab, so it has no divider
    expect(tab3.querySelector("span[aria-hidden='true'].bg-border\\/60")).toBeNull()

    // Hovering Tab 2 hides its divider
    fireEvent.mouseEnter(tab2)
    expect(tab2.querySelector("span[aria-hidden='true'].bg-border\\/60")).toBeNull()

    // Mouse leave restores divider
    fireEvent.mouseLeave(tab2)
    expect(tab2.querySelector("span[aria-hidden='true'].bg-border\\/60")).not.toBeNull()
  })
})

describe("HeaderTabs window controls and sidebar toggle alignment", () => {
  it("detects window control placement by runtime and platform", () => {
    expect(
      detectWindowControlsSide({ isTauriEnv: false, isSiteDemo: false, platform: "MacIntel" }),
    ).toBe("none")
    expect(
      detectWindowControlsSide({ isTauriEnv: false, isSiteDemo: false, platform: "Win32" }),
    ).toBe("none")
    expect(
      detectWindowControlsSide({ isTauriEnv: true, isSiteDemo: true, platform: "MacIntel" }),
    ).toBe("none")
    expect(
      detectWindowControlsSide({ isTauriEnv: true, isSiteDemo: false, platform: "MacIntel" }),
    ).toBe("left")
    expect(
      detectWindowControlsSide({ isTauriEnv: true, isSiteDemo: false, platform: "Win32" }),
    ).toBe("right")
    expect(
      detectWindowControlsSide({ isTauriEnv: true, isSiteDemo: false, platform: "Linux x86_64" }),
    ).toBe("right")
  })

  it("aligns both sidebar toggles with their docks and omits OS controls in web mode", () => {
    const { container } = render(<HeaderTabs {...headerProps()} windowControlsSide="none" />)

    expect(container.querySelector('[data-window-controls-spacer="left"]')).toBeNull()
    expect(container.querySelector('[data-window-controls="right"]')).toBeNull()
    expect(container.querySelector('[data-sidebar-toggle-slot="left"]')).not.toBeNull()
    expect(container.querySelector('[data-sidebar-toggle-slot="right"]')).not.toBeNull()
  })

  it("shifts only the left toggle on macOS Tauri while keeping the right toggle dock-aligned", () => {
    const { container } = render(<HeaderTabs {...headerProps()} windowControlsSide="left" />)

    expect(container.querySelector('[data-window-controls-spacer="left"]')).not.toBeNull()
    expect(container.querySelector('[data-sidebar-toggle-slot="left-shifted"]')).not.toBeNull()
    expect(container.querySelector('[data-sidebar-toggle-slot="right"]')).not.toBeNull()
    expect(container.querySelector('[data-window-controls="right"]')).toBeNull()
  })

  it("keeps the left toggle dock-aligned and places the right toggle beside Windows controls", () => {
    const { container } = render(<HeaderTabs {...headerProps()} windowControlsSide="right" />)

    expect(container.querySelector('[data-window-controls-spacer="left"]')).toBeNull()
    expect(container.querySelector('[data-sidebar-toggle-slot="left"]')).not.toBeNull()
    expect(container.querySelector('[data-sidebar-toggle-slot="right"]')).toBeNull()
    expect(container.querySelector('[data-window-controls="right"]')).not.toBeNull()
  })

  it("does not shift header tabs or view controls when compact overlay panels are open", () => {
    document.documentElement.style.setProperty("--amby-left-panel-width", "300px")
    document.documentElement.style.setProperty("--amby-right-panel-width", "300px")
    try {
      for (const side of ["left", "right", "none"] as const) {
        const { container, unmount } = render(
          <HeaderTabs
            {...headerProps()}
            windowControlsSide={side}
            isLeftSidebarOpen
            isRightSidebarOpen
            isLeftDockPinned
            isRightDockPinned
            leftTreeWidth={0}
            rightPanelWidth={0}
          />,
        )
        const header = container.querySelector("header")
        expect(header).not.toBeNull()
        const styledChildren = Array.from(header!.querySelectorAll<HTMLElement>("[style]"))
        for (const el of styledChildren) {
          expect(el.style.width).not.toContain("--amby-left-panel-width")
          expect(el.style.width).not.toContain("--amby-right-panel-width")
          expect(el.style.right).not.toContain("--amby-right-panel-width")
        }
        unmount()
      }
    } finally {
      document.documentElement.style.removeProperty("--amby-left-panel-width")
      document.documentElement.style.removeProperty("--amby-right-panel-width")
    }
  })
})
