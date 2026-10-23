import * as React from "react"

/** The window event the archive dispatches when a note goes there or comes back from there. */
const ARCHIVE_CHANGED_EVENT = "amby:archive-changed"

/**
 * Rebuilds the sidebar tree through `refreshTree` whenever the archive changed, so a note that came
 * back shows up at once instead of with the next file event. It uses the tree's own refresh, not a
 * copy of the tree.
 */
export function useRefreshTreeOnArchiveChange(refreshTree: () => unknown): void {
  React.useEffect(() => {
    const handle = () => void refreshTree()
    window.addEventListener(ARCHIVE_CHANGED_EVENT, handle)
    return () => window.removeEventListener(ARCHIVE_CHANGED_EVENT, handle)
  }, [refreshTree])
}
