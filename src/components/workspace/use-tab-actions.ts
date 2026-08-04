import { useTabsStore, type Tab } from "./use-tabs-store"
import { findTreeItem } from "./workspace-tree-utils"
import type { TreeItem } from "./sidebar-tree"

interface UseTabActionsParams {
  activeTab: Tab | null
  activeTabKey: string
  secondaryTabKey: string | null
  tabs: Tab[]
  treeItems: TreeItem[]
  canGoBack: boolean
  canGoForward: boolean
  /** Loads the document for a fileId without changing tab structure. */
  navigateToFile: (fileId: string) => Promise<void>
}

/**
 * Tab navigation + lifecycle: back/forward through a tab's history, switch the
 * active tab, toggle the editor split, close one or all tabs.
 *
 * Tab-*opening* (openGraphTab / openCanvasTab) stays in Workspace because it
 * touches the Workspace-owned openCanvases state and must be available to
 * useFileActions, which runs before this hook.
 */
export function useTabActions({
  activeTab,
  activeTabKey,
  secondaryTabKey,
  tabs,
  treeItems,
  canGoBack,
  canGoForward,
  navigateToFile,
}: UseTabActionsParams) {
  const { setTabs, setActiveTabKey, setSecondaryTabKey } = useTabsStore.getState()

  function handleBack() {
    if (!activeTab || !canGoBack) return
    const newIndex = activeTab.historyIndex - 1
    const prevFileId = activeTab.history[newIndex]
    const item = findTreeItem(treeItems, prevFileId)
    setTabs((prev) =>
      prev.map((t) =>
        t.key !== activeTabKey
          ? t
          : { ...t, fileId: prevFileId, title: item?.name ?? t.title, historyIndex: newIndex },
      ),
    )
    navigateToFile(prevFileId)
  }

  function handleForward() {
    if (!activeTab || !canGoForward) return
    const newIndex = activeTab.historyIndex + 1
    const nextFileId = activeTab.history[newIndex]
    const item = findTreeItem(treeItems, nextFileId)
    setTabs((prev) =>
      prev.map((t) =>
        t.key !== activeTabKey
          ? t
          : { ...t, fileId: nextFileId, title: item?.name ?? t.title, historyIndex: newIndex },
      ),
    )
    navigateToFile(nextFileId)
  }

  const handleTabChange = (key: string) => setActiveTabKey(key)

  // Toggle the editor split: pin the active document into a second pane, or
  // collapse back to a single pane.
  function toggleSplit() {
    setSecondaryTabKey((prev) =>
      prev ? null : activeTab?.kind === "document" ? activeTabKey : null,
    )
  }

  const handleTabClose = (key: string) => {
    // Keep a pending autosave alive when a tab closes. The open document buffer
    // remains available until the queued write finishes, and cancelling here
    // could discard the last edit made just before closing the tab.
    if (secondaryTabKey === key) setSecondaryTabKey(null)
    const remaining = tabs.filter((t) => t.key !== key)
    setTabs(remaining)
    if (activeTabKey === key) {
      const next = remaining[remaining.length - 1]
      setActiveTabKey(next?.key ?? "")
    }
  }

  function handleCloseAllTabs() {
    setTabs([])
    setActiveTabKey("")
  }

  return {
    handleBack,
    handleForward,
    handleTabChange,
    toggleSplit,
    handleTabClose,
    handleCloseAllTabs,
  }
}
