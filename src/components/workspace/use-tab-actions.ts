import i18n from "@/lib/i18n"
import {
  GRAPH_TAB_FILE_ID,
  useTabsStore,
  type SplitPaneOptions,
  type Tab,
  type TabTarget,
} from "./use-tabs-store"
import { findPaneLeafByTabKey } from "./split-tree"
import { findTabTreeItem, treeItemTabTarget } from "./tab-target"
import type { TreeItem } from "./sidebar-tree"
import { flushEditorSerializations } from "./tiptap/editor-serialization-lifecycle"
import { logger } from "@/lib/logger"
import { creativeHistoryTarget } from "./creative/creative-history"
import { useProjectStore } from "./creative/project-store"
import { useDocStore } from "./use-doc-store"

/** The last back/forward step asked of each tab: a slower read never overrides a later step. */
const historyRequests = new Map<string, number>()

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
 * active tab, split panes horizontally/vertically, close one or all tabs.
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
  const { setTabs, setActiveTabKey, setSecondaryTabKey, splitPane } = useTabsStore.getState()

  /** A history entry is a file of the tree, a page without a file (the graph, a workshop page). */
  function historyTarget(fileId: string): TabTarget | null {
    if (fileId === GRAPH_TAB_FILE_ID)
      return { kind: "graph", fileId, title: i18n.t("workspace.graphTab") }
    const creative = creativeHistoryTarget(fileId, useProjectStore.getState().catalog, i18n.t)
    if (creative) return creative
    const item = findTabTreeItem(treeItems, fileId)
    return item ? treeItemTabTarget(item) : null
  }

  async function goToHistoryIndexForTab(targetTab: Tab, newIndex: number) {
    flushEditorSerializations()
    const fileId = targetTab.history[newIndex]
    const target = fileId ? historyTarget(fileId) : null
    if (!target) return
    const step = () => {
      setTabs((prev) =>
        prev.map((t) =>
          t.key !== targetTab.key ? t : { ...t, ...target, historyIndex: newIndex },
        ),
      )
      if (target.kind !== "document" && secondaryTabKey === targetTab.key) {
        setSecondaryTabKey(null)
      }
      onTabUsageChanged?.()
    }
    // A page without a file, or a note still in memory, is shown at once. Any other file is read
    // first and the tab turns to it only then, as opening from the tree does, so the tab never
    // shows an empty page while the file loads. Every step outdates a read still on its way.
    const request = (historyRequests.get(targetTab.key) ?? 0) + 1
    historyRequests.set(targetTab.key, request)
    if (
      target.kind === "graph" ||
      target.kind === "creative" ||
      useDocStore.getState().openDocs[fileId]
    ) {
      step()
      if (target.kind !== "graph" && target.kind !== "creative") void navigateToFile(fileId)
      return
    }
    try {
      await navigateToFile(fileId)
    } catch {
      // Navigation is best effort: the tab still turns, as it did before the read came first.
    }
    // A later step of this tab, or the tab having moved on meanwhile, wins over this one.
    if (historyRequests.get(targetTab.key) !== request) return
    const current = useTabsStore.getState().tabs.find((t) => t.key === targetTab.key)
    if (!current || current.historyIndex !== targetTab.historyIndex) return
    step()
  }

  // A header may hand its click event straight in (`onClick={onBack}`): only a string names a tab.
  function handleBack(key?: unknown) {
    const tabKey = typeof key === "string" ? key : undefined
    const targetTab = tabKey ? (tabs.find((t) => t.key === tabKey) ?? null) : activeTab
    if (!targetTab) return
    const tabCanGoBack = tabKey ? targetTab.historyIndex > 0 : canGoBack
    if (!tabCanGoBack) return
    return goToHistoryIndexForTab(targetTab, targetTab.historyIndex - 1)
  }

  function handleForward(key?: unknown) {
    const tabKey = typeof key === "string" ? key : undefined
    const targetTab = tabKey ? (tabs.find((t) => t.key === tabKey) ?? null) : activeTab
    if (!targetTab) return
    const tabCanGoForward = tabKey
      ? targetTab.historyIndex < targetTab.history.length - 1
      : canGoForward
    if (!tabCanGoForward) return
    return goToHistoryIndexForTab(targetTab, targetTab.historyIndex + 1)
  }

  const handleTabChange = (key: string) => {
    flushEditorSerializations()
    setActiveTabKey(key)
  }

  // Legacy 2-pane toggle + split helper
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

  function handleSplitRight(options?: SplitPaneOptions) {
    flushEditorSerializations()
    logger.info("tab.split_right", { activeTabKey, ...options })
    return splitPane("horizontal", options)
  }

  function handleSplitDown(options?: SplitPaneOptions) {
    flushEditorSerializations()
    logger.info("tab.split_down", { activeTabKey, ...options })
    return splitPane("vertical", options)
  }

  const handleTabClose = (key: string) => {
    flushEditorSerializations()
    const state = useTabsStore.getState()
    const closingTab = state.tabs.find((t) => t.key === key)
    const leaf = findPaneLeafByTabKey(state.rootPane, key)
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
    const remaining = state.tabs.filter((t) => t.key !== key)
    setTabs(remaining)
    if (state.activeTabKey === key) {
      const remainingInLeaf = leaf
        ? leaf.tabKeys.filter((k) => k !== key)
        : remaining.map((t) => t.key)
      const nextKey =
        remainingInLeaf[remainingInLeaf.length - 1] ?? remaining[remaining.length - 1]?.key ?? ""
      setActiveTabKey(nextKey)
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
    handleSplitRight,
    handleSplitDown,
    handleTabClose,
    handleCloseAllTabs,
  }
}
