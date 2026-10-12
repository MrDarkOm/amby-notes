import * as React from "react"
import type { TreeItem } from "../tree/tree-types"
import { applyCreativeTree } from "./creative-tree-model"
import { useCreativeSettingsStore } from "./creative-settings-store"
import { useProjectStore } from "./project-store"

/**
 * The file tree with the creative folders marked, or hidden when the setting is off. While
 * the module is off the vault's own tree comes back untouched: its folders are ordinary
 * folders with ordinary icons, whatever the project index or the setting still holds.
 */
export function useCreativeTreeItems(
  items: TreeItem[],
  vault: string | null,
  enabled: boolean,
): TreeItem[] {
  const catalog = useProjectStore((state) => state.catalog)
  const showInTree = useCreativeSettingsStore((state) => state.showInTree)
  return React.useMemo(
    () => (enabled ? applyCreativeTree(items, catalog, vault, showInTree) : items),
    [enabled, items, catalog, vault, showInTree],
  )
}
