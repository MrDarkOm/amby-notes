import * as React from "react"

/** The window event the archive dispatches when a note goes there or comes back from there. */
const ARCHIVE_CHANGED_EVENT = "amby:archive-changed"

interface ArchiveChangedDetail {
  /** The files the change touched; the tree refreshes just those. */
  paths?: string[]
  /** The caller already applied the change to the tree (a mutation result with its patch). */
  treeUpdated?: boolean
}

/** Tell the archive panel and the sidebar tree that the archive changed. */
export function dispatchArchiveChanged(detail: ArchiveChangedDetail = {}): void {
  window.dispatchEvent(new CustomEvent<ArchiveChangedDetail>(ARCHIVE_CHANGED_EVENT, { detail }))
}

/**
 * Brings the sidebar tree up to date whenever the archive changed, so a note that came back shows
 * up at once instead of with the next file event. When the event names the files only those are
 * refreshed; a bare event reloads the whole tree.
 */
export function useRefreshTreeOnArchiveChange(
  refreshTree: () => unknown,
  refreshTreePaths: (paths: string[]) => unknown,
): void {
  React.useEffect(() => {
    const handle = (event: Event) => {
      const detail = (event as CustomEvent<ArchiveChangedDetail | undefined>).detail
      if (detail?.treeUpdated) return
      if (detail?.paths?.length) void refreshTreePaths(detail.paths)
      else void refreshTree()
    }
    window.addEventListener(ARCHIVE_CHANGED_EVENT, handle)
    return () => window.removeEventListener(ARCHIVE_CHANGED_EVENT, handle)
  }, [refreshTree, refreshTreePaths])
}
