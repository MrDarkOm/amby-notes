import { findPaneLeafByTabKey } from "../split-tree"
import { useTabsStore } from "../use-tabs-store"

/**
 * Shows the tab an open note already has, found by the id of the note: the file tree is not asked, so it works
 * for a note whose file is gone. Returns false when the note has no tab.
 */
export function activateNoteTab(fileId: string): boolean {
  const { tabs, rootPane, selectTabInPane } = useTabsStore.getState()
  const tab = tabs.find((candidate) => candidate.kind === "document" && candidate.fileId === fileId)
  if (!tab) return false
  const leaf = findPaneLeafByTabKey(rootPane, tab.key)
  if (!leaf) return false
  selectTabInPane(leaf.id, tab.key)
  return true
}
