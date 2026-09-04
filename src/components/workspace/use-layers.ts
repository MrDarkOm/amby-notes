import * as React from "react"
import i18n from "@/lib/i18n"
import { useViewStateStore, type EditorLayer } from "./use-view-state-store"
import type { Document } from "./use-doc-store"
import type { TreeItem } from "./sidebar-tree"
import type { FsMutationResult, LayerKind } from "@/lib/storage"
import { confirmAction, createLayer, unlinkLayer, deleteLayer, noteLayers } from "@/lib/storage"

interface UseLayersParams {
  vault: string | null
  /** Database module state controls database-specific entry points. */
  databasesEnabled: boolean
  currentDoc: Document | null
  treeItems: TreeItem[]
  refreshTree: (path?: string | null) => Promise<TreeItem[]>
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
  currentDoc,
  treeItems,
  refreshTree,
  applyMutationResult,
}: UseLayersParams) {
  const t = i18n.t.bind(i18n)
  const activeLayers = useViewStateStore((s) => s.activeLayers)
  const linkedLayersByDoc = useViewStateStore((s) => s.linkedLayersByDoc)
  const { setActiveLayer, setLinkedLayers } = useViewStateStore.getState()

  async function refreshLinkedLayers(docId: string, notePath: string) {
    try {
      const layers = await noteLayers(notePath)
      setLinkedLayers(docId, layers)
    } catch (err) {
      console.error("Failed to load note layers:", err)
    }
  }

  const handleLayerChange = async (layer: EditorLayer) => {
    const doc = currentDoc
    if (!doc) return
    // DB-10 owns the new creator. Until then, never route this legacy writer
    // through createLayer, even if a stale UI event reaches this hook.
    if (layer === "database") return
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
    async (fileId: string, layer: "canvas" | "database") => {
      if (layer === "database") return
      // Find the file path from the flat tree
      function findPath(items: TreeItem[]): string | null {
        for (const item of items) {
          if (item.id === fileId && item.type === "file") return item.path
          if (item.children) {
            const found = findPath(item.children)
            if (found) return found
          }
        }
        return null
      }
      const filePath = findPath(treeItems)
      if (!filePath) return
      try {
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [databasesEnabled, treeItems, vault],
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
  }
}
