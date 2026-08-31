import { useTabsStore, type Tab } from "./use-tabs-store"
import { findTabTreeItem, treeItemTabTarget } from "./tab-target"
import type { TreeItem } from "./sidebar-tree"

interface UseTabActionsParams {
  activeTab: Tab | null
  activeTabKey: string
  secondaryTabKey: string | null
  tabs: Tab[]
  treeItems: TreeItem[]
  canGoBack: boolean
  canGoForward: boolean
  /** Loads a note or Canvas buffer without changing tab structure. */
  navigateToFile: (fileId: string) => Promise<void>
  /** Re-evaluate document-buffer lifetime after tab ownership changes. */
  onTabUsageChanged?: () => void
}

/**
 * Tab navigation + lifecycle: back/forward through a tab's history, switch the
 * active tab, toggle the editor split, close one or all tabs.
 *
 * Opening items is owned by useFileActions and the tabs store.
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
    const item = findTabTreeItem(treeItems, prevFileId)
    if (!item) return
    setTabs((prev) =>
      prev.map((t) =>
        t.key !== activeTabKey ? t : { ...t, ...treeItemTabTarget(item), historyIndex: newIndex },
      ),
    )
    navigateToFile(prevFileId)
    onTabUsageChanged?.()
  }

  function handleForward() {
    if (!activeTab || !canGoForward) return
    const newIndex = activeTab.historyIndex + 1
    const nextFileId = activeTab.history[newIndex]
    const item = findTabTreeItem(treeItems, nextFileId)
    if (!item) return
    setTabs((prev) =>
      prev.map((t) =>
        t.key !== activeTabKey ? t : { ...t, ...treeItemTabTarget(item), historyIndex: newIndex },
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
