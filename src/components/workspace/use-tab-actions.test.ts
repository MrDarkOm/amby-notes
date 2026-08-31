import { beforeEach, describe, expect, it } from "vitest"
import { collectDocumentBufferUsage } from "./document-buffer-lifecycle"
import { useTabActions } from "./use-tab-actions"
import { useTabsStore, type Tab } from "./use-tabs-store"
import type { TreeItem } from "./sidebar-tree"

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

  it("restores the correct view type while going back and forward through mixed history", () => {
    const treeItems: TreeItem[] = [
      { id: "note", path: "/vault/Note.md", name: "Note", type: "file" },
      { id: "folder", path: "/vault/Folder", name: "Folder", type: "folder", children: [] },
      {
        id: "canvas:/vault/Board.canvas",
        path: "/vault/Board.canvas",
        name: "Board",
        type: "canvas",
      },
    ]
    const history = ["note", "folder", "/vault/Board.canvas"]
    useTabsStore.setState({
      tabs: [
        {
          key: "active",
          kind: "canvas",
          fileId: history[2],
          title: "Board",
          history,
          historyIndex: 2,
        },
      ],
      activeTabKey: "active",
    })
    const loaded: string[] = []
    function useHistoryActions() {
      const state = useTabsStore.getState()
      return useTabActions({
        ...state,
        activeTab: state.tabs[0],
        treeItems,
        canGoBack: state.tabs[0].historyIndex > 0,
        canGoForward: state.tabs[0].historyIndex < 2,
        navigateToFile: async (id) => {
          loaded.push(id)
        },
      })
    }
    useHistoryActions().handleBack()
    expect(useTabsStore.getState().tabs[0]).toMatchObject({
      kind: "folder",
      fileId: "folder",
      title: "Folder",
    })
    useHistoryActions().handleBack()
    expect(useTabsStore.getState().tabs[0]).toMatchObject({ kind: "document", fileId: "note" })
    useHistoryActions().handleForward()
    useHistoryActions().handleForward()
    expect(useTabsStore.getState().tabs[0]).toMatchObject({
      kind: "canvas",
      fileId: history[2],
      title: "Board",
    })
    expect(useTabsStore.getState().tabs).toHaveLength(1)
    expect(loaded).toEqual(["folder", "note", "folder", history[2]])
  })
})
