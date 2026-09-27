// @vitest-environment happy-dom
import type { ComponentProps } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { cleanup, fireEvent, render, screen } from "@testing-library/react"
import "@/lib/i18n"
import { HeaderTabs } from "@/components/workspace/header-tabs"
import { useTabActions } from "@/components/workspace/use-tab-actions"
import { useTabsStore, type Tab } from "@/components/workspace/use-tabs-store"

const tab = (key: string, fileId: string): Tab => ({
  key,
  fileId,
  kind: "document",
  title: fileId,
  history: [fileId],
  historyIndex: 0,
})

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
    onRenameVault: vi.fn(),
    onDeleteVault: vi.fn(),
    onMoveVault: vi.fn(),
    onOpenVaultInExplorer: vi.fn(),
  }
}

function SplitHeader() {
  const { tabs, activeTabKey, secondaryTabKey } = useTabsStore()
  const actions = useTabActions({
    tabs,
    activeTabKey,
    secondaryTabKey,
    activeTab: tabs.find((item) => item.key === activeTabKey) ?? null,
    treeItems: [],
    canGoBack: false,
    canGoForward: false,
    navigateToFile: async () => {},
  })
  return (
    <HeaderTabs
      {...headerProps()}
      tabs={tabs}
      activeTabKey={activeTabKey}
      onToggleSplit={actions.toggleSplit}
      isSplit={secondaryTabKey !== null}
    />
  )
}

describe("HeaderTabs split control", () => {
  beforeEach(() => {
    useTabsStore.setState({ tabs: [], activeTabKey: "", secondaryTabKey: null })
  })

  afterEach(cleanup)

  it("exposes a localized button that toggles split without selecting a duplicate note", () => {
    useTabsStore.setState({
      tabs: [tab("active", "note"), tab("duplicate", "note"), tab("other", "other-note")],
      activeTabKey: "active",
    })
    render(<SplitHeader />)

    const button = screen.getByRole("button", { name: "Разделить редактор" })
    expect(button.getAttribute("aria-pressed")).toBe("false")

    fireEvent.click(button)

    expect(useTabsStore.getState().secondaryTabKey).toBe("other")
    expect(button.getAttribute("aria-pressed")).toBe("true")

    fireEvent.click(button)

    expect(useTabsStore.getState().secondaryTabKey).toBeNull()
    expect(button.getAttribute("aria-pressed")).toBe("false")
  })

  it("does not display an inert split button when no action is provided", () => {
    render(<HeaderTabs {...headerProps()} />)

    expect(screen.queryByRole("button", { name: "Разделить редактор" })).toBeNull()
  })
})

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
    expect(activeTab.className).toContain("h-9")
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
