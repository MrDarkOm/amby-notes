import * as React from "react"
import type { ProjectCatalog } from "@/lib/storage"
import type { TreeItem } from "../tree/tree-types"
import { collectionForFolder } from "./creative-tree-model"
import { useCreativeNavStore } from "./creative-nav-store"
import { writeStoredScope } from "./creative-scope-storage"

interface CollectionFolderSelectOptions {
  /** The module is on; while it is off every folder is an ordinary folder. */
  enabled: boolean
  vault: string | null
  catalog: ProjectCatalog | null
  /** Finds a tree item by its ID or path. */
  itemById: (id: string) => TreeItem | undefined
  /** What a selection does for everything that is not a collection's folder. */
  fallback: (id: string) => void
  /** Brings the module's sidebar panel to the front. */
  showPanel: () => void
  /** Opens the project's page in the main area. */
  openProject: (projectId: string) => void
}

/**
 * The selection handler of the tree. The folder of a universe or a collection does not open as
 * a folder: it opens the workshop with that collection chosen, in the sidebar and on its page.
 * Any other item, and every item while the module is off, goes to `fallback` unchanged.
 */
export function useCollectionFolderSelect({
  enabled,
  vault,
  catalog,
  itemById,
  fallback,
  showPanel,
  openProject,
}: CollectionFolderSelectOptions) {
  return React.useCallback(
    (id: string) => {
      const item = enabled ? itemById(id) : undefined
      const collection = item ? collectionForFolder(item, catalog, vault) : null
      if (!collection) {
        fallback(id)
        return
      }
      useCreativeNavStore.getState().setScope(collection.workshopId)
      if (vault) writeStoredScope(vault, collection.workshopId)
      showPanel()
      openProject(collection.workshopId)
    },
    [catalog, enabled, fallback, itemById, openProject, showPanel, vault],
  )
}
