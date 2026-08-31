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
