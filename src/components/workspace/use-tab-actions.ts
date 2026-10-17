import i18n from "@/lib/i18n"
import { GRAPH_TAB_FILE_ID, useTabsStore, type Tab, type TabTarget } from "./use-tabs-store"
import { findTabTreeItem, treeItemTabTarget } from "./tab-target"
import type { TreeItem } from "./sidebar-tree"
import { flushEditorSerializations } from "./tiptap/editor-serialization-lifecycle"
import { logger } from "@/lib/logger"

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

  /** A history entry is a file of the tree or the link graph, which has no file. */
  function historyTarget(fileId: string): TabTarget | null {
    if (fileId === GRAPH_TAB_FILE_ID)
      return { kind: "graph", fileId, title: i18n.t("workspace.graphTab") }
    const item = findTabTreeItem(treeItems, fileId)
    return item ? treeItemTabTarget(item) : null
  }

  function goToHistoryIndex(newIndex: number) {
    if (!activeTab) return
    flushEditorSerializations()
    const fileId = activeTab.history[newIndex]
    const target = fileId ? historyTarget(fileId) : null
    if (!target) return
    setTabs((prev) =>
      prev.map((t) => (t.key !== activeTabKey ? t : { ...t, ...target, historyIndex: newIndex })),
    )
    // A split pairs two documents, so it ends when this tab turns into another kind of page.
    if (target.kind !== "document" && secondaryTabKey === activeTabKey) setSecondaryTabKey(null)
    if (target.kind !== "graph") navigateToFile(fileId)
    onTabUsageChanged?.()
  }

  function handleBack() {
    if (!activeTab || !canGoBack) return
    goToHistoryIndex(activeTab.historyIndex - 1)
  }

  function handleForward() {
    if (!activeTab || !canGoForward) return
    goToHistoryIndex(activeTab.historyIndex + 1)
  }

  const handleTabChange = (key: string) => {
    flushEditorSerializations()
    setActiveTabKey(key)
  }

  // A second editable pane must always receive a different document buffer.
  function toggleSplit() {
    logger.info("tab.toggle_split", { activeTabKey })
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
    flushEditorSerializations()
    const closingTab = tabs.find((t) => t.key === key)
    logger.info("tab.close", {
      key,
      title: closingTab?.title,
      fileId: closingTab?.fileId,
      kind: closingTab?.kind,
    })
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
    flushEditorSerializations()
    logger.info("tab.close_all", { count: tabs.length })
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
