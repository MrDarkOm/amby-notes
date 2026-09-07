import * as React from "react"
import i18n from "@/lib/i18n"
import { useViewStateStore, type EditorLayer } from "./use-view-state-store"
import type { Document } from "./use-doc-store"
import type { TreeItem } from "./sidebar-tree"
import type { FsMutationResult, LayerKind } from "@/lib/storage"
import {
  confirmAction,
  createDatabase,
  createLayer,
  unlinkLayer,
  deleteLayer,
  noteLayers,
} from "@/lib/storage"
import { useDatabaseStore } from "./database/database-store"

interface UseLayersParams {
  vault: string | null
  /** Database module state controls database-specific entry points. */
  databasesEnabled: boolean
  backendGeneration: number | null
  currentDoc: Document | null
  treeItems: TreeItem[]
  refreshTree: (path?: string | null) => Promise<TreeItem[]>
  refreshDatabaseCatalog?: () => Promise<void>
  onOpenDatabase?: (databaseId: string, title: string, inNewTab?: boolean) => void
  applyMutationResult: (result: FsMutationResult) => void
}

/**
 * Layer lifecycle for the active document: create/attach/unlink/delete a
 * canvas/database/sketch layer, refresh the cached layer-presence map, and
 * lazily load it for the current document.
 *
 * Reads activeLayers + setActiveLayer/setLinkedLayers from useViewStateStore.
 */
export function useLayers({
  vault,
  databasesEnabled,
  backendGeneration,
  currentDoc,
  treeItems,
  refreshTree,
  refreshDatabaseCatalog,
  onOpenDatabase,
  applyMutationResult,
}: UseLayersParams) {
  const t = i18n.t.bind(i18n)
  const activeLayers = useViewStateStore((s) => s.activeLayers)
  const linkedLayersByDoc = useViewStateStore((s) => s.linkedLayersByDoc)
  const { setActiveLayer, setLinkedLayers } = useViewStateStore.getState()

  const refreshLinkedLayers = React.useCallback(
    async (docId: string, notePath: string) => {
      try {
        const layers = await noteLayers(notePath)
        setLinkedLayers(docId, layers)
      } catch (err) {
        console.error("Failed to load note layers:", err)
      }
    },
    [setLinkedLayers],
  )

  const applyDatabasePathChange = React.useCallback(
    (oldPath: string, newPath: string) => {
      if (oldPath === newPath) return
      applyMutationResult({
        primaryPath: newPath,
        pathChanges: [{ oldPath, newPath }],
        deletedPaths: [],
      })
    },
    [applyMutationResult],
  )

  const createAttachedDatabase = React.useCallback(
    async (noteId: string, notePath: string, title: string) => {
      if (!vault || !databasesEnabled || backendGeneration === null) return
      const created = await createDatabase({
        expectedGeneration: backendGeneration,
        mode: "attached",
        notePath,
        name: title.replace(/\.md$/iu, "") || title,
      })
      const nextNotePath = created.notePath ?? notePath
      applyDatabasePathChange(notePath, nextNotePath)
      await refreshTree()
      await refreshDatabaseCatalog?.()
      await refreshLinkedLayers(noteId, nextNotePath)
      setActiveLayer(noteId, "database")
    },
    [
      applyDatabasePathChange,
      backendGeneration,
      databasesEnabled,
      refreshDatabaseCatalog,
      refreshLinkedLayers,
      refreshTree,
      setActiveLayer,
      vault,
    ],
  )

  const handleLayerChange = async (layer: EditorLayer) => {
    const doc = currentDoc
    if (!doc) return
    if (layer === "database") {
      try {
        const findAttached = () =>
          useDatabaseStore
            .getState()
            .databases.find((database) => database.attachedNoteId === doc.id)
        if (findAttached()) {
          setActiveLayer(doc.id, "database")
          return
        }
        if (linkedLayersByDoc[doc.id]?.database) {
          await refreshDatabaseCatalog?.()
          if (findAttached()) {
            setActiveLayer(doc.id, "database")
            return
          }
        }
        await createAttachedDatabase(doc.id, doc.path, doc.title)
      } catch (err) {
        console.error("Failed to create database layer:", err)
      }
      return
    }
    if (layer === "editor") {
      setActiveLayer(doc.id, "editor")
      return
    }
    try {
      const result = await createLayer(doc.path, layer)
      applyMutationResult({
        primaryPath: result.notePath,
        pathChanges: result.pathChanges,
        deletedPaths: [],
      })
      await refreshTree()
      setActiveLayer(doc.id, layer)
      await refreshLinkedLayers(doc.id, result.notePath ?? doc.path)
    } catch (err) {
      console.error("Failed to create layer:", err)
    }
  }

  const handleAttachLayerToFile = React.useCallback(
    async (fileId: string, layer: "canvas" | "database" | "sketch") => {
      function findFile(items: TreeItem[]): TreeItem | null {
        for (const item of items) {
          if (item.id === fileId && item.type === "file") return item
          if (item.children) {
            const found = findFile(item.children)
            if (found) return found
          }
        }
        return null
      }
      const item = findFile(treeItems)
      if (!item) return
      try {
        if (layer === "database") {
          await createAttachedDatabase(fileId, item.path, item.name)
          return
        }
        const filePath = item.path
        const result = await createLayer(filePath, layer)
        applyMutationResult({
          primaryPath: result.notePath,
          pathChanges: result.pathChanges,
          deletedPaths: [],
        })
        await refreshTree()
        await refreshLinkedLayers(fileId, result.notePath ?? filePath)
      } catch (err) {
        console.error("Failed to attach layer:", err)
      }
    },
    [applyMutationResult, createAttachedDatabase, refreshLinkedLayers, refreshTree, treeItems],
  )

  const handleNewDatabase = React.useCallback(
    async (parentId: string | null, name: string) => {
      if (!vault || !databasesEnabled || backendGeneration === null) return
      const parent = parentId ? findFileOrFolder(treeItems, parentId) : null
      const created = await createDatabase({
        expectedGeneration: backendGeneration,
        mode: "standalone",
        parentPath: parent?.path ?? vault,
        name,
      })
      await refreshTree()
      await refreshDatabaseCatalog?.()
      onOpenDatabase?.(created.databaseId, created.title)
    },
    [
      backendGeneration,
      databasesEnabled,
      onOpenDatabase,
      refreshDatabaseCatalog,
      refreshTree,
      treeItems,
      vault,
    ],
  )

  const handleUnlinkLayer = async (layer: LayerKind) => {
    if (!currentDoc || !vault) return
    if (layer === "database") return
    try {
      const result = await unlinkLayer(vault, currentDoc.path, layer)
      applyMutationResult(result)
      await refreshTree()
      await refreshLinkedLayers(currentDoc.id, result.primaryPath ?? currentDoc.path)
      // If the unlinked layer was active, fall back to the editor.
      if (activeLayers[currentDoc.id] === layer) setActiveLayer(currentDoc.id, "editor")
    } catch (err) {
      console.error("Failed to unlink layer:", err)
    }
  }

  const handleDeleteLayer = async (layer: LayerKind) => {
    if (!currentDoc || !vault) return
    if (layer === "database") return
    if (
      !(await confirmAction(
        t("workspace.deleteLayerConfirm", { layer: t(`layer.${layer}`), title: currentDoc.title }),
      ))
    )
      return
    try {
      const result = await deleteLayer(vault, currentDoc.path, layer)
      applyMutationResult(result)
      await refreshTree()
      await refreshLinkedLayers(currentDoc.id, result.primaryPath ?? currentDoc.path)
      if (activeLayers[currentDoc.id] === layer) setActiveLayer(currentDoc.id, "editor")
    } catch (err) {
      console.error("Failed to delete layer:", err)
    }
  }

  // Load the cached layer-presence map for a document the first time it opens.
  React.useEffect(() => {
    if (!currentDoc) return
    if (linkedLayersByDoc[currentDoc.id]) return
    refreshLinkedLayers(currentDoc.id, currentDoc.path)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentDoc?.id, currentDoc?.path])

  React.useEffect(() => {
    if (!currentDoc || databasesEnabled) return
    if (activeLayers[currentDoc.id] === "database") setActiveLayer(currentDoc.id, "editor")
  }, [activeLayers, currentDoc, databasesEnabled, setActiveLayer])

  return {
    refreshLinkedLayers,
    handleLayerChange,
    handleAttachLayerToFile,
    handleUnlinkLayer,
    handleDeleteLayer,
    handleNewDatabase,
  }
}

function findFileOrFolder(items: TreeItem[], id: string): TreeItem | null {
  for (const item of items) {
    if (item.id === id) return item
    if (item.children) {
      const found = findFileOrFolder(item.children, id)
      if (found) return found
    }
  }
  return null
}
