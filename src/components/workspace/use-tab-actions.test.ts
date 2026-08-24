import { beforeEach, describe, expect, it } from "vitest"
import { collectDocumentBufferUsage } from "./document-buffer-lifecycle"
import { useTabActions } from "./use-tab-actions"
import { useTabsStore, type Tab } from "./use-tabs-store"

const tab = (key: string, fileId: string): Tab => ({
  key,
  kind: "document",
  fileId,
  title: fileId,
  history: [fileId],
  historyIndex: 0,
})

describe("useTabActions buffer ownership", () => {
  beforeEach(() => {
    useTabsStore.setState({ tabs: [], activeTabKey: "", secondaryTabKey: null })
  })

  it("re-evaluates usage after closing a tab and clears a closed secondary pane", () => {
    const tabs = [tab("first", "one"), tab("second", "two")]
    useTabsStore.setState({ tabs, activeTabKey: "first", secondaryTabKey: "second" })
    let usageAfterClose: ReturnType<typeof collectDocumentBufferUsage> = new Map()
    const actions = useTabActions({
      activeTab: tabs[0],
      activeTabKey: "first",
      secondaryTabKey: "second",
      tabs,
      treeItems: [],
      canGoBack: false,
      canGoForward: false,
      navigateToFile: async () => {},
      onTabUsageChanged: () => {
        const state = useTabsStore.getState()
        usageAfterClose = collectDocumentBufferUsage(
          state.tabs,
          state.activeTabKey,
          state.secondaryTabKey,
        )
      },
    })

    actions.handleTabClose("second")

    expect(useTabsStore.getState()).toMatchObject({
      activeTabKey: "first",
      secondaryTabKey: null,
      tabs: [tabs[0]],
    })
    expect(usageAfterClose.has("two")).toBe(false)
  })

  it("selects a different note for split instead of a duplicate tab", () => {
    const tabs = [tab("active", "note"), tab("duplicate", "note"), tab("other", "other")]
    useTabsStore.setState({ tabs, activeTabKey: "active", secondaryTabKey: null })
    const actions = useTabActions({
      activeTab: tabs[0],
      activeTabKey: "active",
      secondaryTabKey: null,
      tabs,
      treeItems: [],
      canGoBack: false,
      canGoForward: false,
      navigateToFile: async () => {},
    })

    actions.toggleSplit()

    expect(useTabsStore.getState().secondaryTabKey).toBe("other")
  })
})
