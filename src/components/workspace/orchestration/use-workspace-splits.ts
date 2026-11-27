import type { LayoutLeafItem, LayoutSplitDivider, SplitDirection } from "../split-tree"
import type { Document } from "../use-doc-store"
import { type ActivePaneHoverTarget, usePaneDnd, zoneToSplitParams } from "../pane-dnd"
import { useTabsStore } from "../use-tabs-store"
import { findTabTreeItem, treeItemTabTarget } from "../tab-target"
import { flushEditorSerializations } from "../tiptap/editor-serialization-lifecycle"
import * as React from "react"
import type { TreeItem } from "../sidebar-tree"

interface UseWorkspaceSplitsParams {
  displayTreeItems: TreeItem[]
  vault: string | null
  loadDoc: (fileId: string, itemName: string) => Promise<Document>
  handleTabUsageChanged: () => void
  splitLayout: { leaves: LayoutLeafItem[]; dividers: LayoutSplitDivider[] }
  handleOpenInNewTab: (fileId: string) => Promise<void>
  handleTreeSelect: (id: string) => void
}

export function useWorkspaceSplits({
  displayTreeItems,
  vault,
  loadDoc,
  handleTabUsageChanged,
  splitLayout,
  handleOpenInNewTab,
  handleTreeSelect,
}: UseWorkspaceSplitsParams) {
  const openTreeItemInSplit = React.useCallback(
    async (
      fileId: string,
      direction: SplitDirection,
      options?: { paneId?: string; placement?: "before" | "after" },
    ) => {
      flushEditorSerializations()
      const item = findTabTreeItem(displayTreeItems, fileId, vault)
      if (!item) return
      const target = treeItemTabTarget(item)
      try {
        if (item.type === "file") {
          await loadDoc(item.id, target.title)
        } else if (item.type === "canvas" || item.type === "sketch" || item.type === "database") {
          await loadDoc(target.fileId, target.title)
        }
      } catch {
        /* best effort */
      }
      useTabsStore.getState().splitPane(direction, {
        paneId: options?.paneId,
        target,
        placement: options?.placement,
      })
      handleTabUsageChanged()
    },
    [displayTreeItems, handleTabUsageChanged, loadDoc, vault],
  )

  const handleOpenSplitRight = React.useCallback(
    (fileId: string) => {
      void openTreeItemInSplit(fileId, "horizontal", { placement: "after" })
    },
    [openTreeItemInSplit],
  )

  const handleOpenSplitDown = React.useCallback(
    (fileId: string) => {
      void openTreeItemInSplit(fileId, "vertical", { placement: "after" })
    },
    [openTreeItemInSplit],
  )

  const handleDropTab = React.useCallback(
    (tabKey: string, sourcePaneId: string, target: ActivePaneHoverTarget) => {
      flushEditorSerializations()
      if (target.zone === "tabbar" || target.zone === "center") {
        useTabsStore.getState().moveTabToPane(tabKey, target.paneId, target.tabIndex)
        handleTabUsageChanged()
        return
      }
      const { direction, placement } = zoneToSplitParams(target.zone)
      const sourceLeaf = splitLayout.leaves.find((l) => l.leaf.id === sourcePaneId)
      const moveTab = (sourceLeaf?.leaf.tabKeys.length ?? 0) > 1
      useTabsStore.getState().splitPane(direction, {
        paneId: target.paneId,
        tabKey,
        placement,
        moveTab,
      })
      handleTabUsageChanged()
    },
    [handleTabUsageChanged, splitLayout.leaves],
  )

  const handleDropTreeItem = React.useCallback(
    (itemId: string, target: ActivePaneHoverTarget) => {
      flushEditorSerializations()
      if (target.zone === "tabbar") {
        useTabsStore.getState().focusPane(target.paneId)
        void handleOpenInNewTab(itemId)
        return
      }
      if (target.zone === "center") {
        useTabsStore.getState().focusPane(target.paneId)
        handleTreeSelect(itemId)
        return
      }
      const { direction, placement } = zoneToSplitParams(target.zone)
      void openTreeItemInSplit(itemId, direction, {
        paneId: target.paneId,
        placement,
      })
    },
    [handleOpenInNewTab, handleTreeSelect, openTreeItemInSplit],
  )

  const paneDnd = usePaneDnd({
    onDropTab: handleDropTab,
    onDropTreeItem: handleDropTreeItem,
  })
  return { handleOpenSplitRight, handleOpenSplitDown, paneDnd }
}
