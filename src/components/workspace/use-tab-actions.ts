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
  /** Re-evaluate document-buffer lifetime after tab ownership changes. */
  onTabUsageChanged?: () => void
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
  onTabUsageChanged,
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
    onTabUsageChanged?.()
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
    onTabUsageChanged?.()
  }

  const handleTabChange = (key: string) => setActiveTabKey(key)

  // A second editable pane must always receive a different document buffer.
  function toggleSplit() {
    setSecondaryTabKey((previous) => {
      if (previous) return null
      if (activeTab?.kind !== "document") return null
      return (
        tabs.find(
          (tab) =>
            tab.kind === "document" && tab.key !== activeTabKey && tab.fileId !== activeTab.fileId,
        )?.key ?? null
      )
    })
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
    onTabUsageChanged?.()
  }

  function handleCloseAllTabs() {
    setTabs([])
    setActiveTabKey("")
    setSecondaryTabKey(null)
    onTabUsageChanged?.()
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
