import { errorType, logger } from "@/lib/logger"
import type { ManualTreeOrder, TreeSortDirection, TreeSortKey } from "../tree-sort"

export const TREE_SORT_STORAGE_KEY = "amby:tree-sort"
export const TREE_ORDER_STORAGE_PREFIX = "amby:tree-order:"

let saveFailureLogged = false

/**
 * The sort and the manual order of the tree are conveniences of this window: a storage that
 * refuses a write (a full quota, blocked site data) must not break the tree. One line in the log
 * tells it, not one per change.
 */
function writeLocal(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch (error) {
    if (saveFailureLogged) return
    saveFailureLogged = true
    logger.warn("tree.view_state_save_failed", { errorType: errorType(error) })
  }
}

export function writeTreeSortSelection(key: TreeSortKey, direction: TreeSortDirection): void {
  writeLocal(TREE_SORT_STORAGE_KEY, { key, direction })
}

export function writeManualTreeOrder(vault: string, order: ManualTreeOrder): void {
  writeLocal(`${TREE_ORDER_STORAGE_PREFIX}${vault}`, order)
}

/** For tests: the failure is logged once per page, so each test starts again. */
export function resetTreeViewStorageLog(): void {
  saveFailureLogged = false
}
